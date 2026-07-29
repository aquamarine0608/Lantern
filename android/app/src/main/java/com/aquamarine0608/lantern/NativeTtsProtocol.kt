package com.aquamarine0608.lantern

import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener

internal data class NativeTtsRequest(
    val requestId: String,
    val method: String,
    val sessionId: String?,
    val params: JSONObject,
)

internal data class NativeProtocolFailure(
    val code: String,
    val message: String,
    val requestId: String = NativeTtsProtocol.REJECTED_REQUEST_ID,
)

internal sealed interface NativeRequestDecodeResult {
    data class Valid(val request: NativeTtsRequest) : NativeRequestDecodeResult
    data class Invalid(val failure: NativeProtocolFailure) : NativeRequestDecodeResult
}

/** Strict JSON-only control protocol shared by the WebMessage listener and command router. */
internal object NativeTtsProtocol {
    const val NAME = "lantern.native-tts"
    const val VERSION = 1
    const val REJECTED_REQUEST_ID = "rejected"
    const val MAX_MESSAGE_UTF8_BYTES = 16 * 1024

    private const val MAX_REQUEST_ID_BYTES = 256
    private const val MAX_METHOD_BYTES = 80
    private const val MAX_SESSION_ID_BYTES = 256
    private const val MAX_RECEIVER_BYTES = 256

    private val requiredEnvelopeKeys = setOf(
        "protocol",
        "version",
        "type",
        "requestId",
        "method",
        "params",
        "eventReceiver",
    )
    private val allowedEnvelopeKeys = requiredEnvelopeKeys + "sessionId"
    private val methodPattern = Regex("^[a-z][A-Za-z0-9]*(?:\\.[A-Za-z0-9]+)+$")
    private val receiverPattern = Regex("^[A-Za-z_$][A-Za-z0-9_$]{0,255}$")

    fun decodeRequest(raw: String?): NativeRequestDecodeResult {
        if (raw == null) return invalid("MALFORMED_MESSAGE", "Native request must be a JSON string")
        if (raw.length > MAX_MESSAGE_UTF8_BYTES || raw.toByteArray(Charsets.UTF_8).size > MAX_MESSAGE_UTF8_BYTES) {
            return invalid("MESSAGE_TOO_LARGE", "Native request exceeds $MAX_MESSAGE_UTF8_BYTES UTF-8 bytes")
        }

        val envelope = try {
            val tokens = JSONTokener(raw)
            val value = tokens.nextValue()
            if (value !is JSONObject || tokens.nextClean() != '\u0000') {
                return invalid("MALFORMED_JSON", "Native request is not one complete JSON object")
            }
            value
        } catch (_: JSONException) {
            return invalid("MALFORMED_JSON", "Native request is not valid JSON")
        }
        val requestId = envelope.opt("requestId")
            .takeIf { it is String && isBoundedPrintableAscii(it, MAX_REQUEST_ID_BYTES) }
            ?.toString()
            ?: REJECTED_REQUEST_ID

        val keys = envelope.keySetCompat()
        if (!keys.containsAll(requiredEnvelopeKeys) || !allowedEnvelopeKeys.containsAll(keys)) {
            return invalid("INVALID_ENVELOPE", "Native request has unexpected or missing fields", requestId)
        }
        if (envelope.opt("protocol") != NAME || envelope.opt("type") != "request") {
            return invalid("INVALID_ENVELOPE", "Native request has the wrong protocol envelope", requestId)
        }
        val version = envelope.opt("version")
        if (version !is Int || version != VERSION) {
            return invalid("UNSUPPORTED_VERSION", "Native request protocol version is unsupported", requestId)
        }
        if (requestId == REJECTED_REQUEST_ID || envelope.opt("requestId") != requestId) {
            return invalid("INVALID_REQUEST_ID", "Native request ID is invalid")
        }

        val method = envelope.opt("method") as? String
        if (method == null || !isBoundedPrintableAscii(method, MAX_METHOD_BYTES) ||
            !methodPattern.matches(method)
        ) {
            return invalid("INVALID_METHOD", "Native request method is invalid", requestId)
        }
        val params = envelope.opt("params") as? JSONObject
            ?: return invalid("INVALID_PARAMS", "Native request params must be an object", requestId)

        val receiver = envelope.opt("eventReceiver") as? String
        if (receiver == null || receiver.toByteArray(Charsets.UTF_8).size > MAX_RECEIVER_BYTES ||
            !receiverPattern.matches(receiver)
        ) {
            return invalid("INVALID_RECEIVER", "Native event receiver is invalid", requestId)
        }

        val sessionValue = envelope.opt("sessionId")
        val sessionId = when (sessionValue) {
            null, JSONObject.NULL -> null
            is String -> sessionValue.takeIf {
                isBoundedPrintableAscii(it, MAX_SESSION_ID_BYTES)
            } ?: return invalid("INVALID_SESSION_ID", "Native session ID is invalid", requestId)
            else -> return invalid("INVALID_SESSION_ID", "Native session ID must be a string or null", requestId)
        }

        return NativeRequestDecodeResult.Valid(
            NativeTtsRequest(
                requestId = requestId,
                method = method,
                sessionId = sessionId,
                params = params,
            )
        )
    }

    fun successReply(requestId: String, result: JSONObject = JSONObject()): String =
        JSONObject()
            .put("protocol", NAME)
            .put("version", VERSION)
            .put("type", "reply")
            .put("requestId", requestId)
            .put("ok", true)
            .put("result", result)
            .toString()

    fun errorReply(failure: NativeProtocolFailure): String =
        JSONObject()
            .put("protocol", NAME)
            .put("version", VERSION)
            .put("type", "reply")
            .put("requestId", failure.requestId)
            .put("ok", false)
            .put("error", JSONObject().put("code", failure.code).put("message", failure.message))
            .toString()

    fun event(
        requestId: String,
        name: String,
        payload: JSONObject,
        sessionId: String? = null,
    ): String = JSONObject()
        .put("protocol", NAME)
        .put("version", VERSION)
        .put("type", "event")
        .put("requestId", requestId)
        .put("event", name)
        .put("sessionId", sessionId ?: JSONObject.NULL)
        .put("payload", payload)
        .toString()

    fun requireOnlyParams(params: JSONObject, allowed: Set<String>): NativeProtocolFailure? {
        val keys = params.keySetCompat()
        return if (allowed.containsAll(keys)) null else {
            NativeProtocolFailure("INVALID_PARAMS", "Request params contain unsupported fields")
        }
    }

    fun emptyParamsFailure(params: JSONObject): NativeProtocolFailure? =
        requireOnlyParams(params, emptySet())

    private fun invalid(
        code: String,
        message: String,
        requestId: String = REJECTED_REQUEST_ID,
    ) = NativeRequestDecodeResult.Invalid(NativeProtocolFailure(code, message, requestId))

    private fun isBoundedPrintableAscii(value: String, maxBytes: Int): Boolean =
        value.isNotEmpty() && value.length <= maxBytes && value.all { it.code in 0x21..0x7e }
}

internal fun JSONObject.keySetCompat(): Set<String> {
    val keys = mutableSetOf<String>()
    val iterator = keys()
    while (iterator.hasNext()) keys += iterator.next()
    return keys
}
