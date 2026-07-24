import Foundation
import Logging
import Testing
@testable import MCPSafari

struct BridgeStatusTests {
    @Test func handshakeAcceptsLegacyAndRejectsProtocolMismatch() throws {
        let legacy = Data(#"{"auth":"secret"}"#.utf8)
        #expect(
            BridgeHandshake.decision(for: legacy, expectedToken: "secret")
                == .accept(.init(version: nil, protocolVersion: nil))
        )

        let current = Data(#"{"auth":"secret","extensionVersion":"0.2.9","protocolVersion":1}"#.utf8)
        #expect(
            BridgeHandshake.decision(for: current, expectedToken: "secret")
                == .accept(.init(version: "0.2.9", protocolVersion: 1))
        )

        let incompatible = Data(#"{"auth":"secret","extensionVersion":"0.3.0","protocolVersion":2}"#.utf8)
        #expect(
            BridgeHandshake.decision(for: incompatible, expectedToken: "secret")
                == .rejectProtocol(extensionVersion: "0.3.0", protocolVersion: 2)
        )

        #expect(
            BridgeHandshake.decision(for: legacy, expectedToken: "different-secret")
                == .rejectToken
        )
    }

    @Test func statusWorksWithoutAnExtensionConnection() async throws {
        let bridge = try WebSocketBridge(
            port: 8128,
            logger: Logger(label: "BridgeStatusTests")
        )

        let status = await bridge.status()

        #expect(status.requestedPort == 8128)
        #expect(status.port == 8128)
        #expect(status.listener == .stopped)
        #expect(status.bridge == .disconnected)
        #expect(status.extensionVersion == nil)
        #expect(status.extensionProtocolVersion == nil)
        #expect(status.lastError == nil)

        let json = String(decoding: try JSONEncoder().encode(status), as: UTF8.self)
        #expect(json.contains(#""extensionVersion":null"#))
        #expect(json.contains(#""extensionProtocolVersion":null"#))
        #expect(json.contains(#""lastError":null"#))
    }

    @Test func protocolMismatchRemainsVisibleAfterRejection() async throws {
        let bridge = try WebSocketBridge(
            port: 8129,
            logger: Logger(label: "BridgeStatusTests")
        )
        let token = await bridge.authToken
        let incompatible = Data(#"{"auth":"\#(token)","extensionVersion":"0.3.0","protocolVersion":2}"#.utf8)

        #expect(
            await bridge.handshakeDecision(for: incompatible)
                == .rejectProtocol(extensionVersion: "0.3.0", protocolVersion: 2)
        )

        let status = await bridge.status()
        #expect(status.bridge == .disconnected)
        #expect(status.extensionVersion == "0.3.0")
        #expect(status.extensionProtocolVersion == 2)
        #expect(status.protocolVersion == MCPSafariProduct.bridgeProtocolVersion)
        #expect(status.lastError?.code == "protocol_version_mismatch")
        #expect(status.lastError?.recovery.contains("restart Safari") == true)
    }
}
