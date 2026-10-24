import CryptoKit
import Foundation
import Network

// MARK: - Handshake

/// How the bridge and the extension prove to each other that they share the token.
///
/// The token never crosses the wire. Each side proves it holds it by returning an
/// HMAC over both sides' fresh nonces, so a listener that is not the real server
/// learns nothing it can replay, and the extension acts on nothing until the
/// server has proved itself first:
///
/// 1. extension to server: `{"hello": {clientNonce, extensionVersion, protocolVersion, profileId}}`
/// 2. server to extension: `{"challenge": {serverNonce, serverProof, ...}}`, where
///    `serverProof` is the HMAC of `clientNonce` and `serverNonce` under the token
/// 3. extension to server: `{"auth": {clientProof}}`, only once it has checked
///    `serverProof`. The two proofs carry different labels and take the nonces in
///    different orders, so neither can be replayed as the other.
/// 4. server to extension: `{"auth": "ok", ...}`, or `{"auth": "error", ...}` and a close
///
/// The first two frames on a new socket are the only part of the protocol an
/// unauthenticated peer can reach. The decisions are kept pure and apart from the
/// actor for that reason: judging a frame needs only the token, the port and the
/// state of this one handshake, and the tests drive them directly.
struct ExtensionMetadata: Codable, Equatable {
    let version: String?
    let protocolVersion: Int?
    /// Which Safari profile's extension instance authenticated. Safari omits the
    /// profile key for the default profile, so it lands on `WebSocketBridge.defaultProfileID`.
    let profileID: String

    init(
        version: String?,
        protocolVersion: Int?,
        profileID: String = WebSocketBridge.defaultProfileID
    ) {
        self.version = version
        self.protocolVersion = protocolVersion
        self.profileID = profileID
    }
}

/// A handshake that has been answered with a challenge and is waiting for the proof.
struct PendingHandshake: Equatable {
    let clientNonce: String
    let serverNonce: String
    let metadata: ExtensionMetadata
}

/// What to do with the first frame on a connection.
enum HandshakeStart: Equatable {
    /// Send this challenge and wait for the client's proof.
    case challenge(PendingHandshake)
    /// A frame from a build that sends the token itself, carrying the wrong one.
    case rejectToken
    /// The peer speaks another protocol version. `tokenVerified` says whether it
    /// proved it holds the token, which decides whether it may be recorded in
    /// `status`: an unauthenticated peer must not be able to write there.
    case rejectProtocol(extensionVersion: String?, protocolVersion: Int, tokenVerified: Bool)
}

/// What to do with the second frame.
enum HandshakeFinish: Equatable {
    case accept(ExtensionMetadata)
    case rejectToken
}

enum BridgeHandshake {
    private struct FirstFrame: Decodable {
        struct Hello: Decodable {
            let clientNonce: String
            let extensionVersion: String?
            let protocolVersion: Int
            let profileId: String?
        }

        let hello: Hello?
        /// Builds before the challenge exchange put the token itself here. A string
        /// is the only shape that was ever sent, so anything else fails to decode.
        let auth: String?
        let extensionVersion: String?
        let protocolVersion: Int?
    }

    private struct ProofFrame: Decodable {
        struct Auth: Decodable {
            let clientProof: String
        }

        let auth: Auth
    }

    /// Blank or absent means the default profile, which is also what Safari sends
    /// for it. Trimmed because it is reflected back in log lines.
    /// Safari sends a `SFExtensionProfileKey` UUID or nothing at all, so this is
    /// generous rather than a UUID check. Both halves earn their place: the id is
    /// logged and reaches the MCP client, where an embedded newline forges log
    /// lines and control characters land in the model's context.
    static let maxProfileIDLength = 64

    static func normalizedProfileID(_ raw: String?) -> String {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else { return WebSocketBridge.defaultProfileID }

        let bounded = String(trimmed.prefix(maxProfileIDLength).filter {
            $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_")
        })
        return bounded.isEmpty ? WebSocketBridge.defaultProfileID : bounded
    }

    /// The largest frame a connection may send before it has authenticated.
    /// A real handshake frame is a couple of hundred bytes. The listener's own message
    /// limit is 32 MiB, because it has to admit tool responses and cannot vary per
    /// connection, so without this an unauthenticated peer could make the server
    /// decode as much JSON as it cared to send.
    static let maxFrameBytes = 4 * 1024

