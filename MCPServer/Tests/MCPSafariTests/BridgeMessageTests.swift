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
            error: "not authenticated"
        )

        let data = try JSONEncoder().encode(response)
        let decoded = try JSONDecoder().decode(BridgeResponse.self, from: data)

        #expect(decoded.id == "request-1")
        #expect(decoded.success == false)
        #expect(decoded.data == nil)
        #expect(decoded.error == "not authenticated")
    }
}
