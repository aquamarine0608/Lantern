package com.aquamarine0608.lantern.model

import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

private val REVISION_PATTERN = Regex("^[0-9a-f]{40}$")
private val SHA256_PATTERN = Regex("^[0-9a-f]{64}$")
private val FILE_NAME_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._-]*$")
private val REPOSITORY_PATTERN = Regex("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")

/** One immutable file in a downloadable Qwen model installation. */
data class QwenModelArtifact(
    val id: String,
    val fileName: String,
    val expectedBytes: Long,
    val sha256: String,
    val downloadUrl: String,
) {
    init {
        require(FILE_NAME_PATTERN.matches(id)) { "Unsafe artifact id: $id" }
        require(FILE_NAME_PATTERN.matches(fileName)) { "Unsafe artifact file name: $fileName" }
        require(expectedBytes > 0) { "Artifact byte count must be positive" }
        require(SHA256_PATTERN.matches(sha256)) { "Artifact SHA-256 must be 64 lowercase hex characters" }
    }
}

/**
 * Closed manifest for a model revision. URLs are validated against the immutable
 * Hugging Face revision path so callers cannot turn the installer into a generic downloader.
 */
data class QwenModelManifest(
    val schemaVersion: Int,
    val manifestId: String,
    val repository: String,
    val revision: String,
    val minimumFreeSpaceBytes: Long,
    val sampleRateHz: Int,
    val channelCount: Int,
    val artifacts: List<QwenModelArtifact>,
) {
    val expectedInstalledBytes: Long = artifacts.fold(0L) { total, artifact ->
        Math.addExact(total, artifact.expectedBytes)
    }

    init {
        require(schemaVersion == 1) { "Unsupported model manifest schema: $schemaVersion" }
        require(FILE_NAME_PATTERN.matches(manifestId)) { "Unsafe manifest id: $manifestId" }
        require(REPOSITORY_PATTERN.matches(repository)) { "Invalid Hugging Face repository: $repository" }
        require(REVISION_PATTERN.matches(revision)) { "Model revision must be a 40-character commit SHA" }
        require(artifacts.isNotEmpty()) { "A model manifest must contain artifacts" }
        require(artifacts.map { it.id }.toSet().size == artifacts.size) { "Artifact ids must be unique" }
        require(artifacts.map { it.fileName }.toSet().size == artifacts.size) { "Artifact file names must be unique" }
        require(minimumFreeSpaceBytes >= expectedInstalledBytes) {
            "Free-space threshold must cover the complete installation"
        }
        require(sampleRateHz in 8_000..192_000) { "Unsupported model sample rate" }
        require(channelCount == 1) { "Lantern supports only mono local TTS" }

        artifacts.forEach { artifact -> validateImmutableUrl(artifact) }
    }

    /** Digest written into the completion record and current-model pointer. */
    fun canonicalDigest(): String {
        val canonical = buildString {
            append(schemaVersion).append('\n')
            append(manifestId).append('\n')
            append(repository).append('\n')
            append(revision).append('\n')
            append(minimumFreeSpaceBytes).append('\n')
            append(sampleRateHz).append('\n')
            append(channelCount).append('\n')
            artifacts.sortedBy { it.id }.forEach { artifact ->
                append(artifact.id).append('\t')
                append(artifact.fileName).append('\t')
                append(artifact.expectedBytes).append('\t')
                append(artifact.sha256).append('\t')
                append(artifact.downloadUrl).append('\n')
            }
        }
        return MessageDigest.getInstance("SHA-256")
            .digest(canonical.toByteArray(StandardCharsets.UTF_8))
            .joinToString(separator = "") { byte -> "%02x".format(byte.toInt() and 0xff) }
    }

    private fun validateImmutableUrl(artifact: QwenModelArtifact) {
        val uri = try {
            URI(artifact.downloadUrl)
        } catch (error: Exception) {
            throw IllegalArgumentException("Invalid artifact URL for ${artifact.id}", error)
        }
        require(uri.scheme == "https") { "Artifact URL must use HTTPS" }
        require(uri.host == "huggingface.co") { "Artifact URL must use huggingface.co" }
        require(uri.port == -1 && uri.userInfo == null && uri.query == null && uri.fragment == null) {
            "Artifact URL must not contain credentials, a port, query, or fragment"
        }
        val expectedPath = "/$repository/resolve/$revision/${artifact.fileName}"
        require(uri.rawPath == expectedPath) {
            "Artifact URL must resolve the pinned revision and exact file name"
        }
    }
}

/** The only model revision accepted by the initial Android runtime. */
object PinnedQwenModelManifest {
    const val REPOSITORY = "Serveurperso/Qwen3-TTS-GGUF"
    const val REVISION = "968442208ea86f312b6b67ac8ef0c1b551967e35"
    const val TALKER_FILE = "qwen-talker-0.6b-base-Q4_K_M.gguf"
    const val TOKENIZER_FILE = "qwen-tokenizer-12hz-Q4_K_M.gguf"

    private const val EXPECTED_BYTES = 883_879_808L
    private const val INSTALL_RESERVE_BYTES = 512L * 1024L * 1024L

    val value = QwenModelManifest(
        schemaVersion = 1,
        manifestId = "qwen3-tts-0.6b-base-q4-k-m",
        repository = REPOSITORY,
        revision = REVISION,
        minimumFreeSpaceBytes = EXPECTED_BYTES + INSTALL_RESERVE_BYTES,
        sampleRateHz = 24_000,
        channelCount = 1,
        artifacts = listOf(
            QwenModelArtifact(
                id = "talker",
                fileName = TALKER_FILE,
                expectedBytes = 628_905_056L,
                sha256 = "4b468ec7b1f62b90ef4ca316c0aa57deadfd54b2cf9651703ea753cedaf04226",
                downloadUrl = "https://huggingface.co/$REPOSITORY/resolve/$REVISION/$TALKER_FILE",
            ),
            QwenModelArtifact(
                id = "speech-tokenizer",
                fileName = TOKENIZER_FILE,
                expectedBytes = 254_974_752L,
                sha256 = "cf3788b4d50aaa665fb6e57c170396aae03a3555fea52d2b5d0cda902d658039",
                downloadUrl = "https://huggingface.co/$REPOSITORY/resolve/$REVISION/$TOKENIZER_FILE",
            ),
        ),
    )
}
