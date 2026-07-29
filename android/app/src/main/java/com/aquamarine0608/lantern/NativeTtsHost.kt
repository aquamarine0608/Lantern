package com.aquamarine0608.lantern

import android.annotation.SuppressLint
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import com.aquamarine0608.lantern.model.PinnedQwenModelManifest
import com.aquamarine0608.lantern.model.QwenInsufficientSpaceException
import com.aquamarine0608.lantern.model.QwenModelInstallException
import com.aquamarine0608.lantern.model.QwenModelInstaller
import com.aquamarine0608.lantern.runtime.QwenNativeRuntime
import com.aquamarine0608.lantern.runtime.QwenRuntimeException
import com.aquamarine0608.lantern.runtime.QwenRuntimeState
import com.aquamarine0608.lantern.runtime.QwenRuntimeStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicBoolean
import java.util.UUID

internal object LanternWebOrigins {
    const val APP_ASSET_HOST = "appassets.androidplatform.net"
    const val APP_ORIGIN = "https://$APP_ASSET_HOST"
    const val START_URL = "$APP_ORIGIN/assets/www/index.html"
    const val ASSET_PATH_PREFIX = "/assets/www/"

    fun isExactAppOrigin(uri: Uri): Boolean =
        uri.scheme == "https" &&
            uri.host == APP_ASSET_HOST &&
            uri.port == -1 &&
            uri.userInfo == null

    fun isAllowedAssetNavigation(uri: Uri): Boolean =
        isExactAppOrigin(uri) && uri.encodedPath?.startsWith(ASSET_PATH_PREFIX) == true
}

internal fun interface NativeMessageSink {
    fun post(message: String)
}

/** Posts WebMessage replies only on the UI thread and becomes inert after the activity closes. */
internal class MainThreadReplySink(
    private val replyProxy: JavaScriptReplyProxy,
    private val isHostClosed: AtomicBoolean,
) : NativeMessageSink {
    private val mainHandler = Handler(Looper.getMainLooper())

    @SuppressLint("RequiresFeature")
    override fun post(message: String) {
        if (isHostClosed.get()) return
        val deliver = Runnable {
            if (isHostClosed.get()) return@Runnable
            try {
                replyProxy.postMessage(message)
            } catch (error: RuntimeException) {
                Log.w(TAG, "WebMessage recipient is no longer available", error)
            }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) deliver.run() else mainHandler.post(deliver)
    }

    private companion object {
        const val TAG = "LanternNativeBridge"
    }
}

/** Main-frame, exact-origin WebMessage entry point. */
internal class NativeWebMessageBridge(
    installer: QwenModelInstaller,
    private val scope: CoroutineScope,
    private val runtime: QwenNativeRuntime,
    synthesisSession: NativeSynthesisSession,
    maintenanceMutex: Mutex,
) : WebViewCompat.WebMessageListener {
    private val closed = AtomicBoolean(false)
    private val router = NativeTtsCommandRouter(
        installer = installer,
        runtime = runtime,
        scope = scope,
        synthesisSession = synthesisSession,
        maintenanceMutex = maintenanceMutex,
    )
    private val recentRequestIds = LinkedHashSet<String>()

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        val sink = MainThreadReplySink(replyProxy, closed)
        if (closed.get()) return
        if (!isMainFrame || !LanternWebOrigins.isExactAppOrigin(sourceOrigin)) {
            sink.post(
                NativeTtsProtocol.errorReply(
                    NativeProtocolFailure("UNTRUSTED_SOURCE", "Native requests require Lantern's main app frame")
                )
            )
            return
        }
        if (message.type != WebMessageCompat.TYPE_STRING) {
            sink.post(
                NativeTtsProtocol.errorReply(
                    NativeProtocolFailure("MALFORMED_MESSAGE", "Native request must be a JSON string")
                )
            )
            return
        }

        when (val decoded = NativeTtsProtocol.decodeRequest(message.data)) {
            is NativeRequestDecodeResult.Invalid -> sink.post(NativeTtsProtocol.errorReply(decoded.failure))
            is NativeRequestDecodeResult.Valid -> {
                if (!rememberRequestId(decoded.request.requestId)) {
                    sink.post(
                        NativeTtsProtocol.errorReply(
                            NativeProtocolFailure(
                                code = "DUPLICATE_REQUEST_ID",
                                message = "Native request ID has already been used",
                                requestId = decoded.request.requestId,
                            )
                        )
                    )
                    return
                }
                router.route(decoded.request, sink)
            }
        }
    }

    fun close() {
        if (!closed.compareAndSet(false, true)) return
        router.close()
        recentRequestIds.clear()
    }

    private fun rememberRequestId(requestId: String): Boolean {
        if (!recentRequestIds.add(requestId)) return false
        if (recentRequestIds.size > MAX_RECENT_REQUEST_IDS) {
            val oldest = recentRequestIds.iterator()
            if (oldest.hasNext()) {
                oldest.next()
                oldest.remove()
            }
        }
        return true
    }

    private companion object {
        const val MAX_RECENT_REQUEST_IDS = 512
    }
}

