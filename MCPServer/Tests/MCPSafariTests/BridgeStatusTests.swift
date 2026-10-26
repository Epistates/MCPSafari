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

    private func hello(
        nonce: String = BridgeHandshake.makeNonce(),
        protocolVersion: Int = MCPSafariProduct.bridgeProtocolVersion,
        extra: String = ""
    ) -> Data {
        Data(#"{"hello":{"clientNonce":"\#(nonce)","extensionVersion":"0.4.0","protocolVersion":\#(protocolVersion)\#(extra)}}"#.utf8)
    }

    @Test func aHelloIsAnsweredWithAChallengeThatCarriesItsMetadata() throws {
        let nonce = BridgeHandshake.makeNonce()
        let serverNonce = BridgeHandshake.makeNonce()
        let start = BridgeHandshake.begin(
            with: hello(nonce: nonce, extra: #","profileId":"WORK-UUID""#),
            token: "secret",
            port: 8089,
            makeServerNonce: { serverNonce }
        )

        let expected = PendingHandshake(
            clientNonce: nonce,
            serverNonce: serverNonce,
            metadata: .init(version: "0.4.0", protocolVersion: MCPSafariProduct.bridgeProtocolVersion, profileID: "WORK-UUID")
        )
        #expect(start == .challenge(expected))

        // The challenge it sends is the proof over exactly those nonces.
        let frame = BridgeHandshake.challengeFrame(for: expected, token: "secret", port: 8089)
        let challenge = try #require(frame["challenge"] as? [String: Any])
        #expect(challenge["serverNonce"] as? String == serverNonce)
        #expect(challenge["serverProof"] as? String == BridgeHandshake.serverProof(
            token: "secret", port: 8089, clientNonce: nonce, serverNonce: serverNonce
        ))
    }

    @Test func theProofFrameDecidesWhetherTheHandshakeIsAccepted() throws {
        let pending = PendingHandshake(
            clientNonce: BridgeHandshake.makeNonce(),
            serverNonce: BridgeHandshake.makeNonce(),
            metadata: .init(version: "0.4.0", protocolVersion: MCPSafariProduct.bridgeProtocolVersion, profileID: "default")
        )
        func frame(_ proof: String) throws -> Data { Data(try TestExtension.proofFrame(proof).utf8) }
        let good = BridgeHandshake.clientProof(
            token: "secret", port: 8089, clientNonce: pending.clientNonce, serverNonce: pending.serverNonce
        )

        #expect(BridgeHandshake.finish(with: try frame(good), pending: pending, token: "secret", port: 8089) == .accept(pending.metadata))
        #expect(BridgeHandshake.finish(with: try frame(good), pending: pending, token: "different-secret", port: 8089) == .rejectToken)
        #expect(BridgeHandshake.finish(with: try frame(good), pending: pending, token: "secret", port: 8090) == .rejectToken)
        #expect(BridgeHandshake.finish(with: Data(#"{"hello":{}}"#.utf8), pending: pending, token: "secret", port: 8089) == nil)
    }

    @Test func aHelloFromAnotherProtocolOrAnOldFrameIsRejectedNotChallenged() {
        // Deliberately not a real release: the rejection turns on the protocol number.
        #expect(
            BridgeHandshake.begin(with: hello(protocolVersion: 99), token: "secret", port: 8089)
                == .rejectProtocol(extensionVersion: "0.4.0", protocolVersion: 99, tokenVerified: false)
        )

        // A frame in the shape builds before the exchange send, token included.
        let old = Data(#"{"auth":"secret","extensionVersion":"0.3.0","protocolVersion":1}"#.utf8)
        #expect(
            BridgeHandshake.begin(with: old, token: "secret", port: 8089)
                == .rejectProtocol(extensionVersion: "0.3.0", protocolVersion: 1, tokenVerified: true)
        )
        #expect(BridgeHandshake.begin(with: old, token: "different-secret", port: 8089) == .rejectToken)

        // Builds that predate protocol numbers sent none.
        #expect(
            BridgeHandshake.begin(with: Data(#"{"auth":"secret"}"#.utf8), token: "secret", port: 8089)
                == .rejectProtocol(extensionVersion: nil, protocolVersion: 0, tokenVerified: true)
        )
        #expect(BridgeHandshake.begin(with: Data("{}".utf8), token: "secret", port: 8089) == nil)
        #expect(BridgeHandshake.begin(with: Data("[]".utf8), token: "secret", port: 8089) == nil)
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
        // Same reason as above: not a real release, so this cannot read as a
        // shipped version being refused.
        await bridge.recordProtocolMismatch(extensionVersion: "99.0.0", protocolVersion: 99)

        let status = await bridge.status()
        #expect(status.bridge == .disconnected)
        #expect(status.extensionVersion == "99.0.0")
        #expect(status.extensionProtocolVersion == 99)
        #expect(status.protocolVersion == MCPSafariProduct.bridgeProtocolVersion)
        #expect(status.lastError?.code == "protocol_version_mismatch")
        #expect(status.lastError?.recovery.contains("restart Safari") == true)
    }
}
