package com.aquamarine0608.lantern.runtime

import com.aquamarine0608.lantern.model.InstalledQwenModel
import com.aquamarine0608.lantern.model.PinnedQwenModelManifest
import com.qwen.tts.studio.engine.QwenEngine
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.ExecutorCoroutineDispatcher
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/** Values intentionally match the version-1 WebView bridge model-state strings. */
enum class QwenRuntimeState(val wireValue: String) {
    NOT_INSTALLED("notInstalled"),
    DOWNLOADING("downloading"),
    LOADING("loading"),
    READY("ready"),
    FAILED("failed"),
}

data class QwenRuntimeStatus(
    val state: QwenRuntimeState,
    val detail: String? = null,
    val modelRevision: String? = null,
)

enum class QwenLanguage(val nativeId: Int) {
    AUTO(-1),
    ENGLISH(2050),
    GERMAN(2053),
    SPANISH(2054),
    CHINESE(2055),
    JAPANESE(2058),
    FRENCH(2061),
    KOREAN(2064),
    RUSSIAN(2069),
    ITALIAN(2070),
    PORTUGUESE(2071),
}

data class QwenSentenceRequest(
    val text: String,
    val language: QwenLanguage = QwenLanguage.ENGLISH,
    val maxAudioTokens: Int = 512,
    val speed: Double = 1.0,
)

data class QwenRenderedSentence(
    val wavBytes: ByteArray,
    val sampleRateHz: Int,
    val sampleCount: Int,
    val durationSeconds: Double,
    val nativeGenerationMilliseconds: Long,
)

class QwenRuntimeException(
    val code: String,
    message: String,
    cause: Throwable? = null,
) : Exception(message, cause)

/** Polled by the native streaming callback so an abandoned WebView request can stop generation. */
fun interface QwenCancellationSignal {
    fun isCancellationRequested(): Boolean

    companion object {
        val NONE = QwenCancellationSignal { false }
    }
}

/**
 * Single-thread owner of QwenEngine. JNI model contexts are never accessed concurrently.
 * The initial Base model deliberately exposes no reference-audio path or arbitrary native options.
 */
