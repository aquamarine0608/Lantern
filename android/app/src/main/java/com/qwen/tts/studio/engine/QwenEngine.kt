package com.qwen.tts.studio.engine

/**
 * Thin JNI owner for the pinned qwen3-tts.cpp Android runtime.
 *
 * The native context is not thread-safe. Callers must serialize model loading,
 * synthesis, and [close] on their engine dispatcher. Streaming callbacks run
 * synchronously from native code and must not re-enter this instance.
 */
class QwenEngine : AutoCloseable {
    private var nativePtr: Long

    companion object {
        const val BACKEND_AUTO: Int = 0
        const val BACKEND_CPU: Int = 1
        const val BACKEND_CUDA: Int = 2

        const val TEXT_ALIGNMENT_NONE: Int = 0
        const val TEXT_ALIGNMENT_ESTIMATED: Int = 1
        const val TEXT_ALIGNMENT_EXACT: Int = 2

        init {
            System.loadLibrary("qwen3_tts_jni")
        }
    }

    init {
        nativePtr = nativeInit()
        check(nativePtr != 0L) { "qwen3_tts_init returned a null native context" }
    }

    class NativeParams(
        val languageId: Int = 2050,
        val instruction: String? = null,
        val speaker: String? = null,
        val maxAudioTokens: Int = 512,
    ) {
        init {
            require(maxAudioTokens > 0) { "maxAudioTokens must be positive" }
        }
    }

    class NativeResult(
        val audio: FloatArray?,
        val sampleRate: Int,
        val success: Boolean,
        val errorMsg: String?,
        val timeMs: Long,
    )

    class NativeCapabilities(
        val loaded: Boolean,
        val supportsCloning: Boolean,
        val supportsNamedSpeakers: Boolean,
        val supportsInstruction: Boolean,
        val speakerEmbeddingDim: Int,
        val modelKind: Int,
        val speakerCount: Int,
    )

    fun interface ProgressCallback {
        fun onProgress(tokensGenerated: Int, maxTokens: Int)
    }

    fun interface StreamingCallback {
        /**
         * Audio samples are valid for this call and copied into [audio] by JNI.
         * Text offsets are UTF-8 byte offsets. Return false to cancel generation.
         */
        fun onAudioChunk(
            audio: FloatArray,
            sampleRate: Int,
            startSample: Long,
            endSample: Long,
            startFrame: Int,
            endFrame: Int,
            startTextByte: Int,
            endTextByte: Int,
            textAlignmentKind: Int,
            confidence: Float,
        ): Boolean
    }

    fun loadModels(modelDir: String, modelName: String? = null): Boolean {
        require(modelDir.isNotBlank()) { "modelDir must not be blank" }
        return nativeLoadModels(requireOpen(), modelDir, modelName)
    }

    fun loadIclPromptEncoder(modelDir: String, modelName: String? = null): Boolean {
        require(modelDir.isNotBlank()) { "modelDir must not be blank" }
        return nativeLoadIclPromptEncoder(requireOpen(), modelDir, modelName)
    }

    fun synthesize(
        text: String,
        referenceWav: String? = null,
        speakerEmbeddingPath: String? = null,
        params: NativeParams = NativeParams(),
    ): NativeResult {
        require(text.isNotBlank()) { "text must not be blank" }
        return nativeSynthesize(requireOpen(), text, referenceWav, speakerEmbeddingPath, params)
    }

    fun synthesizeWithIclPrompt(
        text: String,
        iclPromptPath: String,
        params: NativeParams = NativeParams(),
    ): NativeResult {
        require(text.isNotBlank()) { "text must not be blank" }
        require(iclPromptPath.isNotBlank()) { "iclPromptPath must not be blank" }
        return nativeSynthesizeWithIclPrompt(requireOpen(), text, iclPromptPath, params)
    }

    fun synthesizeStreaming(
        text: String,
        referenceWav: String? = null,
        speakerEmbeddingPath: String? = null,
        params: NativeParams = NativeParams(),
        chunkSeconds: Float = 0.5f,
        leftContextSeconds: Float = 0.1f,
        collectAudio: Boolean = false,
        callback: StreamingCallback,
    ): NativeResult {
        require(text.isNotBlank()) { "text must not be blank" }
        require(chunkSeconds.isFinite() && chunkSeconds > 0f) { "chunkSeconds must be positive and finite" }
        require(leftContextSeconds.isFinite() && leftContextSeconds >= 0f) {
            "leftContextSeconds must be non-negative and finite"
        }
        return nativeSynthesizeStreaming(
            requireOpen(),
            text,
            referenceWav,
            speakerEmbeddingPath,
            params,
            chunkSeconds,
            leftContextSeconds,
            collectAudio,
            callback,
        )
    }