    // MARK: Origin

    /// The scheme Safari gives an extension page's `Origin`. The host after it is a
    /// per-profile UUID that changes when the extension is reinstalled, so the
    /// scheme is all there is to check.
    private static let extensionOriginPrefix = "safari-web-extension://"

    /// Whether an upgrade request carrying this `Origin` may proceed. A request with
    /// no `Origin` never reaches here, since that is a client with no browser
    /// behind it. One that has the header and it is not an extension's, including
    /// `null` and an empty value, is a web page.
    static func isAllowedOrigin(_ origin: String) -> Bool {
        origin.lowercased().hasPrefix(extensionOriginPrefix)
    }

    // MARK: Nonces and proofs

    /// A nonce is 32 random bytes, base64url without padding, which is always this long.
    static let nonceLength = 43

    static func makeNonce() -> String {
        var generator = SystemRandomNumberGenerator()
        let bytes = (0..<32).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
        return Data(bytes).base64URLEncodedString()
    }

    /// Whether `nonce` has the exact shape of one this protocol makes. Checked on
    /// what an unauthenticated peer sends, because the text goes into an HMAC
    /// input and a log line.
    static func isWellFormedNonce(_ nonce: String) -> Bool {
        nonce.utf8.count == nonceLength && Data(base64URL: nonce)?.count == 32
    }

    /// The text each side authenticates. The role label and the nonce order both
    /// differ between the two, so a proof from one direction fails in the other,
    /// and the port ties a proof to the listener it was made for.
    private static func proofMessage(role: String, port: UInt16, first: String, second: String) -> Data {
        Data("mcpsafari-v\(MCPSafariProduct.bridgeProtocolVersion)-\(role)|\(port)|\(first)|\(second)".utf8)
    }

    private static func serverMessage(port: UInt16, clientNonce: String, serverNonce: String) -> Data {
        proofMessage(role: "server", port: port, first: clientNonce, second: serverNonce)
    }

    private static func clientMessage(port: UInt16, clientNonce: String, serverNonce: String) -> Data {
        proofMessage(role: "client", port: port, first: serverNonce, second: clientNonce)
    }

    private static func key(for token: String) -> SymmetricKey {
        SymmetricKey(data: Data(token.utf8))
    }

    /// What the server sends to show it knows the token.
    static func serverProof(token: String, port: UInt16, clientNonce: String, serverNonce: String) -> String {
        let message = serverMessage(port: port, clientNonce: clientNonce, serverNonce: serverNonce)
        return Data(HMAC<SHA256>.authenticationCode(for: message, using: key(for: token))).base64URLEncodedString()
    }

    /// What the extension answers with. Used by tests to play the extension.
    static func clientProof(token: String, port: UInt16, clientNonce: String, serverNonce: String) -> String {
        let message = clientMessage(port: port, clientNonce: clientNonce, serverNonce: serverNonce)
        return Data(HMAC<SHA256>.authenticationCode(for: message, using: key(for: token))).base64URLEncodedString()
    }

    /// Checks the extension's proof. `isValidAuthenticationCode` compares in
    /// constant time, so how long a wrong proof takes says nothing about it.
    static func isValidClientProof(
        _ proof: String,
        token: String,
        port: UInt16,
        clientNonce: String,
        serverNonce: String
    ) -> Bool {
        guard let code = Data(base64URL: proof) else { return false }
        return HMAC<SHA256>.isValidAuthenticationCode(
            code,
            authenticating: clientMessage(port: port, clientNonce: clientNonce, serverNonce: serverNonce),
            using: key(for: token)
        )
    }

    // MARK: Decisions

