package com.aquamarine0608.lantern.model

import android.content.Context
import android.os.StatFs
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Properties
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

data class QwenInstallProgress(
    val fileName: String,
    val fileBytesDownloaded: Long,
    val fileTotalBytes: Long,
    val totalBytesDownloaded: Long,
    val totalBytes: Long,
)

class InstalledQwenModel internal constructor(
    val manifest: QwenModelManifest,
    val directory: File,
    val manifestDigest: String,
    /** False means the atomic completion record and sizes were checked, but hashes need a load-time recheck. */
    val integrityVerified: Boolean,
) {
    fun artifactFile(id: String): File {
        val artifact = manifest.artifacts.singleOrNull { it.id == id }
            ?: throw IllegalArgumentException("Unknown model artifact: $id")
        return File(directory, artifact.fileName)
    }
}

open class QwenModelInstallException(message: String, cause: Throwable? = null) : IOException(message, cause)

class QwenInsufficientSpaceException(val requiredBytes: Long, val availableBytes: Long) :
    QwenModelInstallException("Qwen installation needs $requiredBytes free bytes; only $availableBytes are available")

class QwenDownloadException(message: String, cause: Throwable? = null) :
    QwenModelInstallException(message, cause)

class QwenIntegrityException(message: String) : QwenModelInstallException(message)

class QwenAtomicPromotionException(cause: Throwable) :
    QwenModelInstallException("The verified model could not be promoted atomically", cause)

/**
 * Installs the pinned model under noBackupFilesDir. Partial files are resumable, while
 * only checksum-verified directories can be atomically promoted and selected by current.properties.
 */
