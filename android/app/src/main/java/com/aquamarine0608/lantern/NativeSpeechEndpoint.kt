package com.aquamarine0608.lantern

import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import com.aquamarine0608.lantern.runtime.QwenLanguage
import com.aquamarine0608.lantern.runtime.QwenNativeRuntime
import com.aquamarine0608.lantern.runtime.QwenRuntimeException
import com.aquamarine0608.lantern.runtime.QwenSentenceRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.Base64

internal enum class SpeechEndpointMatch {
    NOT_ENDPOINT,
    INVALID_ENDPOINT,
    EXACT_ENDPOINT,
}

internal data class ParsedSpeechRequest(
    val synthesisRequestId: String,
    val text: String,
    val speed: Double,
)

internal data class SpeechRequestFailure(
    val statusCode: Int,
    val reasonPhrase: String,
    val message: String,
)

internal sealed interface SpeechRequestParseResult {
    data class Valid(val request: ParsedSpeechRequest) : SpeechRequestParseResult
    data class Invalid(val failure: SpeechRequestFailure) : SpeechRequestParseResult
}

/** Pure request validation kept separate from WebView and the native runtime. */
internal object NativeSpeechRequestParser {
    const val ENDPOINT_PATH = "/native/v1/audio/speech"
    const val REQUEST_HEADER = "X-Lantern-Qwen-Request"
    const val MAX_HEADER_ASCII_BYTES = 16 * 1024
    const val MAX_DECODED_JSON_BYTES = 16 * 1024
    const val MAX_TEXT_UTF8_BYTES = 16 * 1024
    const val MAX_TEXT_CODE_POINTS = 4_000
    const val MIN_SPEED = 0.8
    const val MAX_SPEED = 1.5

    private val expectedKeys = setOf("synthesisRequestId", "text", "language", "speed")
    private val base64UrlPattern = Regex("^[A-Za-z0-9_-]+$")

    fun classify(uri: Uri): SpeechEndpointMatch {
        if (uri.encodedPath != ENDPOINT_PATH) return SpeechEndpointMatch.NOT_ENDPOINT
        return if (LanternWebOrigins.isExactAppOrigin(uri) && uri.query == null && uri.fragment == null) {
            SpeechEndpointMatch.EXACT_ENDPOINT
        } else {
            SpeechEndpointMatch.INVALID_ENDPOINT
        }
    }

    fun parseHeader(value: String?): SpeechRequestParseResult {
        if (value.isNullOrEmpty()) return invalid("Missing $REQUEST_HEADER header")
        if (value.length > MAX_HEADER_ASCII_BYTES || !value.all { it.code in 0x21..0x7e }) {
            return invalid("Local speech request header is too large or contains invalid characters")
        }
        if (!base64UrlPattern.matches(value)) {
            return invalid("Local speech request header is not unpadded base64url")
        }

        val decoded = try {
            Base64.getUrlDecoder().decode(value)
        } catch (_: IllegalArgumentException) {
            return invalid("Local speech request header is not valid base64url")
        }
        if (decoded.isEmpty() || decoded.size > MAX_DECODED_JSON_BYTES) {
            return invalid("Decoded local speech request has an invalid size")
        }
        val jsonText = try {
            StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(decoded))
                .toString()
        } catch (_: CharacterCodingException) {
            return invalid("Local speech request is not valid UTF-8")
        }
        val json = try {
            val tokens = JSONTokener(jsonText)
            val value = tokens.nextValue()
            if (value !is JSONObject || tokens.nextClean() != '\u0000') {
                return invalid("Local speech request is not one complete JSON object")
            }
            value
        } catch (_: JSONException) {
            return invalid("Local speech request is not valid JSON")
        }
        if (json.keySetCompat() != expectedKeys) {
            return invalid("Local speech request has unexpected or missing fields")
        }

        val synthesisRequestId = json.opt("synthesisRequestId") as? String
            ?: return invalid("Local speech request ID must be a string")
        if (!NativeSynthesisCoordinator.isValidRequestId(synthesisRequestId)) {
            return invalid("Local speech request ID is invalid")
        }