    /// Judges the first frame. Nil means it is not a handshake at all, whatever it
    /// contains, and the bridge closes the connection.
    static func begin(
        with data: Data,
        token: String,
        port: UInt16,
        makeServerNonce: () -> String = makeNonce
    ) -> HandshakeStart? {
        guard data.count <= maxFrameBytes,
              let frame = try? JSONDecoder().decode(FirstFrame.self, from: data)
        else { return nil }

        if let hello = frame.hello {
            guard isWellFormedNonce(hello.clientNonce) else { return nil }
            guard hello.protocolVersion == MCPSafariProduct.bridgeProtocolVersion else {
                return .rejectProtocol(
                    extensionVersion: hello.extensionVersion,
                    protocolVersion: hello.protocolVersion,
                    tokenVerified: false
                )
            }
            return .challenge(PendingHandshake(
                clientNonce: hello.clientNonce,
                serverNonce: makeServerNonce(),
                metadata: .init(
                    version: hello.extensionVersion,
                    protocolVersion: hello.protocolVersion,
                    profileID: normalizedProfileID(hello.profileId)
                )
            ))
        }

        // An older build, which puts the token itself in the first frame. It cannot
        // finish this exchange, but it can be told why, and having sent the right
        // token is what lets its version be recorded.
        guard let presented = frame.auth else { return nil }
        guard tokensMatch(presented, token) else { return .rejectToken }
        return .rejectProtocol(
            extensionVersion: frame.extensionVersion,
            // Builds older than protocol 1 sent no number at all.
            protocolVersion: frame.protocolVersion ?? 0,
            tokenVerified: true
        )
    }

    /// The frame the server sends in answer to an accepted hello.
    static func challengeFrame(for pending: PendingHandshake, token: String, port: UInt16) -> [String: Any] {
        [
            "challenge": [
                "serverNonce": pending.serverNonce,
                "serverProof": serverProof(
                    token: token,
                    port: port,
                    clientNonce: pending.clientNonce,
                    serverNonce: pending.serverNonce
                ),
                "protocolVersion": MCPSafariProduct.bridgeProtocolVersion,
                "serverVersion": MCPSafariProduct.version,
            ] as [String: Any],
        ]
    }

    /// Judges the second frame against the challenge it answers. Nil means it is
    /// not the proof frame, and the bridge closes the connection.
    static func finish(
        with data: Data,
        pending: PendingHandshake,
        token: String,
        port: UInt16
    ) -> HandshakeFinish? {
        guard data.count <= maxFrameBytes,
              let frame = try? JSONDecoder().decode(ProofFrame.self, from: data)
        else { return nil }

        guard isValidClientProof(
            frame.auth.clientProof,
            token: token,
            port: port,
            clientNonce: pending.clientNonce,
            serverNonce: pending.serverNonce
        ) else { return .rejectToken }
        return .accept(pending.metadata)
    }

    /// Compares two tokens without stopping at the first byte that differs.
    ///
    /// `String ==` returns as soon as it finds a difference, so how long a wrong
    /// guess takes tells the guesser how much of it was right. The length is
    /// compared first and openly: it is not secret, since every token is a UUID.
    static func tokensMatch(_ presented: String, _ expected: String) -> Bool {
        let presented = Array(presented.utf8)
        let expected = Array(expected.utf8)
        guard presented.count == expected.count else { return false }
        var difference: UInt8 = 0
        for index in presented.indices { difference |= presented[index] ^ expected[index] }
        return difference == 0
    }
}

extension Data {
    /// Base64url without padding, the encoding the protocol uses for nonces and proofs.
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Nil unless `text` is strictly base64url without padding. The standard decoder
    /// is lenient about alphabet and padding, and a proof should have one spelling.
    init?(base64URL text: String) {
        guard text.utf8.allSatisfy({ byte in
            (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
                || (byte >= 0x30 && byte <= 0x39) || byte == 0x2D || byte == 0x5F
        }), text.utf8.count % 4 != 1 else { return nil }
        var standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        standard += String(repeating: "=", count: (4 - standard.utf8.count % 4) % 4)
        self.init(base64Encoded: standard)
    }
}

/// One accepted socket, carrying an identity that is not its address.
///
/// The registries used to be keyed on `ObjectIdentifier`, which is the object's
/// address, and an address is reused once the object behind it is gone. A new
/// connection landing where a dead one used to be inherited its profile mapping
/// and could take delivery of a response meant for it. A counter cannot collide,
/// and `NWConnection` has nowhere to hang one, so it gets a wrapper.
final class BridgeConnection: Sendable {
    let id: UInt64
    let socket: NWConnection

    init(id: UInt64, socket: NWConnection) {
        self.id = id
        self.socket = socket
    }
}