/** Dispatches the small v1 control plane; audio never enters this router. */
internal class NativeTtsCommandRouter(
    private val installer: QwenModelInstaller,
    private val runtime: QwenNativeRuntime,
    private val scope: CoroutineScope,
    private val synthesisSession: NativeSynthesisSession,
    private val maintenanceMutex: Mutex,
) {
    private val installOwnerId = UUID.randomUUID().toString()

    @Volatile
    private var downloadJob: Job? = null

    @Volatile
    private var lastInstallFailure: NativeProtocolFailure? = null

    fun route(request: NativeTtsRequest, sink: NativeMessageSink) {
        if (request.method !in SESSION_PLAYBACK_METHODS && request.sessionId != null) {
            sink.error(request, "INVALID_SESSION_ID", "This native method does not accept a session ID")
            return
        }
        when (request.method) {
            "model.status" -> handleStatus(request, sink)
            "model.download" -> handleDownload(request, sink)
            "model.cancelDownload" -> handleCancelDownload(request, sink)
            "model.delete" -> handleDelete(request, sink)
            "tts.prepare" -> handlePrepare(request, sink)
            "tts.setVoice" -> handleSetVoice(request, sink)
            "tts.setSpeed" -> handleSetSpeed(request, sink)
            "tts.cancelSynthesis" -> handleCancelSynthesis(request, sink)
            in SESSION_PLAYBACK_METHODS -> sink.error(
                request,
                "UNSUPPORTED_METHOD",
                "Native playback sessions are unavailable; request WAV audio from /native/v1/audio/speech",
            )
            else -> sink.error(request, "UNKNOWN_METHOD", "Unknown native TTS method")
        }
    }

    fun close() {
        synthesisSession.close()
        installer.cancelCurrentInstall(installOwnerId)
        downloadJob?.cancel()
        downloadJob = null
    }

    private fun handleStatus(request: NativeTtsRequest, sink: NativeMessageSink) {
        if (!request.requireEmptyParams(sink)) return
        scope.launch {
            try {
                val runtimeStatus = runtime.status()
                val installedModel = if (runtimeStatus.state == QwenRuntimeState.NOT_INSTALLED) {
                    installer.currentModel()
                } else {
                    null
                }
                val statusAndInstalled = when {
                    downloadJob?.isActive == true -> QwenRuntimeStatus(
                        state = QwenRuntimeState.DOWNLOADING,
                        detail = "Downloading and verifying the pinned local Qwen model",
                        modelRevision = PinnedQwenModelManifest.REVISION,
                    ) to false
                    runtimeStatus.state != QwenRuntimeState.NOT_INSTALLED -> runtimeStatus to true
                    else -> {
                        when {
                            installedModel != null -> QwenRuntimeStatus(
                                state = QwenRuntimeState.READY,
                                detail = "Local Qwen is installed and will load before speech",
                                modelRevision = installedModel.manifest.revision,
                            ) to true
                            lastInstallFailure != null -> QwenRuntimeStatus(
                                state = QwenRuntimeState.FAILED,
                                detail = lastInstallFailure?.message,
                                modelRevision = PinnedQwenModelManifest.REVISION,
                            ) to false
                            else -> QwenRuntimeStatus(QwenRuntimeState.NOT_INSTALLED) to false
                        }
                    }
                }
                sink.success(
                    request,
                    statusAndInstalled.first.toJson(installed = statusAndInstalled.second),
                )
            } catch (error: Throwable) {
                sink.operationError(request, error, "Could not read local Qwen model status")
            }
        }
    }

    private fun handleDownload(request: NativeTtsRequest, sink: NativeMessageSink) {
        if (!request.requireParams(setOf("revision"), sink)) return
        val revision = request.params.optionalString("revision")
        if (revision is JsonField.Invalid) {
            sink.error(request, "INVALID_PARAMS", "revision must be a string")
            return
        }
        val requestedRevision = (revision as? JsonField.Present)?.value
        if (requestedRevision != null && requestedRevision != PinnedQwenModelManifest.REVISION) {
            sink.error(request, "MODEL_REVISION_UNSUPPORTED", "Only Lantern's pinned Qwen revision is supported")
            return
        }
        if (downloadJob?.isActive == true) {
            sink.success(request, JSONObject().put("accepted", false).put("inProgress", true))
            return
        }

        lastInstallFailure = null
        lateinit var newJob: Job
        newJob = scope.launch(start = CoroutineStart.LAZY) {
            try {
                maintenanceMutex.withLock {
                    var lastReportedBytes = Long.MIN_VALUE
                    val model = installer.install(ownerId = installOwnerId) { progress ->
                        val isBoundary = progress.fileBytesDownloaded == progress.fileTotalBytes ||
                            progress.totalBytesDownloaded == progress.totalBytes
                        val advancedEnough = lastReportedBytes == Long.MIN_VALUE ||
                            progress.totalBytesDownloaded - lastReportedBytes >= PROGRESS_STEP_BYTES
                        if (!isBoundary && !advancedEnough) return@install
                        lastReportedBytes = progress.totalBytesDownloaded
                        sink.post(
                            NativeTtsProtocol.event(
                                requestId = request.requestId,
                                name = "model.progress",
                                payload = JSONObject()
                                    .put("loaded", progress.totalBytesDownloaded)
                                    .put("total", progress.totalBytes)
                                    .put("file", progress.fileName),
                            )
                        )
                    }
                    val status = runtime.status()
                    if (status.state != QwenRuntimeState.READY || status.modelRevision != model.manifest.revision) {
                        runtime.load(model)
                    }
                    sink.post(
                        NativeTtsProtocol.event(
                            requestId = request.requestId,
                            name = "model.ready",
                            payload = JSONObject().put("modelRevision", model.manifest.revision),
                        )
                    )
                }
            } catch (_: CancellationException) {
                // Explicit cancellation preserves the resumable partial and fences events in JavaScript.
            } catch (error: Throwable) {
                val failure = error.toProtocolFailure("Local Qwen model installation failed")
                lastInstallFailure = failure
                sink.post(
                    NativeTtsProtocol.event(
                        requestId = request.requestId,
                        name = "error",
                        payload = JSONObject().put("code", failure.code).put("message", failure.message),
                    )
                )
                Log.e(TAG, "Qwen model install/load failed", error)
            } finally {
                if (downloadJob === newJob) downloadJob = null
            }
        }
        downloadJob = newJob
        sink.success(
            request,
            JSONObject()
                .put("accepted", true)
                .put("modelRevision", PinnedQwenModelManifest.REVISION)
                .put("totalBytes", PinnedQwenModelManifest.value.expectedInstalledBytes),
        )
        newJob.start()
    }

    private fun handleCancelDownload(request: NativeTtsRequest, sink: NativeMessageSink) {
        if (!request.requireEmptyParams(sink)) return
        val job = downloadJob
        val signalled = installer.cancelCurrentInstall(installOwnerId)
        val active = job?.isActive == true
        job?.cancel()
        lastInstallFailure = null
        sink.success(request, JSONObject().put("cancelled", signalled || active))
    }

    private fun handleDelete(request: NativeTtsRequest, sink: NativeMessageSink) {
        if (!request.requireEmptyParams(sink)) return
        if (downloadJob?.isActive == true) {
            sink.error(request, "DOWNLOAD_IN_PROGRESS", "Cancel the model download before deleting it")
            return
        }
        scope.launch {
            try {
                val removed = maintenanceMutex.withLock {
                    runtime.unload()
                    installer.deleteInstalledModels()
                }
                lastInstallFailure = null
                sink.success(
                    request,
                    JSONObject().put("removed", removed).put("state", QwenRuntimeState.NOT_INSTALLED.wireValue),
                )
            } catch (error: Throwable) {
                sink.operationError(request, error, "Could not delete the local Qwen model")
            }
        }
    }

    private fun handlePrepare(request: NativeTtsRequest, sink: NativeMessageSink) {
        if (!request.requireParams(setOf("modelRevision"), sink)) return
        val revision = request.params.optionalString("modelRevision")
        if (revision is JsonField.Invalid) {
            sink.error(request, "INVALID_PARAMS", "modelRevision must be a string")
            return
        }
        val requestedRevision = (revision as? JsonField.Present)?.value
        if (requestedRevision != null && requestedRevision != PinnedQwenModelManifest.REVISION) {
            sink.error(request, "MODEL_REVISION_UNSUPPORTED", "Only Lantern's pinned Qwen revision is supported")
            return
        }
        if (downloadJob?.isActive == true) {
            sink.error(request, "MODEL_DOWNLOADING", "The local Qwen model is still downloading")
            return
        }
        scope.launch {
            try {
                val status = maintenanceMutex.withLock {
                    val current = runtime.status()
                    if (current.state == QwenRuntimeState.READY &&
                        current.modelRevision == PinnedQwenModelManifest.REVISION
                    ) {
                        current
                    } else {
                        val model = installer.currentModel()
                            ?: throw QwenRuntimeException(
                                "MODEL_NOT_INSTALLED",
                                "Download the local Qwen model before preparing speech",
                            )
                        runtime.load(model)
                    }
                }
                lastInstallFailure = null
                sink.success(request, status.toJson(installed = true))
            } catch (error: Throwable) {
                sink.operationError(request, error, "Could not prepare the local Qwen model")
            }
        }
    }

    private fun handleSetVoice(request: NativeTtsRequest, sink: NativeMessageSink) {
        if (!request.requireParams(setOf("voice"), sink)) return
        val voice = request.params.opt("voice") as? String
        if (voice == null || voice.isBlank() || voice.length > 80 || voice.any(Char::isISOControl)) {
            sink.error(request, "INVALID_PARAMS", "voice must be a non-blank string of at most 80 characters")
            return
        }
        sink.success(request, JSONObject().put("accepted", true))
    }

    private fun handleSetSpeed(request: NativeTtsRequest, sink: NativeMessageSink) {
        if (!request.requireParams(setOf("speed"), sink)) return
        val value = request.params.opt("speed")
        val speed = (value as? Number)?.toDouble()
        if (speed == null || !speed.isFinite() ||
            speed !in NativeSpeechRequestParser.MIN_SPEED..NativeSpeechRequestParser.MAX_SPEED
        ) {
            sink.error(
                request,
                "INVALID_PARAMS",
                "speed must be between ${NativeSpeechRequestParser.MIN_SPEED} and ${NativeSpeechRequestParser.MAX_SPEED}",
            )
            return
        }
        sink.success(request, JSONObject().put("accepted", true).put("speed", speed))
    }

    private fun handleCancelSynthesis(request: NativeTtsRequest, sink: NativeMessageSink) {
        if (!request.requireParams(setOf("synthesisRequestId"), sink)) return
        val synthesisRequestId = request.params.opt("synthesisRequestId") as? String
        if (synthesisRequestId == null ||
            !NativeSynthesisCoordinator.isValidRequestId(synthesisRequestId)
        ) {
            sink.error(
                request,
                "INVALID_PARAMS",
                "synthesisRequestId must be a valid local speech request ID",
            )
            return
        }
        sink.success(
            request,
            JSONObject().put("cancelled", synthesisSession.cancel(synthesisRequestId)),
        )
    }

    private fun NativeTtsRequest.requireEmptyParams(sink: NativeMessageSink): Boolean =
        requireParams(emptySet(), sink)

    private fun NativeTtsRequest.requireParams(allowed: Set<String>, sink: NativeMessageSink): Boolean {
        val failure = NativeTtsProtocol.requireOnlyParams(params, allowed) ?: return true
        sink.post(NativeTtsProtocol.errorReply(failure.copy(requestId = requestId)))
        return false
    }

    private fun QwenRuntimeStatus.toJson(installed: Boolean): JSONObject = JSONObject()
        .put("state", state.wireValue)
        .put("detail", detail ?: JSONObject.NULL)
        .put("modelRevision", modelRevision ?: JSONObject.NULL)
        .put("installed", installed)

    private fun NativeMessageSink.success(request: NativeTtsRequest, result: JSONObject) {
        post(NativeTtsProtocol.successReply(request.requestId, result))
    }

    private fun NativeMessageSink.error(request: NativeTtsRequest, code: String, message: String) {
        post(NativeTtsProtocol.errorReply(NativeProtocolFailure(code, message, request.requestId)))
    }

    private fun NativeMessageSink.operationError(request: NativeTtsRequest, error: Throwable, fallback: String) {
        val failure = error.toProtocolFailure(fallback).copy(requestId = request.requestId)
        post(NativeTtsProtocol.errorReply(failure))
        if (error !is CancellationException) Log.e(TAG, fallback, error)
    }

    private fun Throwable.toProtocolFailure(fallback: String): NativeProtocolFailure = when (this) {
        is QwenRuntimeException -> NativeProtocolFailure(code, safeMessage(message, fallback))
        is QwenInsufficientSpaceException -> NativeProtocolFailure(
            "INSUFFICIENT_STORAGE",
            "The model needs $requiredBytes free bytes; only $availableBytes are available",
        )
        is QwenModelInstallException -> NativeProtocolFailure("MODEL_INSTALL_FAILED", safeMessage(message, fallback))
        is CancellationException -> NativeProtocolFailure("CANCELLED", "The native operation was cancelled")
        is IllegalArgumentException -> NativeProtocolFailure("INVALID_PARAMS", safeMessage(message, "Invalid native request"))
        is IllegalStateException -> NativeProtocolFailure("CONFLICT", safeMessage(message, fallback))
        is OutOfMemoryError -> NativeProtocolFailure("MODEL_OUT_OF_MEMORY", "The device does not have enough memory for local Qwen")
        else -> NativeProtocolFailure("INTERNAL_ERROR", fallback)
    }

    private fun safeMessage(message: String?, fallback: String): String = message
        ?.replace(Regex("[\\r\\n\\t]+"), " ")
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?.take(500)
        ?: fallback

    private sealed interface JsonField {
        data object Missing : JsonField
        data object Invalid : JsonField
        data class Present(val value: String) : JsonField
    }

    private fun JSONObject.optionalString(name: String): JsonField {
        if (!has(name)) return JsonField.Missing
        val value = opt(name)
        return if (value is String && value.isNotBlank() && value.length <= 128 && value.none(Char::isISOControl)) {
            JsonField.Present(value)
        } else {
            JsonField.Invalid
        }
    }

    private companion object {
        const val TAG = "LanternNativeTTS"
        const val PROGRESS_STEP_BYTES = 2L * 1024L * 1024L
        val SESSION_PLAYBACK_METHODS = setOf(
            "tts.start",
            "tts.enqueue",
            "tts.pause",
            "tts.resume",
            "tts.stop",
        )
    }
}
