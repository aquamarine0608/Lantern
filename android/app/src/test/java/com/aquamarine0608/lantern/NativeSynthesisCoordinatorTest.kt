package com.aquamarine0608.lantern

import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors

class NativeSynthesisCoordinatorTest {
    @Test
    fun cancelBeforeBeginPreventsTheRequestFromEnteringTheRuntime() {
        val coordinator = NativeSynthesisCoordinator()
        val session = coordinator.openSession()

        assertTrue(session.cancel("speech-before-start"))
        assertSame(SynthesisAdmission.Cancelled, session.begin("speech-before-start"))
    }

    @Test
    fun admitsOnlyOneRequestAndCancellationReachesItsLease() {
        val coordinator = NativeSynthesisCoordinator()
        val session = coordinator.openSession()
        val accepted = session.begin("speech-active") as SynthesisAdmission.Accepted

        assertSame(SynthesisAdmission.Busy, session.begin("speech-second"))
        assertTrue(session.cancel("speech-active"))
        assertTrue(accepted.lease.isCancellationRequested())
        session.complete(accepted.lease)

        assertTrue(session.begin("speech-after") is SynthesisAdmission.Accepted)
    }

    @Test
    fun closeCancelsTheActiveLeaseAndRejectsFutureWork() {
        val coordinator = NativeSynthesisCoordinator()
        val session = coordinator.openSession()
        val accepted = session.begin("speech-active") as SynthesisAdmission.Accepted

        session.close()

        assertTrue(accepted.lease.isCancellationRequested())
        assertSame(SynthesisAdmission.Closed, session.begin("speech-later"))
        assertFalse(session.cancel("speech-later"))
    }

    @Test
    fun duplicateAndMalformedIdsFailClosed() {
        val coordinator = NativeSynthesisCoordinator()
        val session = coordinator.openSession()
        val accepted = session.begin("speech-1") as SynthesisAdmission.Accepted
        session.complete(accepted.lease)

        assertSame(SynthesisAdmission.Duplicate, session.begin("speech-1"))
        assertSame(SynthesisAdmission.Invalid, session.begin("bad request id"))
        assertFalse(session.cancel("!"))
    }

    @Test
    fun cancellationTombstonesStayBounded() {
        val coordinator = NativeSynthesisCoordinator(maxRememberedRequestIds = 2)
        val session = coordinator.openSession()
        assertTrue(session.cancel("speech-1"))
        assertTrue(session.cancel("speech-2"))
        assertTrue(session.cancel("speech-3"))

        // The oldest tombstone was evicted, while the two newest still fence dispatch.
        assertTrue(session.begin("speech-1") is SynthesisAdmission.Accepted)
        assertSame(SynthesisAdmission.Cancelled, session.begin("speech-2"))
        assertSame(SynthesisAdmission.Cancelled, session.begin("speech-3"))
    }

    @Test
    fun sessionsShareOneGlobalAdmissionAndClosingDoesNotReleaseJniEarly() {
        val coordinator = NativeSynthesisCoordinator()
        val first = coordinator.openSession()
        val second = coordinator.openSession()
        val accepted = first.begin("speech-first") as SynthesisAdmission.Accepted

        first.close()

        assertTrue(accepted.lease.isCancellationRequested())
        assertSame(SynthesisAdmission.Busy, second.begin("speech-second"))
        first.complete(accepted.lease)
        assertTrue(second.begin("speech-second") is SynthesisAdmission.Accepted)
    }

    @Test
    fun beginRacingCloseIsEitherRejectedOrImmediatelyCancelled() {
        val coordinator = NativeSynthesisCoordinator()
        val workers = Executors.newFixedThreadPool(2)
        try {
            repeat(200) { iteration ->
                val session = coordinator.openSession()
                val start = CountDownLatch(1)
                val begin = workers.submit<SynthesisAdmission> {
                    start.await()
                    session.begin("speech-race-$iteration")
                }
                val close = workers.submit {
                    start.await()
                    session.close()
                }
                start.countDown()
                val admission = begin.get()
                close.get()

                when (admission) {
                    is SynthesisAdmission.Accepted -> {
                        assertTrue(admission.lease.isCancellationRequested())
                        session.complete(admission.lease)
                    }
                    SynthesisAdmission.Closed -> Unit
                    else -> throw AssertionError("Unexpected race result: $admission")
                }
            }
        } finally {
            workers.shutdownNow()
        }
    }
}
