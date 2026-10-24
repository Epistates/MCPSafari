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

    // The extension names the tab it resolved at the top level of every reply,
    // success or failure, and null where no tab is involved. An older extension
    // sends nothing, which must keep decoding.
    @Test func bridgeResponseReadsTheResolvedTabWhenThereIsOne() throws {
        func decode(_ json: String) throws -> BridgeResponse {
            try JSONDecoder().decode(BridgeResponse.self, from: Data(json.utf8))
        }
        #expect(try decode(#"{"id":"1","success":true,"data":"ok","resolvedTabId":42}"#).resolvedTabId == 42)
        #expect(try decode(#"{"id":"1","success":false,"error":"no","resolvedTabId":7}"#).resolvedTabId == 7)
        #expect(try decode(#"{"id":"1","success":true,"data":"[]","resolvedTabId":null}"#).resolvedTabId == nil)
        #expect(try decode(#"{"id":"1","success":true,"data":"ok"}"#).resolvedTabId == nil)
        // The profile is the server's to set, never read off the wire.
        #expect(try decode(#"{"id":"1","success":true,"profileIndex":3}"#).profileIndex == nil)
    }

    @Test func followUpsAreAimedAtTheTabTheActionResolved() {
        func reply(tab: Int?, profile: Int?) -> BridgeResponse {
            BridgeResponse(
                id: "1", success: true, data: nil, error: nil, errorCode: nil,
                retryable: nil, recoveryAction: nil, resolvedTabId: tab, profileIndex: profile
            )
        }
        let pinned = SafariMCPServer.pinned(["selector": "#a"], to: reply(tab: 7, profile: 2))
        #expect(pinned["tabId"]?.stringValue == "p2t7")
        #expect(pinned["selector"]?.stringValue == "#a")

        // A named tab is never replaced, an older extension reports none, and a
        // tab id without its profile cannot be turned into a handle.
        #expect(SafariMCPServer.pinned(["tabId": "p0t3"], to: reply(tab: 7, profile: 0))["tabId"]?.stringValue == "p0t3")
        #expect(SafariMCPServer.pinned([:], to: reply(tab: nil, profile: 0))["tabId"] == nil)
        #expect(SafariMCPServer.pinned([:], to: reply(tab: 7, profile: nil))["tabId"] == nil)
        #expect(SafariMCPServer.pinned(["tabId": .null], to: reply(tab: 7, profile: 1))["tabId"]?.stringValue == "p1t7")
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

        let unavailable = WebSocketBridge.BridgeError.bridgeUnavailable(.init(
            code: "bridge_bind_failed",
            message: "No free port in 8089-8098 for the extension bridge.",
            recovery: "Quit whatever is holding those ports."
        )).toolFailure
        #expect(unavailable.code == "bridge_unavailable")
        #expect(unavailable.message == "The extension bridge is not running. No free port in 8089-8098 for the extension bridge. Quit whatever is holding those ports.")
        #expect(!unavailable.message.contains("Open Safari"))
        #expect(WebSocketBridge.BridgeError.bridgeUnavailable(nil).toolFailure.code == "bridge_unavailable")

        let timeout = WebSocketBridge.BridgeError.timeout(action: "click", seconds: 0.5).toolFailure
        #expect(timeout.code == "bridge_timeout")
        #expect(timeout.message.contains("click after 0.5 seconds"))
        #expect(timeout.message.contains("may already have completed"))
        #expect(timeout.retryable == false)
        #expect(timeout.recoveryAction == "inspect_error")
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