        val text = json.opt("text") as? String
            ?: return invalid("Local speech request text must be a string")
        val trimmedText = text.trim()
        if (trimmedText.isEmpty()) return invalid("Local speech request text must not be blank")
        if (trimmedText.codePointCount(0, trimmedText.length) > MAX_TEXT_CODE_POINTS ||
            trimmedText.toByteArray(Charsets.UTF_8).size > MAX_TEXT_UTF8_BYTES
        ) {
            return invalid("Local speech request text is too long")
        }
        if (!hasValidSurrogates(trimmedText) || trimmedText.any {
                it.isISOControl() && it !in "\n\r\t"
            }
        ) {
            return invalid("Local speech request text contains unsupported characters")
        }

        if (json.opt("language") != "english") {
            return invalid("Only English local speech requests are supported")
        }
        val speedValue = json.opt("speed")
        if (speedValue !is Number) return invalid("Local speech speed must be a number")
        val speed = speedValue.toDouble()
        if (!speed.isFinite() || speed !in MIN_SPEED..MAX_SPEED) {
            return invalid("Local speech speed must be between $MIN_SPEED and $MAX_SPEED")
        }
        return SpeechRequestParseResult.Valid(ParsedSpeechRequest(synthesisRequestId, trimmedText, speed))
    }

    private fun hasValidSurrogates(value: String): Boolean {
        var index = 0
        while (index < value.length) {
            when {
                Character.isHighSurrogate(value[index]) -> {
                    if (index + 1 >= value.length || !Character.isLowSurrogate(value[index + 1])) return false
                    index += 2
                }
                Character.isLowSurrogate(value[index]) -> return false
                else -> index++
            }
        }
        return true
    }

    private fun invalid(message: String) = SpeechRequestParseResult.Invalid(
        SpeechRequestFailure(400, "Bad Request", message)
    )
}

