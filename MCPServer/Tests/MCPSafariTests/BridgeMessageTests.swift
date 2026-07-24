import Foundation
import Testing
@testable import MCPSafari

struct BridgeMessageTests {
    @Test func anyCodableRoundTripsNestedJSON() throws {
        let request = BridgeRequest(action: "form_input", params: [
            "fields": AnyCodable([
                "#name": AnyCodable("Ada"),
                "#age": AnyCodable(37),
                "#subscribed": AnyCodable(true),
            ]),
            "tabId": AnyCodable(42),
        ])

        let data = try JSONEncoder().encode(request)
        let decoded = try JSONDecoder().decode(BridgeRequest.self, from: data)

        #expect(decoded.action == "form_input")
        #expect(decoded.params["tabId"]?.intValue == 42)
        #expect(decoded.params["fields"]?.objectValue?["#name"]?.stringValue == "Ada")
        #expect(decoded.params["fields"]?.objectValue?["#age"]?.intValue == 37)
        #expect(decoded.params["fields"]?.objectValue?["#subscribed"]?.boolValue == true)
    }

    @Test func bridgeResponsePreservesErrors() throws {
        let response = BridgeResponse(
            id: "request-1",
            success: false,
            data: nil,
            error: "UID expired",
            errorCode: "stale_uid",
            retryable: false,
            recoveryAction: "take_snapshot"
        )

        let data = try JSONEncoder().encode(response)
        let decoded = try JSONDecoder().decode(BridgeResponse.self, from: data)

        #expect(decoded.id == "request-1")
        #expect(decoded.success == false)
        #expect(decoded.data == nil)
        #expect(decoded.error == "UID expired")
        #expect(decoded.errorCode == "stale_uid")
        #expect(decoded.retryable == false)
        #expect(decoded.recoveryAction == "take_snapshot")
        #expect(decoded.toolFailure == ToolFailure(
            code: "stale_uid",
            message: "UID expired",
            retryable: false,
            recoveryAction: "take_snapshot"
        ))
    }

    @Test func bridgeErrorsProvideRecoveryMetadata() {
        #expect(WebSocketBridge.BridgeError.notConnected.toolFailure == ToolFailure(
            code: "bridge_disconnected",
            message: "No Safari extension connected. Open Safari and click the MCPSafari extension icon to connect.",
            retryable: false,
            recoveryAction: "call_status"
        ))

        #expect(WebSocketBridge.BridgeError.timeout.toolFailure == ToolFailure(
            code: "bridge_timeout",
            message: "Request to Safari extension timed out after 30 seconds.",
            retryable: true,
            recoveryAction: "retry"
        ))
    }

    @Test func legacyExtensionErrorsRemainDecodable() throws {
        let data = Data(#"{"id":"request-1","success":false,"data":null,"error":"Old extension error"}"#.utf8)
        let response = try JSONDecoder().decode(BridgeResponse.self, from: data)

        #expect(response.toolFailure == ToolFailure(
            code: "extension_error",
            message: "Old extension error",
            retryable: false,
            recoveryAction: "inspect_error"
        ))
    }
}
