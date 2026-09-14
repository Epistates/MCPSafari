import Foundation
import Logging
import MCP
import Testing

@testable import MCPSafari

struct ClientCapabilityTransportTests {
    private let logger = Logger(label: "tests") { _ in SwiftLogNoOpLogHandler() }

    private func normalize(_ json: String) -> Data {
        ClientCapabilityNormalizingTransport.normalize(Data(json.utf8), logger: logger)
    }

    private func capabilities(of message: Data) throws -> Client.Capabilities {
        let object = try #require(
            try JSONSerialization.jsonObject(with: message) as? [String: Any]
        )
        let params = try #require(object["params"] as? [String: Any])
        let data = try JSONSerialization.data(withJSONObject: params)
        return try JSONDecoder().decode(Initialize.Parameters.self, from: data).capabilities
    }

    /// The reported failure: codex 0.154.0 sends an object under a capability key and
    /// the whole initialize comes back -32603.
    @Test func codexInitializeDecodesAfterNormalising() throws {
        let normalized = normalize(
            """
            {"jsonrpc":"2.0","id":1,"method":"initialize","params":{\
            "protocolVersion":"2025-06-18",\
            "capabilities":{"experimental":{"codex/auth-change":{}}},\
            "clientInfo":{"name":"codex","version":"0.154.0"}}}
            """
        )

        let capabilities = try capabilities(of: normalized)
        #expect(capabilities.experimental?["codex/auth-change"] == "{}")
    }

    /// swift-sdk#262, the same defect reached through a populated object.
    @Test func nestedObjectValuesKeepTheirKeysAndContent() throws {
        let normalized = normalize(
            """
            {"jsonrpc":"2.0","id":1,"method":"initialize","params":{\
            "protocolVersion":"2025-06-18",\
            "capabilities":{"experimental":{"openai/visibility":{"enabled":true}}},\
            "clientInfo":{"name":"chatgpt","version":"1.0"}}}
            """
        )

        let capabilities = try capabilities(of: normalized)
        #expect(capabilities.experimental?["openai/visibility"] == #"{"enabled":true}"#)
    }

    @Test func otherCapabilitiesAndFieldsSurviveTheRewrite() throws {
        let normalized = normalize(
            """
            {"jsonrpc":"2.0","id":7,"method":"initialize","params":{\
            "protocolVersion":"2025-06-18",\
            "capabilities":{"roots":{"listChanged":true},\
            "experimental":{"a/one":{},"b/two":"kept"}},\
            "clientInfo":{"name":"codex","version":"0.154.0"}}}
            """
        )

        let object = try #require(
            try JSONSerialization.jsonObject(with: normalized) as? [String: Any]
        )
        #expect(object["id"] as? Int == 7)
        #expect(object["jsonrpc"] as? String == "2.0")

        let capabilities = try capabilities(of: normalized)
        #expect(capabilities.roots?.listChanged == true)
        #expect(capabilities.experimental?["a/one"] == "{}")
        // A value the SDK could already decode is left exactly as the client sent it.
        #expect(capabilities.experimental?["b/two"] == "kept")
    }

    @Test func aBatchRepairsOnlyTheInitializeEntry() throws {
        let original = """
            [{"jsonrpc":"2.0","id":1,"method":"initialize","params":{\
            "protocolVersion":"2025-06-18",\
            "capabilities":{"experimental":{"codex/auth-change":{}}},\
            "clientInfo":{"name":"codex","version":"0.154.0"}}},\
            {"jsonrpc":"2.0","id":2,"method":"tools/list"}]
            """
        let batch = try #require(
            try JSONSerialization.jsonObject(with: normalize(original)) as? [Any]
        )

        #expect(batch.count == 2)
        let second = try #require(batch[1] as? [String: Any])
        #expect(second["method"] as? String == "tools/list")
    }

    /// Everything below has nothing to repair, so the original bytes go through
    /// rather than a JSONSerialization round trip of them.
    @Test func messagesWithNothingToRepairArePassedThroughUntouched() {
        let untouched = [
            // Already decodable, so the SDK never sees a difference.
            """
            {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18",\
            "capabilities":{"experimental":{"a/one":"two"}},"clientInfo":{"name":"c","version":"1"}}}
            """,
            // No experimental capabilities at all, which is what Claude Code sends.
            """
            {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18",\
            "capabilities":{},"clientInfo":{"name":"claude","version":"1"}}}
            """,
            // The word appears, but not as a capability on initialize.
            #"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"experimental"}}"#,
            // Not JSON at all.
            "experimental nonsense {",
            // JSON, but not a shape this knows.
            #""experimental""#,
        ]

        for message in untouched {
            #expect(normalize(message) == Data(message.utf8), "rewrote \(message)")
        }
    }

    @Test func aResponseCarryingExperimentalIsNotTouched() {
        // Server capabilities travel the other way, but a response could still be
        // read back in on a future transport. Only requests naming initialize match.
        let response = """
            {"jsonrpc":"2.0","id":1,"result":{"capabilities":{"experimental":{"x":{}}}}}
            """
        #expect(normalize(response) == Data(response.utf8))
    }
}