/** Implements the sole synthetic HTTP endpoint exposed by the Android host. */
internal class NativeSpeechEndpoint(
    private val runtime: QwenNativeRuntime,
    private val synthesisSession: NativeSynthesisSession,
) {
    fun intercept(request: WebResourceRequest, match: SpeechEndpointMatch): WebResourceResponse {
        if (match != SpeechEndpointMatch.EXACT_ENDPOINT) {
            return errorResponse(404, "Not Found", "Local speech endpoint not found")
        }
        if (request.method != "GET") {
            return errorResponse(
                statusCode = 405,
                reasonPhrase = "Method Not Allowed",
                message = "Local speech endpoint accepts GET only",
                extraHeaders = mapOf("Allow" to "GET"),
            )
        }

        val header = request.requestHeaders.entries
            .firstOrNull { (name, _) -> name.equals(NativeSpeechRequestParser.REQUEST_HEADER, ignoreCase = true) }
            ?.value
        return when (val parsed = NativeSpeechRequestParser.parseHeader(header)) {
            is SpeechRequestParseResult.Invalid -> errorResponse(parsed.failure)
            is SpeechRequestParseResult.Valid -> render(parsed.request)
        }
    }

    /** Legacy callbacks cannot carry the required header and therefore always fail closed. */
    fun rejectHeaderlessLegacyRequest(): WebResourceResponse =
        errorResponse(400, "Bad Request", "Local speech request header is unavailable")

    private fun render(request: ParsedSpeechRequest): WebResourceResponse {
        return when (val admission = synthesisSession.begin(request.synthesisRequestId)) {
            is SynthesisAdmission.Accepted -> renderAccepted(request, admission.lease)
            SynthesisAdmission.Busy -> errorResponse(
                429,
                "Too Many Requests",
                "Another local Qwen sentence is still finishing",
                mapOf("Retry-After" to "1"),
            )
            SynthesisAdmission.Cancelled ->
                errorResponse(409, "Conflict", "Local Qwen synthesis was cancelled before it started")
            SynthesisAdmission.Closed ->
                errorResponse(503, "Service Unavailable", "The local speech session is closed")
            SynthesisAdmission.Duplicate ->
                errorResponse(409, "Conflict", "Local speech request ID has already been used")
            SynthesisAdmission.Invalid ->
                errorResponse(400, "Bad Request", "Local speech request ID is invalid")
        }
    }

    private fun renderAccepted(
        request: ParsedSpeechRequest,
        lease: NativeSynthesisLease,
    ): WebResourceResponse {
        return try {
            val rendered = runBlocking(lease.cancellationParent) {
                runtime.renderSentence(
                    QwenSentenceRequest(
                        text = request.text,
                        language = QwenLanguage.ENGLISH,
                        speed = request.speed,
                    ),
                    cancellationSignal = lease,
                )
            }
            WebResourceResponse(
                "audio/wav",
                null,
                200,
                "OK",
                immutableResponseHeaders(
                    mapOf(
                        "Content-Length" to rendered.wavBytes.size.toString(),
                        "X-Lantern-Sample-Rate" to rendered.sampleRateHz.toString(),
                        "X-Lantern-Duration-Seconds" to rendered.durationSeconds.toString(),
                    )
                ),
                ByteArrayInputStream(rendered.wavBytes),
            )
        } catch (error: QwenRuntimeException) {
            val status = when (error.code) {
                "MODEL_NOT_READY", "MODEL_NOT_INSTALLED" -> 409
                "NATIVE_UNAVAILABLE" -> 503
                "MODEL_OUT_OF_MEMORY" -> 507
                "AUDIO_LIMIT_EXCEEDED" -> 413
                else -> 500
            }
            errorResponse(status, reasonFor(status), safePublicMessage(error.message, "Local Qwen synthesis failed"))
        } catch (_: CancellationException) {
            errorResponse(409, "Conflict", "Local Qwen synthesis was cancelled")
        } catch (error: IllegalArgumentException) {
            errorResponse(400, "Bad Request", safePublicMessage(error.message, "Invalid local speech request"))
        } catch (_: OutOfMemoryError) {
            errorResponse(507, "Insufficient Storage", "The device does not have enough memory for local speech")
        } catch (_: Throwable) {
            errorResponse(500, "Internal Server Error", "Local Qwen synthesis failed")
        } finally {
            synthesisSession.complete(lease)
        }
    }

    private fun errorResponse(failure: SpeechRequestFailure): WebResourceResponse =
        errorResponse(failure.statusCode, failure.reasonPhrase, failure.message)

    private fun errorResponse(
        statusCode: Int,
        reasonPhrase: String,
        message: String,
        extraHeaders: Map<String, String> = emptyMap(),
    ): WebResourceResponse {
        val body = message.toByteArray(Charsets.UTF_8)
        return WebResourceResponse(
            "text/plain",
            "UTF-8",
            statusCode,
            reasonPhrase,
            immutableResponseHeaders(extraHeaders + ("Content-Length" to body.size.toString())),
            ByteArrayInputStream(body),
        )
    }

    private fun immutableResponseHeaders(additional: Map<String, String>): Map<String, String> =
        mapOf(
            "Cache-Control" to "no-store, max-age=0",
            "Pragma" to "no-cache",
            "X-Content-Type-Options" to "nosniff",
            "Cross-Origin-Resource-Policy" to "same-origin",
        ) + additional

    private fun reasonFor(status: Int): String = when (status) {
        409 -> "Conflict"
        413 -> "Content Too Large"
        429 -> "Too Many Requests"
        503 -> "Service Unavailable"
        507 -> "Insufficient Storage"
        else -> "Internal Server Error"
    }

    private fun safePublicMessage(message: String?, fallback: String): String = message
        ?.replace(Regex("[\\r\\n\\t]+"), " ")
        ?.trim()
        ?.takeIf(String::isNotEmpty)
        ?.take(500)
        ?: fallback
}