class QwenNativeRuntime(
    private val engineFactory: () -> QwenEngine = { QwenEngine() },
) {
    @Volatile
    private var statusSnapshot = QwenRuntimeStatus(QwenRuntimeState.NOT_INSTALLED)

    private val operationMutex = Mutex()
    private val isShutdown = AtomicBoolean(false)
    private val engineDispatcher: ExecutorCoroutineDispatcher =
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "Lantern-Qwen-Runtime").apply { isDaemon = true }
        }.asCoroutineDispatcher()

    private var engine: QwenEngine? = null
    private var loadedModel: InstalledQwenModel? = null

    fun status(): QwenRuntimeStatus = statusSnapshot

    suspend fun load(model: InstalledQwenModel): QwenRuntimeStatus = operationMutex.withLock {
        requireOpen()
        statusSnapshot = QwenRuntimeStatus(
            state = QwenRuntimeState.LOADING,
            detail = "Verifying and loading the local Qwen model",
            modelRevision = model.manifest.revision,
        )
        try {
            val ready = withContext(engineDispatcher) {
                validatePinnedInstallation(model)
                if (!model.integrityVerified) verifyHashes(model)

                engine?.close()
                engine = null
                loadedModel = null

                val candidate = try {
                    engineFactory()
                } catch (error: LinkageError) {
                    throw QwenRuntimeException("NATIVE_UNAVAILABLE", "The Qwen native library could not be loaded", error)
                } catch (error: RuntimeException) {
                    throw QwenRuntimeException("NATIVE_INIT_FAILED", "The Qwen native runtime could not start", error)
                }

                try {
                    configureCpuRuntime(candidate)
                    val loaded = candidate.loadModels(
                        modelDir = model.directory.absolutePath,
                        modelName = PinnedQwenModelManifest.TALKER_FILE,
                    )
                    if (!loaded) {
                        val detail = candidate.getLastError().safeNativeMessage()
                        throw QwenRuntimeException(
                            "MODEL_LOAD_FAILED",
                            detail ?: "The verified Qwen model could not be loaded",
                        )
                    }
                    val capabilities = candidate.getModelCapabilities()
                    if (capabilities != null && !capabilities.loaded) {
                        throw QwenRuntimeException("MODEL_LOAD_FAILED", "The Qwen runtime did not report a loaded model")
                    }
                    engine = candidate
                    loadedModel = model
                    val backend = candidate.getActiveBackendName().safeNativeMessage()
                    QwenRuntimeStatus(
                        state = QwenRuntimeState.READY,
                        detail = backend?.let { "Local Qwen ready on $it" } ?: "Local Qwen ready",
                        modelRevision = model.manifest.revision,
                    )
                } catch (error: Throwable) {
                    runCatching { candidate.close() }
                    if (error is LinkageError) {
                        throw QwenRuntimeException(
                            "NATIVE_UNAVAILABLE",
                            "The Qwen native library is incomplete or incompatible",
                            error,
                        )
                    }
                    throw error
                }
            }
            statusSnapshot = ready
            ready
        } catch (error: CancellationException) {
            // A native load cannot be interrupted while it is inside JNI. If cancellation
            // arrives there, close anything it managed to publish before reporting idle.
            withContext(NonCancellable + engineDispatcher) {
                runCatching { engine?.close() }
                engine = null
                loadedModel = null
            }
            statusSnapshot = QwenRuntimeStatus(QwenRuntimeState.NOT_INSTALLED, "Model loading cancelled")
            throw error
        } catch (error: QwenRuntimeException) {
            statusSnapshot = QwenRuntimeStatus(QwenRuntimeState.FAILED, error.message, model.manifest.revision)
            throw error
        } catch (error: OutOfMemoryError) {
            val wrapped = QwenRuntimeException(
                "MODEL_OUT_OF_MEMORY",
                "The device did not have enough memory to load local Qwen",
                error,
            )
            statusSnapshot = QwenRuntimeStatus(QwenRuntimeState.FAILED, wrapped.message, model.manifest.revision)
            throw wrapped
        } catch (error: Exception) {
            val wrapped = QwenRuntimeException("MODEL_LOAD_FAILED", "The local Qwen model could not be loaded", error)
            statusSnapshot = QwenRuntimeStatus(QwenRuntimeState.FAILED, wrapped.message, model.manifest.revision)
            throw wrapped
        }
    }

    suspend fun renderSentence(
        request: QwenSentenceRequest,
        cancellationSignal: QwenCancellationSignal = QwenCancellationSignal.NONE,
    ): QwenRenderedSentence = operationMutex.withLock {
        requireOpen()
        validateRequest(request)
        cancellationSignal.throwIfCancellationRequested()
        withContext(engineDispatcher) {
            currentCoroutineContext().ensureActive()
            cancellationSignal.throwIfCancellationRequested()
            val activeEngine = engine
                ?: throw QwenRuntimeException("MODEL_NOT_READY", "The local Qwen model is not loaded")
            val activeModel = loadedModel
                ?: throw QwenRuntimeException("MODEL_NOT_READY", "The local Qwen model is not loaded")
            if (statusSnapshot.state != QwenRuntimeState.READY) {
                throw QwenRuntimeException("MODEL_NOT_READY", "The local Qwen model is not ready")
            }

            val result = try {
                activeEngine.synthesizeStreaming(
                    text = request.text.trim(),
                    referenceWav = null,
                    speakerEmbeddingPath = null,
                    params = QwenEngine.NativeParams(
                        languageId = request.language.nativeId,
                        instruction = null,
                        speaker = null,
                        maxAudioTokens = request.maxAudioTokens,
                    ),
                    chunkSeconds = STREAMING_CHUNK_SECONDS,
                    leftContextSeconds = STREAMING_LEFT_CONTEXT_SECONDS,
                    collectAudio = true,
                    callback = QwenEngine.StreamingCallback { _, _, _, _, _, _, _, _, _, _ ->
                        !cancellationSignal.isCancellationRequested()
                    },
                )
            } catch (error: LinkageError) {
                throw QwenRuntimeException(
                    "NATIVE_UNAVAILABLE",
                    "The Qwen native library is incomplete or incompatible",
                    error,
                )
            } catch (error: RuntimeException) {
                throw QwenRuntimeException("SYNTHESIS_FAILED", "Local Qwen synthesis failed", error)
            }

            cancellationSignal.throwIfCancellationRequested()
            currentCoroutineContext().ensureActive()
            if (!result.success) {
                throw QwenRuntimeException(
                    "SYNTHESIS_FAILED",
                    result.errorMsg.safeNativeMessage() ?: "Local Qwen synthesis failed",
                )
            }
            val source = result.audio
                ?: throw QwenRuntimeException("INVALID_AUDIO", "Local Qwen returned no audio")
            if (source.isEmpty()) throw QwenRuntimeException("INVALID_AUDIO", "Local Qwen returned empty audio")
            if (result.sampleRate != activeModel.manifest.sampleRateHz) {
                throw QwenRuntimeException(
                    "INVALID_AUDIO_FORMAT",
                    "Local Qwen returned ${result.sampleRate} Hz instead of ${activeModel.manifest.sampleRateHz} Hz",
                )
            }
            if (source.size.toLong() > result.sampleRate.toLong() * MAX_OUTPUT_SECONDS) {
                throw QwenRuntimeException("AUDIO_LIMIT_EXCEEDED", "Local Qwen returned an overlong sentence")
            }
            if (!source.all(Float::isFinite)) {
                throw QwenRuntimeException("INVALID_AUDIO", "Local Qwen returned non-finite audio samples")
            }

            cancellationSignal.throwIfCancellationRequested()
            currentCoroutineContext().ensureActive()
            val rendered = if (request.speed == 1.0) {
                source
            } else {
                PcmWav.resampleLinearForSpeed(source, request.speed)
            }
            if (rendered.size.toLong() > result.sampleRate.toLong() * MAX_OUTPUT_SECONDS) {
                throw QwenRuntimeException("AUDIO_LIMIT_EXCEEDED", "The speed-adjusted sentence is overlong")
            }
            val wav = try {
                PcmWav.encodeMonoPcm16(rendered, result.sampleRate)
            } catch (error: IllegalArgumentException) {
                throw QwenRuntimeException("INVALID_AUDIO", "Local Qwen audio could not be encoded", error)
            } catch (error: ArithmeticException) {
                throw QwenRuntimeException("AUDIO_LIMIT_EXCEEDED", "Local Qwen audio was too large", error)
            }
            cancellationSignal.throwIfCancellationRequested()
            currentCoroutineContext().ensureActive()
            QwenRenderedSentence(
                wavBytes = wav,
                sampleRateHz = result.sampleRate,
                sampleCount = rendered.size,
                durationSeconds = rendered.size.toDouble() / result.sampleRate,
                nativeGenerationMilliseconds = result.timeMs.coerceAtLeast(0L),
            )
        }
    }

    /** Releases all native mmap/model handles but keeps this wrapper reusable. */
    suspend fun unload() = operationMutex.withLock {
        if (isShutdown.get()) return@withLock
        withContext(NonCancellable + engineDispatcher) {
            engine?.close()
            engine = null
            loadedModel = null
        }
        statusSnapshot = QwenRuntimeStatus(QwenRuntimeState.NOT_INSTALLED)
    }

    /** Permanently stops the private runtime thread. Use [unload] when later reuse is expected. */
    suspend fun shutdown() {
        operationMutex.withLock {
            if (!isShutdown.compareAndSet(false, true)) return@withLock
            withContext(NonCancellable + engineDispatcher) {
                engine?.close()
                engine = null
                loadedModel = null
            }
            statusSnapshot = QwenRuntimeStatus(QwenRuntimeState.NOT_INSTALLED, "Runtime closed")
        }
        engineDispatcher.close()
    }

    private suspend fun verifyHashes(model: InstalledQwenModel) {
        model.manifest.artifacts.forEach { artifact ->
            currentCoroutineContext().ensureActive()
            val file = model.artifactFile(artifact.id)
            val digest = MessageDigest.getInstance("SHA-256")
            FileInputStream(file).use { input ->
                val buffer = ByteArray(HASH_BUFFER_BYTES)
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val count = input.read(buffer)
                    if (count < 0) break
                    digest.update(buffer, 0, count)
                }
            }
            val actual = digest.digest().joinToString(separator = "") { byte ->
                "%02x".format(byte.toInt() and 0xff)
            }
            if (actual != artifact.sha256) {
                throw QwenRuntimeException("MODEL_INTEGRITY_FAILED", "Installed model checksum mismatch: ${artifact.fileName}")
            }
        }
    }

    private fun validatePinnedInstallation(model: InstalledQwenModel) {
        val pinned = PinnedQwenModelManifest.value
        if (model.manifestDigest != pinned.canonicalDigest() ||
            model.manifest.canonicalDigest() != pinned.canonicalDigest()
        ) {
            throw QwenRuntimeException("MODEL_REVISION_UNSUPPORTED", "Only the pinned Android Qwen model is supported")
        }
        val directory = model.directory.canonicalFile
        if (!directory.isDirectory) throw QwenRuntimeException("MODEL_NOT_INSTALLED", "The installed model directory is missing")
        pinned.artifacts.forEach { artifact ->
            val file = File(directory, artifact.fileName).canonicalFile
            if (!file.toPath().startsWith(directory.toPath()) || !file.isFile || file.length() != artifact.expectedBytes) {
                throw QwenRuntimeException("MODEL_INTEGRITY_FAILED", "Installed model file is missing or truncated: ${artifact.fileName}")
            }
        }
    }

    private fun configureCpuRuntime(candidate: QwenEngine) {
        val compiledBackends = candidate.getCompiledBackendMask()
        if (compiledBackends and CPU_BACKEND_MASK == 0) {
            throw QwenRuntimeException("CPU_BACKEND_UNAVAILABLE", "The native Qwen build has no CPU backend")
        }
        if (!candidate.setBackendPreference(QwenEngine.BACKEND_CPU)) {
            throw QwenRuntimeException("CPU_BACKEND_CONFIGURATION_FAILED", "Could not select the Qwen CPU backend")
        }

        val requestedThreads = Runtime.getRuntime().availableProcessors().coerceIn(1, MAX_CPU_THREADS)
        if (!candidate.setCpuThreads(requestedThreads)) {
            throw QwenRuntimeException(
                "CPU_THREAD_CONFIGURATION_FAILED",
                "Could not configure the Qwen CPU worker count",
            )
        }
        if (candidate.getCpuThreads() != requestedThreads) {
            throw QwenRuntimeException(
                "CPU_THREAD_CONFIGURATION_FAILED",
                "The Qwen runtime did not retain its CPU worker count",
            )
        }
    }

    private fun validateRequest(request: QwenSentenceRequest) {
        val text = request.text.trim()
        require(text.isNotEmpty()) { "Sentence text must not be empty" }
        require(text.codePointCount(0, text.length) <= MAX_TEXT_CODE_POINTS) {
            "Sentence exceeds $MAX_TEXT_CODE_POINTS Unicode characters"
        }
        require(text.toByteArray(Charsets.UTF_8).size <= MAX_TEXT_UTF8_BYTES) {
            "Sentence exceeds $MAX_TEXT_UTF8_BYTES UTF-8 bytes"
        }
        require(hasValidSurrogates(text)) { "Sentence contains an unpaired UTF-16 surrogate" }
        require(text.none { character -> character.isISOControl() && character !in "\n\r\t" }) {
            "Sentence contains unsupported control characters"
        }
        require(request.maxAudioTokens in MIN_AUDIO_TOKENS..MAX_AUDIO_TOKENS) {
            "maxAudioTokens must be between $MIN_AUDIO_TOKENS and $MAX_AUDIO_TOKENS"
        }
        require(request.speed.isFinite() && request.speed in MIN_SPEED..MAX_SPEED) {
            "Speed must be between $MIN_SPEED and $MAX_SPEED"
        }
    }

    private fun hasValidSurrogates(text: String): Boolean {
        var index = 0
        while (index < text.length) {
            val character = text[index]
            when {
                Character.isHighSurrogate(character) -> {
                    if (index + 1 >= text.length || !Character.isLowSurrogate(text[index + 1])) return false
                    index += 2
                }
                Character.isLowSurrogate(character) -> return false
                else -> index++
            }
        }
        return true
    }

    private fun requireOpen() {
        check(!isShutdown.get()) { "QwenNativeRuntime is shut down" }
    }

    private fun QwenCancellationSignal.throwIfCancellationRequested() {
        if (isCancellationRequested()) throw CancellationException("Local Qwen synthesis was cancelled")
    }

    private fun String?.safeNativeMessage(): String? = this
        ?.replace(Regex("[\\r\\n\\t]+"), " ")
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?.take(MAX_NATIVE_ERROR_CHARS)

    private companion object {
        const val HASH_BUFFER_BYTES = 1024 * 1024
        const val MAX_TEXT_CODE_POINTS = 4_000
        const val MAX_TEXT_UTF8_BYTES = 16 * 1024
        const val MIN_AUDIO_TOKENS = 16
        const val MAX_AUDIO_TOKENS = 1_024
        const val MAX_OUTPUT_SECONDS = 120L
        const val MIN_SPEED = 0.75
        const val MAX_SPEED = 1.5
        const val MAX_NATIVE_ERROR_CHARS = 500
        const val CPU_BACKEND_MASK = 1
        const val MAX_CPU_THREADS = 6
        const val STREAMING_CHUNK_SECONDS = 0.25f
        const val STREAMING_LEFT_CONTEXT_SECONDS = 0.1f
    }
}