class QwenModelInstaller(
    context: Context,
    private val connectionFactory: (URL) -> HttpURLConnection = { url ->
        url.openConnection() as HttpURLConnection
    },
) {
    private data class CancellationHandle(
        val ownerId: String,
        val cancelled: AtomicBoolean = AtomicBoolean(false),
        val connection: AtomicReference<HttpURLConnection?> = AtomicReference(null),
    )

    private data class PartialMetadata(
        val validator: String,
        val validatorHeader: String,
    )

    private val appContext = context.applicationContext
    private val modelRoot = File(appContext.noBackupFilesDir, "lantern/models")
    private val installMutex = Mutex()
    private val activeCancellation = AtomicReference<CancellationHandle?>()

    suspend fun currentModel(
        manifest: QwenModelManifest = PinnedQwenModelManifest.value,
        verifyHashes: Boolean = false,
    ): InstalledQwenModel? = withContext(Dispatchers.IO) {
        ensureDirectories()
        readCurrentModel(manifest, verifyHashes)
    }

    /**
     * The callback executes on Dispatchers.IO. Cancellation preserves a valid partial file
     * and its validator so a later explicit install can resume it.
     */
    suspend fun install(
        ownerId: String,
        manifest: QwenModelManifest = PinnedQwenModelManifest.value,
        onProgress: (QwenInstallProgress) -> Unit = {},
    ): InstalledQwenModel = installMutex.withLock {
        require(ownerId.isNotBlank() && ownerId.length <= MAX_OWNER_ID_CHARS) {
            "Install owner ID must be between 1 and $MAX_OWNER_ID_CHARS characters"
        }
        val cancellation = CancellationHandle(ownerId)
        check(activeCancellation.compareAndSet(null, cancellation)) { "A Qwen installation is already active" }
        try {
            withContext(Dispatchers.IO) {
                installInternal(manifest, cancellation, onProgress)
            }
        } finally {
            cancellation.connection.getAndSet(null)?.disconnect()
            activeCancellation.compareAndSet(cancellation, null)
        }
    }

    /** Returns true when an active install was signalled and its current HTTP request was closed. */
    fun cancelCurrentInstall(ownerId: String): Boolean {
        val cancellation = activeCancellation.get() ?: return false
        if (cancellation.ownerId != ownerId) return false
        cancellation.cancelled.set(true)
        cancellation.connection.getAndSet(null)?.disconnect()
        return true
    }

    /**
     * Deletes only this manifest's promoted and partial installations. The caller must
     * close QwenNativeRuntime first so native mmap handles cannot outlive these files.
     */
    suspend fun deleteInstalledModels(
        manifest: QwenModelManifest = PinnedQwenModelManifest.value,
    ): Boolean {
        if (!installMutex.tryLock()) {
            throw QwenModelInstallException("Cannot delete models while an installation is active")
        }
        try {
            if (activeCancellation.get() != null) {
                throw QwenModelInstallException("Cannot delete models while an installation is active")
            }
            return withContext(Dispatchers.IO) {
                ensureDirectories()
                var removed = false
                val installs = checkedChild(
                    checkedChild(modelRoot, INSTALLS_DIRECTORY),
                    manifest.manifestId,
                )
                val staging = checkedChild(
                    checkedChild(modelRoot, STAGING_DIRECTORY),
                    manifest.manifestId,
                )
                if (installs.exists()) {
                    deleteTree(installs, checkedChild(modelRoot, INSTALLS_DIRECTORY))
                    removed = true
                }
                if (staging.exists()) {
                    deleteTree(staging, checkedChild(modelRoot, STAGING_DIRECTORY))
                    removed = true
                }
                val current = checkedChild(modelRoot, CURRENT_FILE)
                val pointsAtManifest = readProperties(current)
                    ?.getProperty("manifestId") == manifest.manifestId
                if (pointsAtManifest && current.exists()) {
                    deleteSingleFile(current)
                    removed = true
                }
                removed
            }
        } finally {
            installMutex.unlock()
        }
    }

    private suspend fun installInternal(
        manifest: QwenModelManifest,
        cancellation: CancellationHandle,
        onProgress: (QwenInstallProgress) -> Unit,
    ): InstalledQwenModel {
        ensureDirectories()
        checkCancellation(cancellation)

        // An explicit install request is also the repair path. Re-hash every recovery
        // candidate so a same-size corrupt file cannot be returned forever.
        findPromotedModel(manifest, cancellation)?.let { recovered ->
            writeCurrentMarker(recovered)
            return recovered
        }

        val stagingDirectory = stagingDirectory(manifest)
        requireDirectory(stagingDirectory)

        var reusableBytes = 0L
        for (artifact in manifest.artifacts) {
            val complete = checkedChild(stagingDirectory, artifact.fileName)
            if (complete.isFile && verifyArtifact(complete, artifact, cancellation)) {
                reusableBytes = Math.addExact(reusableBytes, artifact.expectedBytes)
                deleteSingleFile(checkedChild(stagingDirectory, artifact.fileName + PART_SUFFIX))
                deleteSingleFile(checkedChild(stagingDirectory, artifact.fileName + METADATA_SUFFIX))
            } else if (complete.exists()) {
                deleteSingleFile(complete)
            }
            val partial = checkedChild(stagingDirectory, artifact.fileName + PART_SUFFIX)
            if (partial.isFile && partial.length() in 1 until artifact.expectedBytes) {
                reusableBytes = Math.addExact(reusableBytes, partial.length())
            }
        }
        requireFreeSpace(manifest, reusableBytes)

        var completedBefore = 0L
        for (artifact in manifest.artifacts) {
            checkCancellation(cancellation)
            val complete = checkedChild(stagingDirectory, artifact.fileName)
            if (!complete.isFile || !verifyArtifact(complete, artifact, cancellation)) {
                if (complete.exists()) deleteSingleFile(complete)
                downloadArtifact(
                    manifest = manifest,
                    artifact = artifact,
                    stagingDirectory = stagingDirectory,
                    completedBefore = completedBefore,
                    cancellation = cancellation,
                    onProgress = onProgress,
                )
            }
            completedBefore = Math.addExact(completedBefore, artifact.expectedBytes)
            onProgress(
                QwenInstallProgress(
                    fileName = artifact.fileName,
                    fileBytesDownloaded = artifact.expectedBytes,
                    fileTotalBytes = artifact.expectedBytes,
                    totalBytesDownloaded = completedBefore,
                    totalBytes = manifest.expectedInstalledBytes,
                )
            )
        }

        // Keep a reserve even after every byte is present; model loading and app data still need room.
        requireFreeSpace(manifest, manifest.expectedInstalledBytes)
        writeCompletionRecord(stagingDirectory, manifest)

        val promoted = promote(stagingDirectory, manifest)
        writeCurrentMarker(promoted)
        return promoted
    }

    private suspend fun downloadArtifact(
        manifest: QwenModelManifest,
        artifact: QwenModelArtifact,
        stagingDirectory: File,
        completedBefore: Long,
        cancellation: CancellationHandle,
        onProgress: (QwenInstallProgress) -> Unit,
    ) {
        val destination = checkedChild(stagingDirectory, artifact.fileName)
        val partial = checkedChild(stagingDirectory, artifact.fileName + PART_SUFFIX)
        val metadataFile = checkedChild(stagingDirectory, artifact.fileName + METADATA_SUFFIX)

        if (partial.isFile && partial.length() == artifact.expectedBytes) {
            if (verifyArtifact(partial, artifact, cancellation)) {
                atomicMove(partial, destination)
                deleteSingleFile(metadataFile)
                return
            }
            resetPartial(partial, metadataFile)
        }
        if (partial.exists() && (!partial.isFile || partial.length() > artifact.expectedBytes)) {
            resetPartial(partial, metadataFile)
        }

        var resumeAt = partial.takeIf(File::isFile)?.length() ?: 0L
        var savedMetadata = readPartialMetadata(metadataFile, manifest, artifact)
        if (resumeAt > 0 && savedMetadata == null) {
            resetPartial(partial, metadataFile)
            resumeAt = 0L
        }

        checkCancellation(cancellation)
        val connection = openFollowingRedirects(
            initialUrl = URI(artifact.downloadUrl).toURL(),
            resumeAt = resumeAt,
            partialMetadata = savedMetadata,
            cancellation = cancellation,
        )
        cancellation.connection.set(connection)

        try {
            val responseCode = connection.responseCode
            val append: Boolean
            when {
                resumeAt > 0 && responseCode == HttpURLConnection.HTTP_PARTIAL -> {
                    validateContentRange(connection, resumeAt, artifact.expectedBytes)
                    append = true
                }
                responseCode == HttpURLConnection.HTTP_OK -> {
                    if (resumeAt > 0) {
                        resetPartial(partial, metadataFile)
                        resumeAt = 0L
                        savedMetadata = null
                    }
                    append = false
                }
                resumeAt == 0L && responseCode == HttpURLConnection.HTTP_PARTIAL -> {
                    validateContentRange(connection, 0L, artifact.expectedBytes)
                    append = false
                }
                else -> throw QwenDownloadException(
                    "Download failed for ${artifact.fileName}: HTTP $responseCode"
                )
            }

            val responseLength = connection.contentLengthLong
            val remainingBytes = artifact.expectedBytes - resumeAt
            if (responseLength >= 0 && responseLength != remainingBytes) {
                throw QwenDownloadException(
                    "Unexpected response length for ${artifact.fileName}: $responseLength instead of $remainingBytes"
                )
            }

            val newMetadata = responseValidator(connection)
            if (append && savedMetadata != null && newMetadata != null && savedMetadata != newMetadata) {
                resetPartial(partial, metadataFile)
                throw QwenDownloadException("The remote validator changed while resuming ${artifact.fileName}")
            }
            if (newMetadata != null) writePartialMetadata(metadataFile, manifest, artifact, newMetadata)

            try {
                BufferedInputStream(connection.inputStream, DOWNLOAD_BUFFER_BYTES).use { input ->
                    FileOutputStream(partial, append).use { fileOutput ->
                        val output = BufferedOutputStream(fileOutput, DOWNLOAD_BUFFER_BYTES)
                        try {
                            val buffer = ByteArray(DOWNLOAD_BUFFER_BYTES)
                            var written = resumeAt
                            while (true) {
                                checkCancellation(cancellation)
                                val count = input.read(buffer)
                                if (count < 0) break
                                if (written + count > artifact.expectedBytes) {
                                    throw QwenIntegrityException("${artifact.fileName} exceeded its pinned byte count")
                                }
                                output.write(buffer, 0, count)
                                written += count
                                onProgress(
                                    QwenInstallProgress(
                                        fileName = artifact.fileName,
                                        fileBytesDownloaded = written,
                                        fileTotalBytes = artifact.expectedBytes,
                                        totalBytesDownloaded = completedBefore + written,
                                        totalBytes = manifest.expectedInstalledBytes,
                                    )
                                )
                            }
                            output.flush()
                            fileOutput.fd.sync()
                        } finally {
                            output.close()
                        }
                    }
                }
            } catch (error: IOException) {
                if (cancellation.cancelled.get()) throw CancellationException("Qwen model download cancelled")
                throw QwenDownloadException("Could not download ${artifact.fileName}", error)
            }

            if (partial.length() != artifact.expectedBytes) {
                throw QwenDownloadException(
                    "Incomplete download for ${artifact.fileName}: ${partial.length()} of ${artifact.expectedBytes} bytes"
                )
            }
            if (!verifyArtifact(partial, artifact, cancellation)) {
                resetPartial(partial, metadataFile)
                throw QwenIntegrityException("SHA-256 mismatch for ${artifact.fileName}")
            }
            atomicMove(partial, destination)
            deleteSingleFile(metadataFile)
        } finally {
            cancellation.connection.compareAndSet(connection, null)
            connection.disconnect()
        }
    }

    private suspend fun openFollowingRedirects(
        initialUrl: URL,
        resumeAt: Long,
        partialMetadata: PartialMetadata?,
        cancellation: CancellationHandle,
    ): HttpURLConnection {
        var url = initialUrl
        repeat(MAX_REDIRECTS + 1) { redirectCount ->
            checkCancellation(cancellation)
            validateDownloadHost(url)
            val connection = connectionFactory(url)
            cancellation.connection.set(connection)
            connection.instanceFollowRedirects = false
            connection.requestMethod = "GET"
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.setRequestProperty("Accept-Encoding", "identity")
            connection.setRequestProperty("User-Agent", "Lantern-Android/1 model-installer")
            if (resumeAt > 0) {
                connection.setRequestProperty("Range", "bytes=$resumeAt-")
                partialMetadata?.let { metadata ->
                    connection.setRequestProperty(metadata.validatorHeader, metadata.validator)
                }
            }

            val code = try {
                connection.responseCode
            } catch (error: IOException) {
                connection.disconnect()
                cancellation.connection.compareAndSet(connection, null)
                if (cancellation.cancelled.get()) throw CancellationException("Qwen model download cancelled")
                throw QwenDownloadException("Could not connect to the pinned model host", error)
            }
            if (code !in REDIRECT_CODES) return connection

            val redirected = try {
                val location = connection.getHeaderField("Location")
                    ?: throw QwenDownloadException("Model host returned a redirect without a Location header")
                if (redirectCount >= MAX_REDIRECTS) {
                    throw QwenDownloadException("Too many redirects while downloading the pinned model")
                }
                URI(url.toString()).resolve(location).toURL()
            } catch (error: Exception) {
                if (error is QwenDownloadException) throw error
                throw QwenDownloadException("Model host returned an invalid redirect", error)
            } finally {
                connection.disconnect()
                cancellation.connection.compareAndSet(connection, null)
            }
            url = redirected
        }
        throw QwenDownloadException("Too many redirects while downloading the pinned model")
    }

    private fun validateDownloadHost(url: URL) {
        if (url.protocol != "https") {
            throw QwenDownloadException("Model downloads and redirects must use HTTPS")
        }
        if (url.userInfo != null || url.port != -1) {
            throw QwenDownloadException("Model download URL contains credentials or a custom port")
        }
        val host = url.host.lowercase()
        val trusted = host == "huggingface.co" ||
            host.endsWith(".huggingface.co") ||
            host.endsWith(".hf.co") ||
            host.endsWith(".xethub.hf.co")
        if (!trusted) throw QwenDownloadException("Model download redirected to an untrusted host: $host")
    }

    private fun validateContentRange(connection: HttpURLConnection, expectedStart: Long, expectedTotal: Long) {
        val value = connection.getHeaderField("Content-Range")
            ?: throw QwenDownloadException("Resume response omitted Content-Range")
        val match = CONTENT_RANGE_PATTERN.matchEntire(value.trim())
            ?: throw QwenDownloadException("Malformed Content-Range: $value")
        val start = match.groupValues[1].toLongOrNull()
        val end = match.groupValues[2].toLongOrNull()
        val total = match.groupValues[3].toLongOrNull()
        if (start == null || end == null || total == null || start != expectedStart ||
            total != expectedTotal || end < start || end >= expectedTotal
        ) {
            throw QwenDownloadException("Resume response does not match the pinned artifact size")
        }
    }

    private fun responseValidator(connection: HttpURLConnection): PartialMetadata? {
        val etag = connection.getHeaderField("ETag")?.trim()
        if (!etag.isNullOrBlank() && !etag.startsWith("W/", ignoreCase = true)) {
            return PartialMetadata(etag, "If-Range")
        }
        val lastModified = connection.getHeaderField("Last-Modified")?.trim()
        return if (lastModified.isNullOrBlank()) null else PartialMetadata(lastModified, "If-Range")
    }

    private fun writePartialMetadata(
        target: File,
        manifest: QwenModelManifest,
        artifact: QwenModelArtifact,
        metadata: PartialMetadata,
    ) {
        val properties = Properties().apply {
            setProperty("schemaVersion", "1")
            setProperty("manifestId", manifest.manifestId)
            setProperty("revision", manifest.revision)
            setProperty("url", artifact.downloadUrl)
            setProperty("fileName", artifact.fileName)
            setProperty("expectedBytes", artifact.expectedBytes.toString())
            setProperty("sha256", artifact.sha256)
            setProperty("validator", metadata.validator)
            setProperty("validatorHeader", metadata.validatorHeader)
        }
        writePropertiesAtomically(target, properties)
    }

    private fun readPartialMetadata(
        target: File,
        manifest: QwenModelManifest,
        artifact: QwenModelArtifact,
    ): PartialMetadata? {
        val properties = readProperties(target) ?: return null
        if (properties.getProperty("schemaVersion") != "1" ||
            properties.getProperty("manifestId") != manifest.manifestId ||
            properties.getProperty("revision") != manifest.revision ||
            properties.getProperty("url") != artifact.downloadUrl ||
            properties.getProperty("fileName") != artifact.fileName ||
            properties.getProperty("expectedBytes") != artifact.expectedBytes.toString() ||
            properties.getProperty("sha256") != artifact.sha256
        ) return null
        val validator = properties.getProperty("validator")?.takeIf(String::isNotBlank) ?: return null
        val header = properties.getProperty("validatorHeader")
        if (header != "If-Range") return null
        return PartialMetadata(validator, header)
    }

    private suspend fun verifyArtifact(
        file: File,
        artifact: QwenModelArtifact,
        cancellation: CancellationHandle,
    ): Boolean {
        if (!file.isFile || file.length() != artifact.expectedBytes) return false
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { stream ->
            val buffer = ByteArray(HASH_BUFFER_BYTES)
            while (true) {
                checkCancellation(cancellation)
                val count = stream.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        val expected = artifact.sha256.hexBytes()
        return MessageDigest.isEqual(digest.digest(), expected)
    }

    private fun writeCompletionRecord(directory: File, manifest: QwenModelManifest) {
        val properties = Properties().apply {
            setProperty("schemaVersion", "1")
            setProperty("manifestId", manifest.manifestId)
            setProperty("revision", manifest.revision)
            setProperty("manifestDigest", manifest.canonicalDigest())
            setProperty("expectedInstalledBytes", manifest.expectedInstalledBytes.toString())
            manifest.artifacts.forEach { artifact ->
                setProperty("artifact.${artifact.id}.file", artifact.fileName)
                setProperty("artifact.${artifact.id}.bytes", artifact.expectedBytes.toString())
                setProperty("artifact.${artifact.id}.sha256", artifact.sha256)
            }
        }
        writePropertiesAtomically(checkedChild(directory, COMPLETION_FILE), properties)
    }

    private fun promote(stagingDirectory: File, manifest: QwenModelManifest): InstalledQwenModel {
        val revisionRoot = checkedChild(
            checkedChild(checkedChild(modelRoot, INSTALLS_DIRECTORY), manifest.manifestId),
            manifest.revision,
        )
        requireDirectory(revisionRoot)
        val target = checkedChild(
            revisionRoot,
            manifest.canonicalDigest().take(16) + "-" + UUID.randomUUID().toString(),
        )
        atomicMove(stagingDirectory, target)
        return InstalledQwenModel(
            manifest = manifest,
            directory = target,
            manifestDigest = manifest.canonicalDigest(),
            integrityVerified = true,
        )
    }

    private fun writeCurrentMarker(model: InstalledQwenModel) {
        val previous = readProperties(checkedChild(modelRoot, CURRENT_FILE))
            ?.getProperty("relativeDirectory")
            ?.takeIf { it.isNotBlank() }
        val relative = modelRoot.canonicalFile.toPath().relativize(model.directory.canonicalFile.toPath()).toString()
        val properties = Properties().apply {
            setProperty("schemaVersion", "1")
            setProperty("manifestId", model.manifest.manifestId)
            setProperty("revision", model.manifest.revision)
            setProperty("manifestDigest", model.manifestDigest)
            setProperty("relativeDirectory", relative)
            if (previous != null && previous != relative) setProperty("previousDirectory", previous)
        }
        writePropertiesAtomically(checkedChild(modelRoot, CURRENT_FILE), properties)
    }

    private suspend fun readCurrentModel(
        manifest: QwenModelManifest,
        verifyHashes: Boolean,
    ): InstalledQwenModel? {
        val properties = readProperties(checkedChild(modelRoot, CURRENT_FILE)) ?: return null
        if (properties.getProperty("schemaVersion") != "1" ||
            properties.getProperty("manifestId") != manifest.manifestId ||
            properties.getProperty("revision") != manifest.revision ||
            properties.getProperty("manifestDigest") != manifest.canonicalDigest()
        ) return null
        val relative = properties.getProperty("relativeDirectory") ?: return null
        val directory = resolveRelativeDirectory(relative) ?: return null
        return validatedInstallation(directory, manifest, verifyHashes)
    }

    private suspend fun findPromotedModel(
        manifest: QwenModelManifest,
        cancellation: CancellationHandle,
    ): InstalledQwenModel? {
        val revisionRoot = checkedChild(
            checkedChild(checkedChild(modelRoot, INSTALLS_DIRECTORY), manifest.manifestId),
            manifest.revision,
        )
        val candidates = revisionRoot.listFiles()
            ?.filter(File::isDirectory)
            ?.sortedByDescending(File::lastModified)
            .orEmpty()
        for (candidate in candidates) {
            checkCancellation(cancellation)
            validatedInstallation(
                directory = candidate,
                manifest = manifest,
                verifyHashes = true,
                cancellation = cancellation,
            )?.let { return it }
        }
        return null
    }

    private suspend fun validatedInstallation(
        directory: File,
        manifest: QwenModelManifest,
        verifyHashes: Boolean,
        cancellation: CancellationHandle = CancellationHandle(ownerId = "read-only-verification"),
    ): InstalledQwenModel? {
        if (!directory.isDirectory || !isWithin(directory, modelRoot)) return null
        val completion = readProperties(checkedChild(directory, COMPLETION_FILE)) ?: return null
        if (completion.getProperty("schemaVersion") != "1" ||
            completion.getProperty("manifestId") != manifest.manifestId ||
            completion.getProperty("revision") != manifest.revision ||
            completion.getProperty("manifestDigest") != manifest.canonicalDigest() ||
            completion.getProperty("expectedInstalledBytes") != manifest.expectedInstalledBytes.toString()
        ) return null

        for (artifact in manifest.artifacts) {
            if (completion.getProperty("artifact.${artifact.id}.file") != artifact.fileName ||
                completion.getProperty("artifact.${artifact.id}.bytes") != artifact.expectedBytes.toString() ||
                completion.getProperty("artifact.${artifact.id}.sha256") != artifact.sha256
            ) return null
            val file = checkedChild(directory, artifact.fileName)
            if (!file.isFile || file.length() != artifact.expectedBytes) return null
            if (verifyHashes && !verifyArtifact(file, artifact, cancellation)) return null
        }
        return InstalledQwenModel(
            manifest = manifest,
            directory = directory.canonicalFile,
            manifestDigest = manifest.canonicalDigest(),
            integrityVerified = verifyHashes,
        )
    }

    private fun requireFreeSpace(manifest: QwenModelManifest, reusableBytes: Long) {
        val reserve = manifest.minimumFreeSpaceBytes - manifest.expectedInstalledBytes
        val bytesStillNeeded = (manifest.expectedInstalledBytes - reusableBytes).coerceAtLeast(0L)
        val required = Math.addExact(bytesStillNeeded, reserve)
        val available = StatFs(modelRoot.absolutePath).availableBytes
        if (available < required) throw QwenInsufficientSpaceException(required, available)
    }

    private fun stagingDirectory(manifest: QwenModelManifest): File = checkedChild(
        checkedChild(checkedChild(modelRoot, STAGING_DIRECTORY), manifest.manifestId),
        manifest.revision,
    )

    private fun ensureDirectories() {
        requireDirectory(modelRoot)
        requireDirectory(checkedChild(modelRoot, STAGING_DIRECTORY))
        requireDirectory(checkedChild(modelRoot, INSTALLS_DIRECTORY))
    }

    private fun requireDirectory(directory: File) {
        if (!directory.isDirectory && !directory.mkdirs()) {
            throw QwenModelInstallException("Could not create private model directory: ${directory.name}")
        }
    }

    private fun checkedChild(parent: File, child: String): File {
        val canonicalParent = parent.canonicalFile
        val candidate = File(canonicalParent, child).canonicalFile
        require(candidate.toPath().startsWith(canonicalParent.toPath())) { "Unsafe model storage path" }
        return candidate
    }

    private fun resolveRelativeDirectory(relative: String): File? {
        if (relative.isBlank() || File(relative).isAbsolute) return null
        val candidate = File(modelRoot, relative).canonicalFile
        return candidate.takeIf { isWithin(it, checkedChild(modelRoot, INSTALLS_DIRECTORY)) }
    }

    private fun isWithin(candidate: File, parent: File): Boolean =
        candidate.canonicalFile.toPath().startsWith(parent.canonicalFile.toPath())

    private fun writePropertiesAtomically(target: File, properties: Properties) {
        val parent = target.parentFile ?: throw QwenModelInstallException("Missing metadata parent directory")
        requireDirectory(parent)
        val temporary = checkedChild(parent, ".${target.name}.${UUID.randomUUID()}.tmp")
        try {
            FileOutputStream(temporary).use { output ->
                properties.store(output, null)
                output.fd.sync()
            }
            atomicMove(temporary, target)
        } finally {
            if (temporary.exists()) deleteSingleFile(temporary)
        }
    }

    private fun readProperties(file: File): Properties? {
        if (!file.isFile) return null
        return try {
            Properties().also { properties ->
                FileInputStream(file).use { input -> properties.load(input) }
            }
        } catch (_: IOException) {
            null
        } catch (_: IllegalArgumentException) {
            null
        }
    }

    private fun atomicMove(source: File, target: File) {
        try {
            Files.move(
                source.toPath(),
                target.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (error: AtomicMoveNotSupportedException) {
            throw QwenAtomicPromotionException(error)
        } catch (error: IOException) {
            throw QwenAtomicPromotionException(error)
        }
    }

    private fun resetPartial(partial: File, metadata: File) {
        deleteSingleFile(partial)
        deleteSingleFile(metadata)
    }

    private fun deleteSingleFile(file: File) {
        if (file.exists() && (!file.isFile || !file.delete())) {
            throw QwenModelInstallException("Could not remove incomplete model file: ${file.name}")
        }
    }

    private fun deleteTree(target: File, allowedParent: File) {
        val canonicalTarget = target.canonicalFile
        val canonicalParent = allowedParent.canonicalFile
        require(canonicalTarget != canonicalParent && canonicalTarget.toPath().startsWith(canonicalParent.toPath())) {
            "Refusing to delete a broad or unsafe model path"
        }
        target.listFiles()?.forEach { child ->
            if (child.isDirectory) deleteTree(child, canonicalTarget) else deleteSingleFile(child)
        }
        if (target.exists() && !target.delete()) {
            throw QwenModelInstallException("Could not remove model directory: ${target.name}")
        }
    }

    private suspend fun checkCancellation(cancellation: CancellationHandle) {
        currentCoroutineContext().ensureActive()
        if (cancellation.cancelled.get()) throw CancellationException("Qwen model download cancelled")
    }

    private fun String.hexBytes(): ByteArray {
        require(length % 2 == 0)
        return ByteArray(length / 2) { index -> substring(index * 2, index * 2 + 2).toInt(16).toByte() }
    }

    private companion object {
        const val MAX_OWNER_ID_CHARS = 128
        const val STAGING_DIRECTORY = ".staging"
        const val INSTALLS_DIRECTORY = "installs"
        const val CURRENT_FILE = "current.properties"
        const val COMPLETION_FILE = ".complete.properties"
        const val PART_SUFFIX = ".part"
        const val METADATA_SUFFIX = ".part.properties"
        const val CONNECT_TIMEOUT_MS = 30_000
        const val READ_TIMEOUT_MS = 60_000
        const val DOWNLOAD_BUFFER_BYTES = 256 * 1024
        const val HASH_BUFFER_BYTES = 1024 * 1024
        const val MAX_REDIRECTS = 5
        val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
        val CONTENT_RANGE_PATTERN = Regex("^bytes (\\d+)-(\\d+)/(\\d+)$", RegexOption.IGNORE_CASE)
    }
}
