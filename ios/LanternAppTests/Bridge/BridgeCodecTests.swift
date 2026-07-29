import Foundation
import XCTest
@testable import LanternApp

final class BridgeCodecTests: XCTestCase {
    func testDecodesOpaqueStringIdentifiersAndExactEnvelope() throws {
        let body: [String: Any] = [
            "protocol": "lantern.native-tts",
            "version": 1,
            "type": "request",
            "requestId": "client:request:7",
            "sessionId": "client:session:2",
            "method": "tts.enqueue",
            "params": ["text": "Hello", "index": 3],
            "eventReceiver": "__lanternReceiver"
        ]

        let request = try BridgeCodec.decodeRequest(from: body)
        XCTAssertEqual(request.requestId, "client:request:7")
        XCTAssertEqual(request.sessionId, "client:session:2")
        XCTAssertEqual(request.eventReceiver, "__lanternReceiver")
    }

    func testRejectsUnknownEnvelopeField() {
        var body = validBody()
        body["surprise"] = true
        XCTAssertThrowsError(try BridgeCodec.decodeRequest(from: body)) { error in
            XCTAssertEqual((error as? BridgeFailure)?.code, .malformedRequest)
        }
    }

    func testRejectsUUIDAssumptionByAcceptingAdapterStyleID() throws {
        var body = validBody()
        body["requestId"] = "web-client:request:1"
        XCTAssertEqual(try BridgeCodec.decodeRequest(from: body).requestId, "web-client:request:1")
    }

    private func validBody() -> [String: Any] {
        [
            "protocol": "lantern.native-tts", "version": 1, "type": "request",
            "requestId": "c:request:1", "sessionId": NSNull(), "method": "model.status",
            "params": [:], "eventReceiver": "__receiver"
        ]
    }
}
