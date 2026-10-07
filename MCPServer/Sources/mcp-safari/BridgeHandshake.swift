import Foundation
import Network

// MARK: - Handshake

/// What the extension sends on connecting, and how the bridge reads it.
///
/// The first frame on a new socket has to be the token, so this is the only
/// part of the protocol an unauthenticated peer can reach. It is kept pure and
/// apart from the actor for that reason: deciding whether a frame is a valid
/// handshake needs no connection state, and the tests drive it directly.
struct ExtensionMetadata: Codable, Equatable {
    let version: String?
    let protocolVersion: Int?
    /// Which Safari profile's extension instance authenticated. Safari omits the
    /// profile key for the default profile, and extension builds predating profile
    /// support send nothing at all, so both land on `WebSocketBridge.defaultProfileID`.
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

enum HandshakeDecision: Equatable {
    case accept(ExtensionMetadata)
    case rejectToken
    case rejectProtocol(extensionVersion: String?, protocolVersion: Int)
}

enum BridgeHandshake {
    private struct Message: Decodable {
        let auth: String
        let extensionVersion: String?
        let protocolVersion: Int?
        let profileId: String?
    }

    /// Blank or absent means the default profile, which is also what Safari sends
    /// for it and what an extension build without profile support sends for every
    /// profile. Trimmed because it is reflected back in log lines.
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

    static func decision(for data: Data, expectedToken: String) -> HandshakeDecision? {
        guard let message = try? JSONDecoder().decode(Message.self, from: data) else { return nil }
        guard message.auth == expectedToken else { return .rejectToken }
        if let protocolVersion = message.protocolVersion,
           protocolVersion != MCPSafariProduct.bridgeProtocolVersion {
            return .rejectProtocol(
                extensionVersion: message.extensionVersion,
                protocolVersion: protocolVersion
            )
        }
        return .accept(.init(
            version: message.extensionVersion,
            protocolVersion: message.protocolVersion,
            profileID: normalizedProfileID(message.profileId)
        ))
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
