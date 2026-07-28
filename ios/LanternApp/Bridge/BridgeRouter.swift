import Foundation

@MainActor
protocol BridgeEventDispatching: AnyObject {
    func dispatch(_ event: BridgeEventEnvelope, to receiver: String)
}

actor BridgeRouter {
    private struct EventOwner: Sendable {
        let requestID: String
        let sessionID: String?
        let receiver: String
    }

    private let engine: any LocalTTSEngine
    private weak var dispatcher: (any BridgeEventDispatching)?
    private var eventTask: Task<Void, Never>?
    private var modelOwner: EventOwner?
    private var activeSessionID: String?
    private var sessionOwners: [String: EventOwner] = [:]
    private var generationOwners: [UUID: EventOwner] = [:]
    private var currentGeneration: [String: UUID] = [:]
    private var pendingEnqueueOwners: [String: EventOwner] = [:]
    private var retiredGenerations: Set<UUID> = []
    private var sessionTransitionID: UUID?

    init(engine: any LocalTTSEngine, dispatcher: any BridgeEventDispatching) {
        self.engine = engine
        self.dispatcher = dispatcher
    }

    func startEventPump() {
        guard eventTask == nil else { return }
        let events = engine.events
        eventTask = Task { [weak self] in
            for await event in events {
                guard !Task.isCancelled else { return }
                await self?.consumeEngineEvent(event)
            }
        }
    }

    func handle(_ request: BridgeRequest) async -> BridgeReply {
        guard request.protocolName == BridgeCodec.protocolName, request.type == "request" else {
            return .failure(requestId: request.requestId, code: .malformedRequest, message: "Wrong bridge protocol or message type")
        }
        guard request.version == BridgeCodec.version else {
            return .failure(requestId: request.requestId, code: .unsupportedVersion, message: "Unsupported bridge version \(request.version)")
        }
        guard !request.requestId.isEmpty, !request.eventReceiver.isEmpty else {
            return .failure(requestId: request.requestId, code: .malformedRequest, message: "requestId and eventReceiver must not be empty")
        }
        guard let method = BridgeMethod(rawValue: request.method) else {
            return .failure(requestId: request.requestId, code: .unknownMethod, message: "Unknown method \(request.method)")
        }

        do {
            switch method {
            case .modelStatus:
                try requireGlobal(request)
                try validate(request.params, allowed: [], required: [])
                let status = try await engine.modelStatus()
                return .success(requestId: request.requestId, result: .object([
                    "state": .string(status.state.rawValue),
                    "progress": status.progress.map(BridgeValue.number) ?? .null,
                    "detail": status.detail.map(BridgeValue.string) ?? .null
                ]))

            case .modelDownload:
                try requireGlobal(request)
                try validate(request.params, allowed: ["revision"], required: [])
                modelOwner = owner(for: request)
                try await engine.downloadModel(revision: try optionalString("revision", in: request.params))
                return .success(requestId: request.requestId)

            case .modelCancelDownload:
                try requireGlobal(request)
                try validate(request.params, allowed: [], required: [])
                modelOwner = nil
                try await engine.cancelModelDownload()
                return .success(requestId: request.requestId)

            case .modelDelete:
                try requireGlobal(request)
                try validate(request.params, allowed: [], required: [])
                modelOwner = nil
                try await engine.deleteModel()
                return .success(requestId: request.requestId)

            case .ttsPrepare:
                try requireGlobal(request)
                try validate(request.params, allowed: ["modelRevision"], required: [])
                modelOwner = owner(for: request)
                try await engine.prepare(modelRevision: try optionalString("modelRevision", in: request.params))
                return .success(requestId: request.requestId)

            case .ttsStart:
                let sessionID = try requireSession(request)
                try validate(request.params, allowed: ["bookId"], required: [])
                let transitionID = try beginSessionTransition()
                do {
                    if let previousSessionID = activeSessionID {
                        // Stop is transactional: retain the old owner/fence if native audio
                        // could not be stopped, and never start the replacement session.
                        try await engine.stop(sessionID: previousSessionID)
                        try requireTransition(transitionID)
                        activeSessionID = nil
                        sessionOwners[previousSessionID] = nil
                        retireSession(previousSessionID)
                    }
                    try await engine.start(sessionID: sessionID)
                    try requireTransition(transitionID)
                    activeSessionID = sessionID
                    sessionOwners[sessionID] = owner(for: request)
                    endSessionTransition(transitionID)
                    return .success(requestId: request.requestId)
                } catch {
                    endSessionTransition(transitionID)
                    throw error
                }

            case .ttsEnqueue:
                let sessionID = try requireSession(request)
                try requireNoSessionTransition()
                guard let sessionOwner = sessionOwners[sessionID] else {
                    throw BridgeFailure(code: .staleRequest, message: "The TTS session is not active")
                }
                try validate(
                    request.params,
                    allowed: ["text", "sentenceId", "index", "language", "utteranceId"],
                    required: ["text"]
                )
                pendingEnqueueOwners[sessionID] = sessionOwner
                let receipt: LocalTTSReceipt
                do {
                    receipt = try await engine.enqueue(sessionID: sessionID, utterance: try decodeUtterance(request.params))
                } catch {
                    pendingEnqueueOwners[sessionID] = nil
                    throw error
                }
                generationOwners[receipt.generationID] = sessionOwner
                pendingEnqueueOwners[sessionID] = nil
                return .success(requestId: request.requestId, result: .object([
                    "generationId": .string(receipt.generationID.uuidString)
                ]))

            case .ttsPause:
                let sessionID = try requireSession(request)
                try validate(request.params, allowed: [], required: [])
                try requireNoSessionTransition()
                try requireActive(sessionID)
                try await engine.pause(sessionID: sessionID)
                return .success(requestId: request.requestId)

            case .ttsResume:
                let sessionID = try requireSession(request)
                try validate(request.params, allowed: [], required: [])
                try requireNoSessionTransition()
                try requireActive(sessionID)
                try await engine.resume(sessionID: sessionID)
                return .success(requestId: request.requestId)

            case .ttsStop:
                let sessionID = try requireSession(request)
                try validate(request.params, allowed: [], required: [])
                try requireActive(sessionID)
                let transitionID = try beginSessionTransition()
                do {
                    // Do not fence a session until the engine confirms its audio stopped.
                    try await engine.stop(sessionID: sessionID)
                    try requireTransition(transitionID)
                    activeSessionID = nil
                    sessionOwners[sessionID] = nil
                    retireSession(sessionID)
                    endSessionTransition(transitionID)
                    return .success(requestId: request.requestId)
                } catch {
                    endSessionTransition(transitionID)
                    throw error
                }

            case .ttsSetVoice:
                try requireGlobal(request)
                try validate(request.params, allowed: ["voice"], required: ["voice"])
                let voice = try string("voice", in: request.params)
                guard !voice.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                    throw BridgeFailure(code: .invalidParameters, message: "voice must not be empty")
                }
                try await engine.setVoice(voice)
                return .success(requestId: request.requestId)

            case .ttsSetSpeed:
                try requireGlobal(request)
                try validate(request.params, allowed: ["speed"], required: ["speed"])
                let speed = try number("speed", in: request.params)
                guard speed > 0 else { throw BridgeFailure(code: .invalidParameters, message: "speed must be positive") }
                try await engine.setSpeed(speed)
                return .success(requestId: request.requestId)
            }
        } catch let failure as BridgeFailure {
            return .failure(requestId: request.requestId, code: failure.code, message: failure.message)
        } catch let error as LocalTTSEngineError {
            let mapped = mapEngineError(error)
            return .failure(requestId: request.requestId, code: mapped.code, message: mapped.message)
        } catch {
            return .failure(requestId: request.requestId, code: .internalError, message: "Native TTS operation failed")
        }
    }

    // Internal for deterministic stale-event tests.
    func consumeEngineEvent(_ event: LocalTTSEngineEvent) async {
        switch event {
        case .modelProgress(let loaded, let total, let file):
            guard let owner = modelOwner else { return }
            var payload: [String: BridgeValue] = ["loaded": .number(loaded), "total": .number(total)]
            if let file { payload["file"] = .string(file) }
            await emit("model.progress", owner: owner, payload: payload)
        case .modelReady(let revision):
            guard let owner = modelOwner else { return }
            await emit("model.ready", owner: owner, payload: ["modelRevision": .string(revision)])
            modelOwner = nil
        case .buffering(let sessionID, let generationID, let seconds):
            guard activeSessionID == sessionID,
                  !retiredGenerations.contains(generationID),
                  let sessionOwner = sessionOwners[sessionID] else { return }
            if generationOwners[generationID] == nil {
                guard pendingEnqueueOwners[sessionID] != nil else { return }
                generationOwners[generationID] = sessionOwner
            }
            fence(sessionID, to: generationID)
            await emit("tts.buffering", owner: sessionOwner, payload: ["bufferedSeconds": .number(seconds)])
        case .started(let sessionID, let generationID, let seconds):
            guard let owner = currentOwner(sessionID, generationID) else { return }
            var payload: [String: BridgeValue] = [:]
            if let seconds { payload["positionSeconds"] = .number(seconds) }
            await emit("tts.started", owner: owner, payload: payload)
        case .position(let sessionID, let generationID, let seconds, let sentenceID):
            guard let owner = currentOwner(sessionID, generationID) else { return }
            var payload: [String: BridgeValue] = ["positionSeconds": .number(seconds)]
            if let sentenceID { payload["sentenceId"] = .string(sentenceID) }
            await emit("tts.position", owner: owner, payload: payload)
        case .ended(let sessionID, let generationID, let reason):
            guard let owner = currentOwner(sessionID, generationID) else { return }
            var payload: [String: BridgeValue] = [:]
            if let reason { payload["reason"] = .string(reason) }
            await emit("tts.ended", owner: owner, payload: payload)
            // `tts.ended` means the current queue drained. The session remains
            // open for later enqueue calls until stop or a replacement start.
            fence(sessionID, to: nil)
        case .sentenceStarted(let sessionID, let generationID, let sentenceID, let index):
            guard let owner = currentOwner(sessionID, generationID) else { return }
            await emit("reader.sentenceStarted", owner: owner, payload: [
                "sentenceId": .string(sentenceID), "index": .number(Double(index))
            ])
        case .error(let sessionID, let generationID, let code, let message):
            let owner: EventOwner?
            if let sessionID, let generationID { owner = currentOwner(sessionID, generationID) }
            else if let sessionID { owner = sessionOwners[sessionID] }
            else { owner = modelOwner }
            guard let owner else { return }
            await emit("error", owner: owner, payload: ["code": .string(code), "message": .string(message)])
        }
    }

    private func emit(_ name: String, owner: EventOwner, payload: [String: BridgeValue]) async {
        let event = BridgeEventEnvelope(
            protocolName: BridgeCodec.protocolName,
            version: BridgeCodec.version,
            type: "event",
            event: name,
            requestId: owner.requestID,
            sessionId: owner.sessionID,
            payload: payload
        )
        await dispatcher?.dispatch(event, to: owner.receiver)
    }

    private func owner(for request: BridgeRequest) -> EventOwner {
        .init(requestID: request.requestId, sessionID: request.sessionId, receiver: request.eventReceiver)
    }

    private func currentOwner(_ sessionID: String, _ generationID: UUID) -> EventOwner? {
        guard activeSessionID == sessionID, currentGeneration[sessionID] == generationID else { return nil }
        return generationOwners[generationID]
    }

    private func fence(_ sessionID: String, to generationID: UUID?) {
        if let old = currentGeneration[sessionID], old != generationID {
            generationOwners[old] = nil
            retiredGenerations.insert(old)
        }
        currentGeneration[sessionID] = generationID
    }

    private func retireSession(_ sessionID: String) {
        pendingEnqueueOwners[sessionID] = nil
        let generationIDs = generationOwners.compactMap { generationID, owner in
            owner.sessionID == sessionID ? generationID : nil
        }
        for generationID in generationIDs {
            generationOwners[generationID] = nil
            retiredGenerations.insert(generationID)
        }
        fence(sessionID, to: nil)
    }

    private func requireGlobal(_ request: BridgeRequest) throws {
        guard request.sessionId == nil else {
            throw BridgeFailure(code: .invalidParameters, message: "This method does not accept sessionId")
        }
    }

    private func requireSession(_ request: BridgeRequest) throws -> String {
        guard let sessionID = request.sessionId, !sessionID.isEmpty else {
            throw BridgeFailure(code: .missingSession, message: "This method requires sessionId")
        }
        return sessionID
    }

    private func requireActive(_ sessionID: String) throws {
        guard activeSessionID == sessionID, sessionOwners[sessionID] != nil else {
            throw BridgeFailure(code: .staleRequest, message: "The TTS session is not active")
        }
    }

    private func beginSessionTransition() throws -> UUID {
        try requireNoSessionTransition()
        let transitionID = UUID()
        sessionTransitionID = transitionID
        return transitionID
    }

    private func requireNoSessionTransition() throws {
        guard sessionTransitionID == nil else {
            throw BridgeFailure(code: .invalidState, message: "A TTS session transition is already in progress")
        }
    }

    private func requireTransition(_ transitionID: UUID) throws {
        guard sessionTransitionID == transitionID else {
            throw BridgeFailure(code: .staleRequest, message: "The TTS session transition was superseded")
        }
    }

    private func endSessionTransition(_ transitionID: UUID) {
        if sessionTransitionID == transitionID { sessionTransitionID = nil }
    }

    private func validate(_ params: [String: BridgeValue], allowed: Set<String>, required: Set<String>) throws {
        let keys = Set(params.keys)
        let unknown = keys.subtracting(allowed)
        guard unknown.isEmpty else {
            throw BridgeFailure(code: .invalidParameters, message: "Unknown parameters: \(unknown.sorted().joined(separator: ", "))")
        }
        let missing = required.subtracting(keys)
        guard missing.isEmpty else {
            throw BridgeFailure(code: .invalidParameters, message: "Missing parameters: \(missing.sorted().joined(separator: ", "))")
        }
    }

    private func decodeUtterance(_ params: [String: BridgeValue]) throws -> LocalTTSUtterance {
        let text = try string("text", in: params)
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw BridgeFailure(code: .invalidParameters, message: "text must not be empty")
        }
        return .init(
            utteranceID: try optionalString("utteranceId", in: params),
            sentenceID: try optionalString("sentenceId", in: params),
            index: try optionalInteger("index", in: params),
            text: text,
            language: try optionalString("language", in: params)
        )
    }

    private func string(_ key: String, in params: [String: BridgeValue]) throws -> String {
        guard case .string(let value) = params[key] else {
            throw BridgeFailure(code: .invalidParameters, message: "\(key) must be a string")
        }
        return value
    }

    private func optionalString(_ key: String, in params: [String: BridgeValue]) throws -> String? {
        guard params[key] != nil else { return nil }
        return try string(key, in: params)
    }

    private func number(_ key: String, in params: [String: BridgeValue]) throws -> Double {
        guard case .number(let value) = params[key], value.isFinite else {
            throw BridgeFailure(code: .invalidParameters, message: "\(key) must be a finite number")
        }
        return value
    }

    private func optionalInteger(_ key: String, in params: [String: BridgeValue]) throws -> Int? {
        guard params[key] != nil else { return nil }
        let value = try number(key, in: params)
        guard value.rounded() == value, value >= 0, value <= Double(Int.max) else {
            throw BridgeFailure(code: .invalidParameters, message: "\(key) must be a non-negative integer")
        }
        return Int(value)
    }

    private func mapEngineError(_ error: LocalTTSEngineError) -> BridgeErrorPayload {
        switch error {
        case .cancelled: .init(code: .cancelled, message: "Operation cancelled")
        case .invalidArgument(let message): .init(code: .invalidParameters, message: message)
        case .modelUnavailable: .init(code: .invalidState, message: "Local model is unavailable")
        case .sessionNotPrepared: .init(code: .invalidState, message: "TTS session is not prepared")
        case .invalidState(let message): .init(code: .invalidState, message: message)
        }
    }
}
