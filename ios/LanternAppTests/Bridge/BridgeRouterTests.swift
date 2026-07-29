import XCTest
@testable import LanternApp

@MainActor
private final class EventRecorder: BridgeEventDispatching {
    var values: [(BridgeEventEnvelope, String)] = []
    func dispatch(_ event: BridgeEventEnvelope, to receiver: String) { values.append((event, receiver)) }
}

@MainActor
final class BridgeRouterTests: XCTestCase {
    func testRejectsUnknownVersionAndMethod() async {
        let recorder = EventRecorder()
        let router = BridgeRouter(engine: MockLocalTTSEngine(configuration: .init(automaticPlayback: false)), dispatcher: recorder)

        let badVersion = await router.handle(request(method: "model.status", version: 9))
        XCTAssertEqual(badVersion.error?.code, .unsupportedVersion)

        let badMethod = await router.handle(request(method: "qwen.doMagic"))
        XCTAssertEqual(badMethod.error?.code, .unknownMethod)
    }

    func testStrictParameterValidation() async {
        let recorder = EventRecorder()
        let router = BridgeRouter(engine: MockLocalTTSEngine(), dispatcher: recorder)
        let reply = await router.handle(request(method: "model.status", params: ["extra": .bool(true)]))
        XCTAssertEqual(reply.error?.code, .invalidParameters)
    }

    func testLateGenerationEventsAreFencedAndSessionUsesStartRequestOwner() async throws {
        let recorder = EventRecorder()
        let engine = MockLocalTTSEngine(configuration: .init(automaticPlayback: false))
        let router = BridgeRouter(engine: engine, dispatcher: recorder)
        let session = "client:session:1"

        _ = await router.handle(request(method: "tts.start", requestID: "start-old", sessionID: session))
        let first = await router.handle(request(
            method: "tts.enqueue", requestID: "enqueue-old", sessionID: session,
            params: ["text": .string("first"), "sentenceId": .string("s1"), "index": .number(0)]
        ))
        let oldGeneration = try generation(from: first)
        await router.consumeEngineEvent(.buffering(sessionID: session, generationID: oldGeneration, bufferedSeconds: 0))

        _ = await router.handle(request(method: "tts.start", requestID: "start-new", sessionID: session))
        let second = await router.handle(request(
            method: "tts.enqueue", requestID: "enqueue-new", sessionID: session,
            params: ["text": .string("second"), "sentenceId": .string("s2"), "index": .number(1)]
        ))
        let newGeneration = try generation(from: second)
        await router.consumeEngineEvent(.buffering(sessionID: session, generationID: newGeneration, bufferedSeconds: 0))
        await router.consumeEngineEvent(.position(
            sessionID: session, generationID: oldGeneration, positionSeconds: 0.5, sentenceID: "s1"
        ))
        await router.consumeEngineEvent(.position(
            sessionID: session, generationID: newGeneration, positionSeconds: 0.5, sentenceID: "s2"
        ))

        let positions = recorder.values.filter { $0.0.event == "tts.position" }
        XCTAssertEqual(positions.count, 1)
        XCTAssertEqual(positions.first?.0.requestId, "start-new")
        XCTAssertEqual(positions.first?.1, "__receiver")
    }

    func testSecondStartStopsPriorSessionAudio() async throws {
        let recorder = EventRecorder()
        let engine = MockLocalTTSEngine(configuration: .init(automaticPlayback: false))
        let router = BridgeRouter(engine: engine, dispatcher: recorder)

        _ = await router.handle(request(method: "tts.start", requestID: "old-start", sessionID: "old-session"))
        let first = await router.handle(request(
            method: "tts.enqueue", requestID: "old-enqueue", sessionID: "old-session",
            params: ["text": .string("old")]
        ))
        let oldGeneration = try generation(from: first)

        _ = await router.handle(request(method: "tts.start", requestID: "new-start", sessionID: "new-session"))
        let oldAudioCanAdvance = await engine.advance(sessionID: "old-session", generationID: oldGeneration)
        await router.consumeEngineEvent(.position(
            sessionID: "old-session", generationID: oldGeneration, positionSeconds: 0.5, sentenceID: nil
        ))

        XCTAssertFalse(oldAudioCanAdvance)
        XCTAssertFalse(recorder.values.contains { $0.0.event == "tts.position" })
    }

