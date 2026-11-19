import Foundation

/// Who this server is, as the Safari extension's popup names it.
///
/// Several MCP clients can share one Safari, each through a server of its own,
/// and the extension connects to all of them. A port number says nothing about
/// which session is behind it, so the server tells the extension its name: the
/// `--name` given at launch, or else the folder it was started in, which for a
/// coding agent is its project. The popup shows that next to the port.
///
/// None of it is proof. A process running as the user can claim any name, which
/// is outside the bridge's threat model (see SECURITY.md). It is a label for the
/// user, sent only after the handshake has proved the server holds the token.
struct InstanceIdentity: Equatable, Sendable {
    static let nameEnvironmentVariable = "MCP_SAFARI_NAME"
    /// The extension's limit, `MAX_INSTANCE_NAME_LENGTH`.
    static let maxNameLength = 64

    static let nameUsage = "--name takes 1 to \(maxNameLength) characters, with no control characters"

    /// What `--name` or `MCP_SAFARI_NAME` set, if anything.
    var name: String?
    /// The folder the server was started in, as an absolute path.
    var folder: String?

    init(name: String? = nil, folder: String? = nil) {
        self.name = name
        self.folder = folder
    }

    /// `text` as a name, or an error saying what a name may be.
    static func validatedName(_ text: String) throws -> String {
        let name = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= maxNameLength,
              !name.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) })
        else { throw CLIError(description: nameUsage) }
        return name
    }

    /// The folder a server reports: where it was started, unless that was `/`,
    /// which is what a client with no project starts it in and says nothing.
    static func launchFolder(_ path: String = FileManager.default.currentDirectoryPath) -> String? {
        let standardized = URL(fileURLWithPath: path).standardizedFileURL.path
        return standardized == "/" || !standardized.hasPrefix("/") ? nil : standardized
    }

    /// The `instance` field of the handshake's `auth: ok` frame. Empty when the
    /// server has neither, and the extension then names the connection by its port.
    var frameObject: [String: Any] {
        var object: [String: Any] = [:]
        if let name { object["name"] = name }
        if let folder { object["folder"] = folder }
        return object
    }
}

/// The MCP client behind this server, as it introduced itself in `initialize`.
/// Self-reported and shown to the user as a label; never used to decide anything.
struct ClientIdentity: Equatable, Sendable {
    let name: String
    let version: String?

    var frameObject: [String: Any] {
        var object: [String: Any] = ["name": name]
        if let version { object["version"] = version }
        return object
    }

    var parameters: [String: AnyCodable] {
        var object: [String: AnyCodable] = ["name": AnyCodable(name)]
        if let version { object["version"] = AnyCodable(version) }
        return ["client": AnyCodable(object)]
    }
}
