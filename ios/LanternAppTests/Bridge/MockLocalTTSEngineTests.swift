import XCTest
@testable import LanternApp

final class MockLocalTTSEngineTests: XCTestCase {
    func testStopCancelsGenerationDeterministically() async throws {
        let engine = MockLocalTTSEngine(configuration: .init(automaticPlayback: false))
        try await engine.start(sessionID: "session")
        let receipt = try await engine.enqueue(sessionID: "session", utterance: utterance("one"))
        try await engine.stop(sessionID: "session")
        let didAdvance = await engine.advance(sessionID: "session", generationID: receipt.generationID)
        XCTAssertFalse(didAdvance)
    }

    func testStartingSessionAgainSupersedesOldGeneration() async throws {
        let engine = MockLocalTTSEngine(configuration: .init(automaticPlayback: false))
        try await engine.start(sessionID: "session")
        let old = try await engine.enqueue(sessionID: "session", utterance: utterance("old"))
        try await engine.start(sessionID: "session")
        let new = try await engine.enqueue(sessionID: "session", utterance: utterance("new"))

        let oldAdvanced = await engine.advance(sessionID: "session", generationID: old.generationID)
        let newAdvanced = await engine.advance(sessionID: "session", generationID: new.generationID)
        XCTAssertFalse(oldAdvanced)
        XCTAssertTrue(newAdvanced)
    }

    func testPauseCancelsTaskAndResumeSchedulesFreshTask() async throws {
        let engine = MockLocalTTSEngine(configuration: .init(
            automaticPlayback: true,
            stepNanoseconds: 60_000_000_000
        ))
        try await engine.start(sessionID: "session")
        _ = try await engine.enqueue(sessionID: "session", utterance: utterance("one"))
        let scheduledBeforePause = await engine.isPlaybackScheduled(sessionID: "session")
        XCTAssertTrue(scheduledBeforePause)

        try await engine.pause(sessionID: "session")
        let scheduledWhilePaused = await engine.isPlaybackScheduled(sessionID: "session")
        XCTAssertFalse(scheduledWhilePaused)
        try await engine.resume(sessionID: "session")
        let scheduledAfterResume = await engine.isPlaybackScheduled(sessionID: "session")
        XCTAssertTrue(scheduledAfterResume)
        try await engine.stop(sessionID: "session")
    }

    private func utterance(_ text: String) -> LocalTTSUtterance {
        .init(utteranceID: nil, sentenceID: text, index: 0, text: text, language: nil)
    }
}