    fun extractSpeakerEmbedding(referenceWav: String, outputPath: String): Boolean {
        require(referenceWav.isNotBlank()) { "referenceWav must not be blank" }
        require(outputPath.isNotBlank()) { "outputPath must not be blank" }
        return nativeExtractSpeakerEmbedding(requireOpen(), referenceWav, outputPath)
    }

    fun extractIclPrompt(referenceWav: String, referenceText: String, outputPath: String): Boolean {
        require(referenceWav.isNotBlank()) { "referenceWav must not be blank" }
        require(referenceText.isNotBlank()) { "referenceText must not be blank" }
        require(outputPath.isNotBlank()) { "outputPath must not be blank" }
        return nativeExtractIclPrompt(requireOpen(), referenceWav, referenceText, outputPath)
    }

    fun getAvailableSpeakers(): List<String> =
        nativeGetAvailableSpeakers(requireOpen())
            .orEmpty()
            .lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .toList()

    fun getLastError(): String? = nativeGetLastError(requireOpen())

    fun getModelCapabilities(): NativeCapabilities? = nativeGetModelCapabilities(requireOpen())

    fun setProgressCallback(callback: ProgressCallback?): Boolean =
        nativeSetProgressCallback(requireOpen(), callback)

    fun setBackendPreference(preference: Int): Boolean {
        require(preference in BACKEND_AUTO..BACKEND_CUDA) { "Unknown backend preference: $preference" }
        requireOpen()
        return nativeSetBackendPreference(preference)
    }

    fun getCompiledBackendMask(): Int {
        requireOpen()
        return nativeGetCompiledBackendMask()
    }

    fun getActiveBackendName(): String? {
        requireOpen()
        return nativeGetActiveBackendName()
    }

    fun setCpuThreads(threadCount: Int): Boolean {
        require(threadCount > 0) { "threadCount must be positive" }
        requireOpen()
        return nativeSetCpuThreads(threadCount)
    }

    fun getCpuThreads(): Int {
        requireOpen()
        return nativeGetCpuThreads()
    }

    override fun close() {
        val ptr = nativePtr
        if (ptr == 0L) return
        nativePtr = 0L
        nativeFree(ptr)
    }

    private fun requireOpen(): Long = nativePtr.also {
        check(it != 0L) { "QwenEngine is closed" }
    }

    private external fun nativeInit(): Long
    private external fun nativeFree(ptr: Long)
    private external fun nativeSetBackendPreference(preference: Int): Boolean
    private external fun nativeGetCompiledBackendMask(): Int
    private external fun nativeSetCpuThreads(threadCount: Int): Boolean
    private external fun nativeGetCpuThreads(): Int
    private external fun nativeSetProgressCallback(ptr: Long, callback: ProgressCallback?): Boolean
    private external fun nativeGetActiveBackendName(): String?
    private external fun nativeLoadModels(ptr: Long, modelDir: String, modelName: String?): Boolean
    private external fun nativeLoadIclPromptEncoder(ptr: Long, modelDir: String, modelName: String?): Boolean
    private external fun nativeSynthesize(
        ptr: Long,
        text: String,
        referenceWav: String?,
        speakerEmbeddingPath: String?,
        params: NativeParams,
    ): NativeResult
    private external fun nativeSynthesizeWithIclPrompt(
        ptr: Long,
        text: String,
        iclPromptPath: String,
        params: NativeParams,
    ): NativeResult
    private external fun nativeSynthesizeStreaming(
        ptr: Long,
        text: String,
        referenceWav: String?,
        speakerEmbeddingPath: String?,
        params: NativeParams,
        chunkSeconds: Float,
        leftContextSeconds: Float,
        collectAudio: Boolean,
        callback: StreamingCallback,
    ): NativeResult
    private external fun nativeExtractSpeakerEmbedding(ptr: Long, referenceWav: String, outputPath: String): Boolean
    private external fun nativeExtractIclPrompt(
        ptr: Long,
        referenceWav: String,
        referenceText: String,
        outputPath: String,
    ): Boolean
    private external fun nativeGetAvailableSpeakers(ptr: Long): String?
    private external fun nativeGetLastError(ptr: Long): String?
    private external fun nativeGetModelCapabilities(ptr: Long): NativeCapabilities?
}
