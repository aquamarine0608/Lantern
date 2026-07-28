import Foundation

enum BridgeValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([BridgeValue])
    case object([String: BridgeValue])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Double.self) { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([BridgeValue].self) { self = .array(value) }
        else if let value = try? container.decode([String: BridgeValue].self) { self = .object(value) }
        else { throw DecodingError.dataCorruptedError(in: container, debugDescription: "Unsupported JSON value") }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

enum BridgeMethod: String, Sendable {
    case modelStatus = "model.status"
    case modelDownload = "model.download"
    case modelCancelDownload = "model.cancelDownload"
    case modelDelete = "model.delete"
    case ttsPrepare = "tts.prepare"
    case ttsStart = "tts.start"
    case ttsEnqueue = "tts.enqueue"
    case ttsPause = "tts.pause"
    case ttsResume = "tts.resume"
    case ttsStop = "tts.stop"
    case ttsSetVoice = "tts.setVoice"
    case ttsSetSpeed = "tts.setSpeed"
}

struct BridgeRequest: Codable, Sendable, Equatable {
    let protocolName: String
    let version: Int
    let type: String
    let requestId: String
    let sessionId: String?
    let method: String
    let params: [String: BridgeValue]
    let eventReceiver: String

    enum CodingKeys: String, CodingKey {
        case protocolName = "protocol"
        case version, type, requestId, sessionId, method, params, eventReceiver
    }
}

enum BridgeErrorCode: String, Codable, Sendable, Equatable {
    case malformedRequest
    case unsupportedVersion
    case unknownMethod
    case invalidParameters
    case missingSession
    case invalidState
    case staleRequest
    case cancelled
    case internalError
}

struct BridgeErrorPayload: Codable, Sendable, Equatable {
    let code: BridgeErrorCode
    let message: String
}

struct BridgeReply: Codable, Sendable, Equatable {
    let protocolName: String
    let version: Int
    let type: String
    let requestId: String
    let ok: Bool
    let result: BridgeValue?
    let error: BridgeErrorPayload?

    enum CodingKeys: String, CodingKey {
        case protocolName = "protocol"
        case version, type, requestId, ok, result, error
    }

    static func success(requestId: String, result: BridgeValue = .object([:])) -> Self {
        .init(protocolName: BridgeCodec.protocolName, version: BridgeCodec.version, type: "reply", requestId: requestId, ok: true, result: result, error: nil)
    }

    static func failure(requestId: String, code: BridgeErrorCode, message: String) -> Self {
        .init(
            protocolName: BridgeCodec.protocolName,
            version: BridgeCodec.version,
            type: "reply",
            requestId: requestId,
            ok: false,
            result: nil,
            error: .init(code: code, message: message)
        )
    }
}

struct BridgeEventEnvelope: Codable, Sendable, Equatable {
    let protocolName: String
    let version: Int
    let type: String
    let event: String
    let requestId: String?
    let sessionId: String?
    let payload: [String: BridgeValue]

    enum CodingKeys: String, CodingKey {
        case protocolName = "protocol"
        case version, type, event, requestId, sessionId, payload
    }
}

struct BridgeFailure: Error, Sendable, Equatable {
    let code: BridgeErrorCode
    let message: String
}

enum BridgeCodec {
    static let protocolName = "lantern.native-tts"
    static let version = 1
    private static let requestKeys: Set<String> = [
        "protocol", "version", "type", "requestId", "sessionId", "method", "params", "eventReceiver"
    ]

    static func decodeRequest(from body: Any) throws -> BridgeRequest {
        guard let object = body as? [String: Any] else {
            throw BridgeFailure(code: .malformedRequest, message: "Bridge command must be a JSON object")
        }
        let unknown = Set(object.keys).subtracting(requestKeys)
        guard unknown.isEmpty else {
            throw BridgeFailure(code: .malformedRequest, message: "Unknown request fields: \(unknown.sorted().joined(separator: ", "))")
        }
        guard JSONSerialization.isValidJSONObject(object) else {
            throw BridgeFailure(code: .malformedRequest, message: "Bridge command is not valid JSON")
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: object)
            return try JSONDecoder().decode(BridgeRequest.self, from: data)
        } catch let failure as BridgeFailure {
            throw failure
        } catch {
            throw BridgeFailure(code: .malformedRequest, message: "Invalid request envelope")
        }
    }

    static func jsonObject<T: Encodable>(_ value: T) throws -> Any {
        let data = try JSONEncoder().encode(value)
        return try JSONSerialization.jsonObject(with: data)
    }
}
