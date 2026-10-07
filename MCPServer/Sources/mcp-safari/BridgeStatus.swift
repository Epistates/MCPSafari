import Foundation

// MARK: - Bridge Status

/// The shapes the bridge reports itself in, for `status` and `doctor`.
///
/// All `Codable` value types with no behaviour, so they sit apart from the
/// actor that fills them in.
extension WebSocketBridge {
    struct Failure: Codable, Equatable {
        let code: String
        let message: String
        let recovery: String

        static func protocolMismatch(extensionProtocolVersion: Int) -> Self {
            .init(
                code: "protocol_version_mismatch",
                message: "Extension bridge protocol \(extensionProtocolVersion) does not match server protocol \(MCPSafariProduct.bridgeProtocolVersion).",
                recovery: "Install matching MCPSafari app and mcp-safari server versions, then restart Safari and the MCP client."
            )
        }
    }

    enum ListenerStatus: String, Codable {
        case stopped
        case binding
        case listening
        case failed
    }

    enum ConnectionStatus: String, Codable {
        case disconnected
        case authenticating
        case authenticated
    }

    /// One connected Safari profile. Safari exposes no profile *name* to either the
    /// extension or the app extension, so `id` is the opaque `SFExtensionProfileKey`
    /// UUID (or `"default"`), and `index` is this server's stable short handle for it.
    struct ProfileStatus: Codable, Equatable {
        let id: String
        let index: Int
        /// The `p<index>` prefix that this profile's tab handles carry.
        let handle: String
        /// Whether a call that names no tab drives this profile.
        let selected: Bool
        let extensionVersion: String?
        let extensionProtocolVersion: Int?
    }

    /// What one profile made of a broadcast. Failures are reported rather than
    /// thrown, because one profile refusing a read is not a reason to withhold
    /// what the others returned.
    struct ProfileOutcome: Sendable {
        /// Answered and unreachable are the only two ways this ends, so they are
        /// the only two it can hold. A `BridgeResponse?` beside a `String?` could
        /// also be both at once, or neither, and every reader had to decide what
        /// those meant.
        enum Reply: Sendable {
            /// The profile replied. The reply can still carry a refusal.
            case answered(BridgeResponse)
            /// Nothing came back: a timeout, a dropped connection, a send that threw.
            case unreachable(String)
        }

        let index: Int
        let profileID: String
        let reply: Reply

        /// How a profile is named in anything a user reads, e.g. `p1 (WORK-UUID)`.
        var label: String { "p\(index) (\(profileID))" }
    }

    struct Status: Codable, Equatable {
        let serverVersion: String
        let protocolVersion: Int
        let requestedPort: UInt16
        let port: UInt16
        let listener: ListenerStatus
        let bridge: ConnectionStatus
        let tokenFileExists: Bool
        let tokenFileSecure: Bool?
        let extensionVersion: String?
        let extensionProtocolVersion: Int?
        let profiles: [ProfileStatus]
        let lastError: Failure?

        enum CodingKeys: String, CodingKey {
            case serverVersion
            case protocolVersion
            case requestedPort
            case port
            case listener
            case bridge
            case tokenFileExists
            case tokenFileSecure
            case extensionVersion
            case extensionProtocolVersion
            case profiles
            case lastError
        }

        func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(serverVersion, forKey: .serverVersion)
            try container.encode(protocolVersion, forKey: .protocolVersion)
            try container.encode(requestedPort, forKey: .requestedPort)
            try container.encode(port, forKey: .port)
            try container.encode(listener, forKey: .listener)
            try container.encode(bridge, forKey: .bridge)
            try container.encode(tokenFileExists, forKey: .tokenFileExists)
            if let tokenFileSecure {
                try container.encode(tokenFileSecure, forKey: .tokenFileSecure)
            } else {
                try container.encodeNil(forKey: .tokenFileSecure)
            }
            if let extensionVersion {
                try container.encode(extensionVersion, forKey: .extensionVersion)
            } else {
                try container.encodeNil(forKey: .extensionVersion)
            }
            if let extensionProtocolVersion {
                try container.encode(extensionProtocolVersion, forKey: .extensionProtocolVersion)
            } else {
                try container.encodeNil(forKey: .extensionProtocolVersion)
            }
            try container.encode(profiles, forKey: .profiles)
            if let lastError {
                try container.encode(lastError, forKey: .lastError)
            } else {
                try container.encodeNil(forKey: .lastError)
            }
        }
    }
}
