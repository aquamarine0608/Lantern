package com.aquamarine0608.lantern

import com.aquamarine0608.lantern.runtime.QwenCancellationSignal
import kotlinx.coroutines.CompletableJob
import kotlinx.coroutines.Job
import java.util.concurrent.atomic.AtomicBoolean

internal sealed interface SynthesisAdmission {
    data class Accepted(val lease: NativeSynthesisLease) : SynthesisAdmission
    data object Busy : SynthesisAdmission
    data object Cancelled : SynthesisAdmission
    data object Closed : SynthesisAdmission
    data object Duplicate : SynthesisAdmission
    data object Invalid : SynthesisAdmission
}

/** A request-scoped cancellation signal shared by the HTTP worker and JNI callback. */
internal class NativeSynthesisLease internal constructor(
    internal val ownerId: Long,
    val requestId: String,
) : QwenCancellationSignal {
    private val cancelled = AtomicBoolean(false)
    internal val cancellationParent: CompletableJob = Job()

    override fun isCancellationRequested(): Boolean = cancelled.get()

    internal fun cancel() {
        if (!cancelled.compareAndSet(false, true)) return
        cancellationParent.cancel()
    }

    internal fun complete() {
        cancellationParent.complete()
    }
}

/** Activity/WebView-scoped facade over the process-wide admission controller. */
internal class NativeSynthesisSession internal constructor(
    private val ownerId: Long,
    private val coordinator: NativeSynthesisCoordinator,
) : AutoCloseable {
    private val closed = AtomicBoolean(false)

    fun begin(requestId: String): SynthesisAdmission =
        coordinator.begin(ownerId, requestId)

    fun cancel(requestId: String): Boolean =
        coordinator.cancel(ownerId, requestId)

    fun complete(lease: NativeSynthesisLease) {
        coordinator.complete(lease)
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) coordinator.closeOwner(ownerId)
    }
}

/**
 * Process-wide, non-queuing admission controller for local synthesis.
 *
 * Exactly one WebView request can own JNI at a time, including across Activity
 * recreation. Per-session cancellation tombstones close the race where JavaScript
 * aborts before WebView dispatches the matching synthetic HTTP request.
 */
internal class NativeSynthesisCoordinator(
    private val maxRememberedRequestIds: Int = DEFAULT_MAX_REMEMBERED_REQUEST_IDS,
) {
    private data class RequestKey(val ownerId: Long, val requestId: String)

    private val lock = Any()
    private val recentRequestIds = LinkedHashSet<RequestKey>()
    private val cancelledBeforeStart = LinkedHashSet<RequestKey>()
    private val liveOwnerIds = HashSet<Long>()
    private var active: NativeSynthesisLease? = null
    private var nextOwnerId = 0L

    init {
        require(maxRememberedRequestIds > 0) { "maxRememberedRequestIds must be positive" }
    }

    fun openSession(): NativeSynthesisSession = synchronized(lock) {
        check(nextOwnerId != Long.MAX_VALUE) { "Native synthesis session ID space exhausted" }
        nextOwnerId += 1L
        liveOwnerIds.add(nextOwnerId)
        NativeSynthesisSession(nextOwnerId, this)
    }

    internal fun begin(ownerId: Long, requestId: String): SynthesisAdmission = synchronized(lock) {
        val key = RequestKey(ownerId, requestId)
        when {
            !liveOwnerIds.contains(ownerId) -> SynthesisAdmission.Closed
            !isValidRequestId(requestId) -> SynthesisAdmission.Invalid
            recentRequestIds.contains(key) -> SynthesisAdmission.Duplicate
            cancelledBeforeStart.remove(key) -> {
                remember(recentRequestIds, key)
                SynthesisAdmission.Cancelled
            }
            active != null -> SynthesisAdmission.Busy
            else -> {
                remember(recentRequestIds, key)
                val lease = NativeSynthesisLease(ownerId, requestId)
                active = lease
                SynthesisAdmission.Accepted(lease)
            }
        }
    }

    /** Returns true when this call newly signalled or tombstoned the request. */
    internal fun cancel(ownerId: Long, requestId: String): Boolean {
        if (!isValidRequestId(requestId)) return false
        val key = RequestKey(ownerId, requestId)
        var lease: NativeSynthesisLease? = null
        val accepted = synchronized(lock) {
            if (!liveOwnerIds.contains(ownerId)) return@synchronized false
            val current = active
            if (current?.ownerId == ownerId && current.requestId == requestId) {
                lease = current
                true
            } else if (recentRequestIds.contains(key)) {
                false
            } else {
                val added = cancelledBeforeStart.add(key)
                trim(cancelledBeforeStart)
                added
            }
        }
        lease?.cancel()
        return accepted
    }

    internal fun complete(lease: NativeSynthesisLease) {
        synchronized(lock) {
            if (active === lease) active = null
        }
        lease.complete()
    }

    internal fun closeOwner(ownerId: Long) {
        val lease = synchronized(lock) {
            liveOwnerIds.remove(ownerId)
            cancelledBeforeStart.removeAll { it.ownerId == ownerId }
            active?.takeIf { it.ownerId == ownerId }
        }
        // Keep the lease admitted until its endpoint finally unwinds. Other
        // Activities are rejected instead of queueing behind non-returned JNI.
        lease?.cancel()
    }

    private fun remember(target: LinkedHashSet<RequestKey>, requestId: RequestKey) {
        target.add(requestId)
        trim(target)
    }

    private fun trim(target: LinkedHashSet<RequestKey>) {
        while (target.size > maxRememberedRequestIds) {
            val iterator = target.iterator()
            if (!iterator.hasNext()) return
            iterator.next()
            iterator.remove()
        }
    }

    companion object {
        const val MAX_REQUEST_ID_CHARS = 128
        private const val DEFAULT_MAX_REMEMBERED_REQUEST_IDS = 512
        private val REQUEST_ID_PATTERN = Regex("^[A-Za-z0-9._:-]+$")

        fun isValidRequestId(value: String): Boolean =
            value.isNotEmpty() &&
                value.length <= MAX_REQUEST_ID_CHARS &&
                REQUEST_ID_PATTERN.matches(value)
    }
}
