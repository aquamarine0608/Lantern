import Foundation

actor MockLocalTTSEngine: LocalTTSEngine {
    struct Configuration: Sendable {
        let automaticPlayback: Bool
        let stepNanoseconds: UInt64
        let injectedStopFailures: Int
        let blockNextStop: Bool

        init(
            automaticPlayback: Bool = true,
            stepNanoseconds: UInt64 = 20_000_000,
            injectedStopFailures: Int = 0,
            blockNextStop: Bool = false
        ) {
            self.automaticPlayback = automaticPlayback
            self.stepNanoseconds = stepNanoseconds
            self.injectedStopFailures = max(0, injectedStopFailures)
            self.blockNextStop = blockNextStop
        }
    }

    private struct Pending: Sendable {
        let generationID: UUID
        let utterance: LocalTTSUtterance
    }

    private struct Session: Sendable {
        var active: Pending?
        var queue: [Pending] = []
        var paused = false
    }

    nonisolated let events: AsyncStream<LocalTTSEngineEvent>
    private let continuation: AsyncStream<LocalTTSEngineEvent>.Continuation
    private let configuration: Configuration
    private var modelState: LocalTTSModelState = .ready
    private var modelRevision = "mock-qwen-0.6b-v1"
    private var voice = "mock-default"
    private var speed = 1.0
    private var sessions: [String: Session] = [:]
    private var positions: [UUID: Double] = [:]
    private var playbackTasks: [UUID: Task<Void, Never>] = [:]
    private var generationCounter: UInt64 = 0
    private var remainingStopFailures: Int
    private var shouldBlockNextStop: Bool
    private var blockedStopContinuation: CheckedContinuation<Void, Never>?

    init(configuration: Configuration = .init()) {
        let pair = AsyncStream.makeStream(of: LocalTTSEngineEvent.self)
        events = pair.stream
        continuation = pair.continuation
        self.configuration = configuration
        remainingStopFailures = configuration.injectedStopFailures
        shouldBlockNextStop = configuration.blockNextStop
    }

    func modelStatus() async throws -> LocalTTSModelStatus {
        .init(state: modelState, progress: modelState == .ready ? 1 : nil, detail: modelRevision)
    }

    func downloadModel(revision: String?) async throws {
        if let revision, !revision.isEmpty { modelRevision = revision }
        modelState = .downloading
        continuation.yield(.modelProgress(loaded: 0, total: 100, file: nil))
        continuation.yield(.modelProgress(loaded: 50, total: 100, file: "mock-model.bin"))
        continuation.yield(.modelProgress(loaded: 100, total: 100, file: "mock-model.bin"))
        modelState = .ready
        continuation.yield(.modelReady(modelRevision: modelRevision))
    }

    func cancelModelDownload() async throws {
        if modelState == .downloading { modelState = .notInstalled }
    }

    func deleteModel() async throws {
        playbackTasks.values.forEach { $0.cancel() }
        playbackTasks.removeAll()
        sessions.removeAll()
        positions.removeAll()
        modelState = .notInstalled
    }

    func prepare(modelRevision requestedRevision: String?) async throws {
        guard modelState == .ready else { throw LocalTTSEngineError.modelUnavailable }
        if let requestedRevision, requestedRevision != modelRevision {
            throw LocalTTSEngineError.invalidState("Requested model revision is not installed")
        }
    }

    func start(sessionID: String) async throws {
        guard modelState == .ready else { throw LocalTTSEngineError.modelUnavailable }
        guard !sessionID.isEmpty else { throw LocalTTSEngineError.invalidArgument("sessionId must not be empty") }
        if let previous = sessions[sessionID]?.active {
            playbackTasks[previous.generationID]?.cancel()
            playbackTasks[previous.generationID] = nil
            positions[previous.generationID] = nil
        }
        sessions[sessionID] = Session()
    }

    func enqueue(sessionID: String, utterance: LocalTTSUtterance) async throws -> LocalTTSReceipt {
        try validate(utterance)
        guard var session = sessions[sessionID] else { throw LocalTTSEngineError.sessionNotPrepared }
        let pending = Pending(generationID: nextGenerationID(), utterance: utterance)
        if session.active == nil {
            session.active = pending
            sessions[sessionID] = session
            activate(pending, sessionID: sessionID)
        } else {
            session.queue.append(pending)
            sessions[sessionID] = session
        }
        return .init(generationID: pending.generationID)
    }

    func pause(sessionID: String) async throws {
        guard var session = sessions[sessionID], session.active != nil else {
            throw LocalTTSEngineError.invalidState("Nothing is playing")
        }
        if let generationID = session.active?.generationID {
            playbackTasks[generationID]?.cancel()
            playbackTasks[generationID] = nil
        }
        session.paused = true
        sessions[sessionID] = session
    }

    func resume(sessionID: String) async throws {
        guard var session = sessions[sessionID], let active = session.active else {
            throw LocalTTSEngineError.invalidState("Nothing is paused")
        }
        session.paused = false
        sessions[sessionID] = session
        if configuration.automaticPlayback, playbackTasks[active.generationID] == nil {
            schedule(active, sessionID: sessionID)
        }
    }

    func stop(sessionID: String) async throws {
        if shouldBlockNextStop {
            shouldBlockNextStop = false
            await withCheckedContinuation { continuation in
                blockedStopContinuation = continuation
            }
        }
        if remainingStopFailures > 0 {
            remainingStopFailures -= 1
            throw LocalTTSEngineError.invalidState("Injected stop failure")
        }
        guard let session = sessions.removeValue(forKey: sessionID) else {
            throw LocalTTSEngineError.sessionNotPrepared
        }
        if let active = session.active {
            playbackTasks[active.generationID]?.cancel()
            playbackTasks[active.generationID] = nil
            positions[active.generationID] = nil
        }
    }

    func hasSession(_ sessionID: String) -> Bool { sessions[sessionID] != nil }

    func isPlaybackScheduled(sessionID: String) -> Bool {
        guard let generationID = sessions[sessionID]?.active?.generationID else { return false }
        return playbackTasks[generationID] != nil
    }

    func waitUntilStopIsBlocked() async {
        while blockedStopContinuation == nil { await Task.yield() }
    }

    func releaseBlockedStop() {
        let continuation = blockedStopContinuation
        blockedStopContinuation = nil
        continuation?.resume()
    }

    func setVoice(_ voice: String) async throws {
        guard !voice.isEmpty else { throw LocalTTSEngineError.invalidArgument("voice must not be empty") }
        self.voice = voice
    }

    func setSpeed(_ speed: Double) async throws {
        guard speed.isFinite, speed > 0 else { throw LocalTTSEngineError.invalidArgument("speed must be positive") }
        self.speed = speed
    }

    /// Advances one deterministic quarter-second. False means cancelled, paused, or superseded.
    @discardableResult
    func advance(sessionID: String, generationID: UUID) -> Bool {
        guard var session = sessions[sessionID],
              let active = session.active,
              active.generationID == generationID,
              !session.paused else { return false }

        let previous = positions[generationID] ?? 0
        if previous == 0 {
            continuation.yield(.started(sessionID: sessionID, generationID: generationID, positionSeconds: 0))
        }
        let next = min(previous + 0.25, 1)
        positions[generationID] = next
        continuation.yield(.position(
            sessionID: sessionID,
            generationID: generationID,
            positionSeconds: next,
            sentenceID: active.utterance.sentenceID
        ))

        if next >= 1 {
            playbackTasks[generationID] = nil
            positions[generationID] = nil
            if session.queue.isEmpty {
                continuation.yield(.ended(sessionID: sessionID, generationID: generationID, reason: "completed"))
                session.active = nil
                sessions[sessionID] = session
            } else {
                let successor = session.queue.removeFirst()
                session.active = successor
                sessions[sessionID] = session
                activate(successor, sessionID: sessionID)
            }
        }
        return true
    }

    private func activate(_ pending: Pending, sessionID: String) {
        positions[pending.generationID] = 0
        let sentenceID = pending.utterance.sentenceID ?? pending.utterance.utteranceID ?? pending.generationID.uuidString
        continuation.yield(.buffering(sessionID: sessionID, generationID: pending.generationID, bufferedSeconds: 0))
        continuation.yield(.sentenceStarted(
            sessionID: sessionID,
            generationID: pending.generationID,
            sentenceID: sentenceID,
            index: pending.utterance.index ?? 0
        ))
        if configuration.automaticPlayback { schedule(pending, sessionID: sessionID) }
    }

    private func schedule(_ pending: Pending, sessionID: String) {
        let delay = configuration.stepNanoseconds
        playbackTasks[pending.generationID] = Task { [weak self] in
            for _ in 0 ..< 4 {
                do { try await Task.sleep(nanoseconds: delay) }
                catch { return }
                guard !Task.isCancelled else { return }
                guard let self, await self.advance(sessionID: sessionID, generationID: pending.generationID) else { return }
            }
        }
    }

    private func validate(_ utterance: LocalTTSUtterance) throws {
        guard !utterance.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw LocalTTSEngineError.invalidArgument("text must not be empty")
        }
    }

    private func nextGenerationID() -> UUID {
        generationCounter += 1
        let suffix = String(format: "%012llu", generationCounter)
        return UUID(uuidString: "00000000-0000-0000-0000-\(suffix)")!
    }
}
