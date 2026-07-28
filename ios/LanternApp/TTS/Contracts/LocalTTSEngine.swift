import Foundation

enum LocalTTSModelState: String, Codable, Sendable, Equatable {
    case notInstalled
    case downloading
    case ready
    case failed
}

struct LocalTTSModelStatus: Codable, Sendable, Equatable {
    let state: LocalTTSModelState
    let progress: Double?
    let detail: String?
}

struct LocalTTSUtterance: Sendable, Equatable {
    let utteranceID: String?
    let sentenceID: String?
    let index: Int?
    let text: String
    let language: String?
}

struct LocalTTSReceipt: Sendable, Equatable {
    let generationID: UUID
}

enum LocalTTSEngineEvent: Sendable, Equatable {
    case modelProgress(loaded: Double, total: Double, file: String?)
    case modelReady(modelRevision: String)
    case buffering(sessionID: String, generationID: UUID, bufferedSeconds: Double)
    case started(sessionID: String, generationID: UUID, positionSeconds: Double?)
    case position(sessionID: String, generationID: UUID, positionSeconds: Double, sentenceID: String?)
    case ended(sessionID: String, generationID: UUID, reason: String?)
    case sentenceStarted(sessionID: String, generationID: UUID, sentenceID: String, index: Int)
    case error(sessionID: String?, generationID: UUID?, code: String, message: String)
}

enum LocalTTSEngineError: Error, Sendable, Equatable {
    case modelUnavailable
    case sessionNotPrepared
    case invalidArgument(String)
    case cancelled
    case invalidState(String)
}

protocol LocalTTSEngine: Actor {
    nonisolated var events: AsyncStream<LocalTTSEngineEvent> { get }

    func modelStatus() async throws -> LocalTTSModelStatus
    /// Returns once a new or resumable download has been accepted and persisted.
    /// Implementations must report multi-file progress and terminal readiness/failure
    /// through `events`; callers must never await this method for the multi-GB transfer.
    func downloadModel(revision: String?) async throws
    func cancelModelDownload() async throws
    func deleteModel() async throws

    func prepare(modelRevision: String?) async throws
    func start(sessionID: String) async throws
    func enqueue(sessionID: String, utterance: LocalTTSUtterance) async throws -> LocalTTSReceipt
    func pause(sessionID: String) async throws
    func resume(sessionID: String) async throws
    func stop(sessionID: String) async throws
    func setVoice(_ voice: String) async throws
    func setSpeed(_ speed: Double) async throws
}