    func testQueueDrainKeepsSessionOpenForLaterEnqueue() async throws {
        let recorder = EventRecorder()
        let engine = MockLocalTTSEngine(configuration: .init(automaticPlayback: false))
        let router = BridgeRouter(engine: engine, dispatcher: recorder)
        let session = "drainable-session"

        _ = await router.handle(request(method: "tts.start", requestID: "start", sessionID: session))
        let first = await router.handle(request(
            method: "tts.enqueue", requestID: "enqueue-1", sessionID: session,
            params: ["text": .string("first")]
        ))
        let generation = try generation(from: first)
        for _ in 0 ..< 4 {
            _ = await engine.advance(sessionID: session, generationID: generation)
        }
        await router.consumeEngineEvent(.buffering(sessionID: session, generationID: generation, bufferedSeconds: 0))
        await router.consumeEngineEvent(.ended(
            sessionID: session, generationID: generation, reason: "completed"
        ))

        let later = await router.handle(request(
            method: "tts.enqueue", requestID: "enqueue-2", sessionID: session,
            params: ["text": .string("later")]
        ))
        XCTAssertTrue(later.ok)
    }

    func testReplacementStartDoesNotHideOldSessionWhenStopFails() async throws {
        let recorder = EventRecorder()
        let engine = MockLocalTTSEngine(configuration: .init(
            automaticPlayback: false,
            injectedStopFailures: 1
        ))
        let router = BridgeRouter(engine: engine, dispatcher: recorder)

        _ = await router.handle(request(method: "tts.start", requestID: "old-start", sessionID: "old"))
        let replacement = await router.handle(request(method: "tts.start", requestID: "new-start", sessionID: "new"))

        XCTAssertEqual(replacement.error?.code, .invalidState)
        let oldExists = await engine.hasSession("old")
        let newExists = await engine.hasSession("new")
        XCTAssertTrue(oldExists)
        XCTAssertFalse(newExists)
        let retryOld = await router.handle(request(
            method: "tts.enqueue", requestID: "old-retry", sessionID: "old",
            params: ["text": .string("still audible")]
        ))
        XCTAssertTrue(retryOld.ok)
        let oldGeneration = try generation(from: retryOld)
        await router.consumeEngineEvent(.buffering(
            sessionID: "old", generationID: oldGeneration, bufferedSeconds: 0
        ))
        XCTAssertEqual(recorder.values.last?.0.requestId, "old-start")
    }

    func testExplicitStopFailureKeepsSessionRetryable() async {
        let recorder = EventRecorder()
        let engine = MockLocalTTSEngine(configuration: .init(
            automaticPlayback: false,
            injectedStopFailures: 1
        ))
        let router = BridgeRouter(engine: engine, dispatcher: recorder)

        _ = await router.handle(request(method: "tts.start", sessionID: "session"))
        let failedStop = await router.handle(request(method: "tts.stop", requestID: "stop-1", sessionID: "session"))
        XCTAssertEqual(failedStop.error?.code, .invalidState)

        let stillOpen = await router.handle(request(
            method: "tts.enqueue", requestID: "retry", sessionID: "session",
            params: ["text": .string("retry")]
        ))
        XCTAssertTrue(stillOpen.ok)
        let successfulStop = await router.handle(request(method: "tts.stop", requestID: "stop-2", sessionID: "session"))
        XCTAssertTrue(successfulStop.ok)
    }

    func testBlockedTransitionRejectsCompetingStart() async {
        let recorder = EventRecorder()
        let engine = MockLocalTTSEngine(configuration: .init(
            automaticPlayback: false,
            blockNextStop: true
        ))
        let router = BridgeRouter(engine: engine, dispatcher: recorder)
        _ = await router.handle(request(method: "tts.start", requestID: "old", sessionID: "old"))

        let replacementRequest = request(method: "tts.start", requestID: "replacement", sessionID: "replacement")
        async let replacementReply = router.handle(replacementRequest)
        await engine.waitUntilStopIsBlocked()

        let competing = await router.handle(request(method: "tts.start", requestID: "competing", sessionID: "competing"))
        XCTAssertEqual(competing.error?.code, .invalidState)
        await engine.releaseBlockedStop()
        let replacement = await replacementReply

        XCTAssertTrue(replacement.ok)
        let replacementExists = await engine.hasSession("replacement")
        let competingExists = await engine.hasSession("competing")
        XCTAssertTrue(replacementExists)
        XCTAssertFalse(competingExists)
    }

    private func request(
        method: String,
        version: Int = 1,
        requestID: String = "client:request:1",
        sessionID: String? = nil,
        params: [String: BridgeValue] = [:]
    ) -> BridgeRequest {
        .init(
            protocolName: BridgeCodec.protocolName, version: version, type: "request",
            requestId: requestID, sessionId: sessionID, method: method, params: params,
            eventReceiver: "__receiver"
        )
    }

    private func generation(from reply: BridgeReply) throws -> UUID {
        guard case .object(let result) = reply.result,
              case .string(let raw) = result["generationId"],
              let id = UUID(uuidString: raw) else {
            throw XCTSkip("Missing generation ID in mock reply")
        }
        return id
    }
}
