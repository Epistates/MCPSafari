import Foundation
import Logging
import Testing
@testable import MCPSafari

struct BridgeStatusTests {
    /// The id is logged and reaches the MCP client, so a handshake cannot be
    /// allowed to put arbitrary text in either place.
    @Test func aProfileIDIsBoundedAndStrippedOfAnythingUnprintable() throws {
        let forged = "work\n2026-01-01 info Safari extension authenticated (profile admin)"
        let normalized = BridgeHandshake.normalizedProfileID(forged)
        #expect(!normalized.contains("\n"), "a newline here forges a log line")
        #expect(!normalized.contains(" "))
        #expect(!normalized.contains("("))
        #expect(normalized.hasPrefix("work"))

        #expect(BridgeHandshake.normalizedProfileID("B9F4-2C1A_7e") == "B9F4-2C1A_7e")
        #expect(BridgeHandshake.normalizedProfileID("  spaced  ") == "spaced")
        #expect(
            BridgeHandshake.normalizedProfileID(String(repeating: "a", count: 300)).count
                == BridgeHandshake.maxProfileIDLength
        )
        // Nothing usable left, so this falls back rather than becoming empty.
        #expect(BridgeHandshake.normalizedProfileID("///") == WebSocketBridge.defaultProfileID)
        #expect(BridgeHandshake.normalizedProfileID(nil) == WebSocketBridge.defaultProfileID)
    }

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

        // Deliberately not a real release: the rejection turns on protocolVersion,
        // and a shipped version number here reads as though that release is refused.
        let incompatible = Data(#"{"auth":"secret","extensionVersion":"99.0.0","protocolVersion":2}"#.utf8)
        #expect(
            BridgeHandshake.decision(for: incompatible, expectedToken: "secret")
                == .rejectProtocol(extensionVersion: "99.0.0", protocolVersion: 2)
        )

        #expect(
            BridgeHandshake.decision(for: legacy, expectedToken: "different-secret")
                == .rejectToken
        )
    }

    /// Timing cannot be asserted reliably in a unit test, so this pins the answers
    /// the byte-wise comparison has to give; the loop itself is what removes the
    /// early exit.
    @Test func tokensMatchOnlyWhenEveryByteDoes() {
        let token = "B9F4C2A1-7E3D-4F10-9A6B-0C5D8E2F1A34"
        #expect(BridgeHandshake.tokensMatch(token, token))
        #expect(!BridgeHandshake.tokensMatch("", token))
        #expect(!BridgeHandshake.tokensMatch(token, ""))
        #expect(BridgeHandshake.tokensMatch("", ""))
        #expect(!BridgeHandshake.tokensMatch(String(token.dropLast()), token))
        #expect(!BridgeHandshake.tokensMatch(token + "0", token))
        // A difference in the first byte, in the last, and in the middle.
        #expect(!BridgeHandshake.tokensMatch("C" + token.dropFirst(), token))
        #expect(!BridgeHandshake.tokensMatch(token.dropLast() + "5", token))
        #expect(!BridgeHandshake.tokensMatch(token.replacingOccurrences(of: "-9A6B-", with: "-9A6C-"), token))
        // Same character count, different byte count.
        #expect(!BridgeHandshake.tokensMatch(String(repeating: "é", count: token.count), token))
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
        // Same reason as above: not a real release, so this cannot read as a
        // shipped version being refused.
        let incompatible = Data(#"{"auth":"\#(token)","extensionVersion":"99.0.0","protocolVersion":2}"#.utf8)

        #expect(
            await bridge.handshakeDecision(for: incompatible)
                == .rejectProtocol(extensionVersion: "99.0.0", protocolVersion: 2)
        )

        let status = await bridge.status()
        #expect(status.bridge == .disconnected)
        #expect(status.extensionVersion == "99.0.0")
        #expect(status.extensionProtocolVersion == 2)
        #expect(status.protocolVersion == MCPSafariProduct.bridgeProtocolVersion)
        #expect(status.lastError?.code == "protocol_version_mismatch")
        #expect(status.lastError?.recovery.contains("restart Safari") == true)
    }
}
