import Foundation

enum CLICommand: Equatable {
    case serve(port: UInt16, verbose: Bool)
    case doctor(port: UInt16, json: Bool)
}

struct CLIError: Error, CustomStringConvertible {
    let description: String
}

func parseCommand(arguments: [String]) throws -> CLICommand {
    let doctorMode = arguments.first == "doctor"
    let options = doctorMode ? Array(arguments.dropFirst()) : arguments
    var port: UInt16 = 8089
    var verbose = false
    var json = false
    var index = 0

    while index < options.count {
        switch options[index] {
        case "--port", "-p":
            guard index + 1 < options.count, let parsed = UInt16(options[index + 1]) else {
                throw CLIError(description: "--port requires a value from 0 through 65535")
            }
            port = parsed
            index += 2
        case "--verbose" where !doctorMode:
            verbose = true
            index += 1
        case "--json" where doctorMode:
            json = true
            index += 1
        default:
            throw CLIError(description: "Unknown argument: \(options[index])")
        }
    }

    return doctorMode ? .doctor(port: port, json: json) : .serve(port: port, verbose: verbose)
}

enum MCPSafariProduct {
    static let version = "0.2.9"
    static let bridgeProtocolVersion = 1
    static let extensionBundleIdentifier = "com.epistates.MCPSafari.Extension"
}

enum DiagnosticStatus: String, Codable {
    case ok
    case warning
    case error
}

struct DiagnosticCheck: Codable, Equatable {
    let code: String
    let status: DiagnosticStatus
    let message: String
    let recovery: String?
}

struct DoctorReport: Codable, Equatable {
    let serverVersion: String
    let appVersion: String?
    let extensionVersion: String?
    let extensionRegistered: Bool?
    let extensionEnabled: String
    let overall: DiagnosticStatus
    let checks: [DiagnosticCheck]

    var exitCode: Int32 { overall == .error ? 1 : 0 }

    enum CodingKeys: String, CodingKey {
        case serverVersion
        case appVersion
        case extensionVersion
        case extensionRegistered
        case extensionEnabled
        case overall
        case checks
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(serverVersion, forKey: .serverVersion)
        try container.encodeIfPresent(appVersion, forKey: .appVersion)
        if appVersion == nil { try container.encodeNil(forKey: .appVersion) }
        try container.encodeIfPresent(extensionVersion, forKey: .extensionVersion)
        if extensionVersion == nil { try container.encodeNil(forKey: .extensionVersion) }
        try container.encodeIfPresent(extensionRegistered, forKey: .extensionRegistered)
        if extensionRegistered == nil { try container.encodeNil(forKey: .extensionRegistered) }
        try container.encode(extensionEnabled, forKey: .extensionEnabled)
        try container.encode(overall, forKey: .overall)
        try container.encode(checks, forKey: .checks)
    }
}

struct DoctorPaths {
    let executableURL: URL
    let appURL: URL
    let tokenDirectoryURL: URL

    static var system: DoctorPaths {
        DoctorPaths(
            executableURL: URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath(),
            appURL: URL(fileURLWithPath: "/Applications/MCPSafari.app"),
            tokenDirectoryURL: WebSocketBridge.tokenDirectoryURL
        )
    }
}

enum Doctor {
    static func inspect(
        paths: DoctorPaths = .system,
        port: UInt16 = 8089,
        extensionRegistered: Bool? = nil
    ) -> DoctorReport {
        let fileManager = FileManager.default
        var checks: [DiagnosticCheck] = []

        checks.append(check(
            code: "server_executable",
            passes: fileManager.isExecutableFile(atPath: paths.executableURL.path),
            success: "Server executable is available at \(paths.executableURL.path).",
            failure: "Server executable is missing or not executable at \(paths.executableURL.path).",
            recovery: "Reinstall the mcp-safari formula."
        ))

        let appInstalled = fileManager.fileExists(atPath: paths.appURL.path)
        checks.append(check(
            code: "app_installed",
            passes: appInstalled,
            success: "MCPSafari.app is installed.",
            failure: "MCPSafari.app is not installed at \(paths.appURL.path).",
            recovery: "Install MCPSafari.app in /Applications."
        ))

        let appVersion = bundleVersion(at: paths.appURL)
        if appInstalled {
            checks.append(versionCheck(code: "app_version", label: "App", version: appVersion))
        }

        let extensionURL = paths.appURL
            .appendingPathComponent("Contents/PlugIns")
            .appendingPathComponent("MCPSafari Extension.appex")
        let extensionInstalled = fileManager.fileExists(atPath: extensionURL.path)
        checks.append(check(
            code: "extension_installed",
            passes: extensionInstalled,
            success: "Safari extension bundle is installed.",
            failure: "Safari extension bundle is missing from MCPSafari.app.",
            recovery: "Reinstall MCPSafari.app."
        ))

        let extensionVersion = bundleVersion(at: extensionURL)
        if extensionInstalled {
            checks.append(versionCheck(
                code: "extension_version",
                label: "Extension",
                version: extensionVersion
            ))
        }

        switch extensionRegistered {
        case true:
            checks.append(.init(
                code: "extension_registered",
                status: .ok,
                message: "Safari extension is registered with PlugInKit.",
                recovery: nil
            ))
        case false:
            checks.append(.init(
                code: "extension_registered",
                status: .error,
                message: "Safari extension is not registered with PlugInKit.",
                recovery: "Open /Applications/MCPSafari.app once, then reopen Safari."
            ))
        case nil:
            checks.append(.init(
                code: "extension_registered",
                status: .warning,
                message: "Safari extension registration was not checked.",
                recovery: "Run mcp-safari doctor from Terminal for a PlugInKit check."
            ))
        }

        let tokenURL = paths.tokenDirectoryURL.appendingPathComponent(String(port))
        if fileManager.fileExists(atPath: tokenURL.path) {
            let permissions = (try? fileManager.attributesOfItem(atPath: tokenURL.path)[.posixPermissions] as? NSNumber)?.intValue
            checks.append(.init(
                code: "token_file",
                status: permissions == 0o600 ? .ok : .warning,
                message: permissions == 0o600
                    ? "Authentication token file exists with mode 0600 at \(tokenURL.path)."
                    : "Authentication token file exists at \(tokenURL.path), but its permissions are not 0600.",
                recovery: permissions == 0o600 ? nil : "Restart mcp-safari to recreate the token file securely."
            ))
        } else {
            checks.append(.init(
                code: "token_file",
                status: .warning,
                message: "No authentication token file exists at \(tokenURL.path).",
                recovery: "Start an MCP client configured to run mcp-safari."
            ))
        }

        checks.append(tokenPathCheck(for: paths.tokenDirectoryURL))

        let overall: DiagnosticStatus = checks.contains { $0.status == .error }
            ? .error
            : checks.contains { $0.status == .warning } ? .warning : .ok
        return DoctorReport(
            serverVersion: MCPSafariProduct.version,
            appVersion: appVersion,
            extensionVersion: extensionVersion,
            extensionRegistered: extensionRegistered,
            extensionEnabled: "unknown",
            overall: overall,
            checks: checks
        )
    }

    static func isExtensionRegistered() -> Bool? {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pluginkit")
        process.arguments = ["-m", "-i", MCPSafariProduct.extensionBundleIdentifier]
        process.standardOutput = output
        process.standardError = Pipe()

        do {
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            let data = output.fileHandleForReading.readDataToEndOfFile()
            return String(decoding: data, as: UTF8.self).contains(MCPSafariProduct.extensionBundleIdentifier)
        } catch {
            return nil
        }
    }

    static func json(_ report: DoctorReport) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return String(decoding: try encoder.encode(report), as: UTF8.self)
    }

    static func humanReadable(_ report: DoctorReport) -> String {
        var lines = [
            "MCPSafari doctor: \(report.overall.rawValue)",
            "Extension enabled: \(report.extensionEnabled)",
        ]
        for check in report.checks {
            lines.append("[\(check.status.rawValue)] \(check.code): \(check.message)")
            if let recovery = check.recovery {
                lines.append("  Recovery: \(recovery)")
            }
        }
        return lines.joined(separator: "\n")
    }

    /// The extension reads tokens through a sandbox exception granted on a
    /// literal home-relative path, which the sandbox evaluates against the
    /// resolved path. A symlink anywhere in the token directory puts the real
    /// file outside that grant: the server writes it, the extension cannot read
    /// it, and nothing else in the system reports why.
    static func tokenPathCheck(for tokenDirectoryURL: URL) -> DiagnosticCheck {
        let literal = tokenDirectoryURL.standardizedFileURL.path
        let resolved = tokenDirectoryURL.resolvingSymlinksInPath().standardizedFileURL.path

        guard literal != resolved else {
            return .init(
                code: "token_path",
                status: .ok,
                message: "Token directory is a real path the extension sandbox can read.",
                recovery: nil
            )
        }

        return .init(
            code: "token_path",
            status: .warning,
            message: "Token directory \(literal) resolves to \(resolved). "
                + "The Safari extension is sandboxed and can only read the unresolved path, "
                + "so it will not find the token and will stay disconnected.",
            recovery: "Replace the symlink with a real directory, "
                + "or symlink the sibling directories you manage instead of the parent."
        )
    }

    private static func check(
        code: String,
        passes: Bool,
        success: String,
        failure: String,
        recovery: String
    ) -> DiagnosticCheck {
        DiagnosticCheck(
            code: code,
            status: passes ? .ok : .error,
            message: passes ? success : failure,
            recovery: passes ? nil : recovery
        )
    }

    private static func versionCheck(code: String, label: String, version: String?) -> DiagnosticCheck {
        guard let version else {
            return .init(
                code: code,
                status: .warning,
                message: "\(label) version could not be read.",
                recovery: "Reinstall MCPSafari.app."
            )
        }
        guard version == MCPSafariProduct.version else {
            return .init(
                code: code,
                status: .error,
                message: "\(label) version \(version) does not match server \(MCPSafariProduct.version).",
                recovery: "Upgrade the mcp-safari cask and formula together, then restart the MCP client."
            )
        }
        return .init(
            code: code,
            status: .ok,
            message: "\(label) version \(version) matches the server.",
            recovery: nil
        )
    }

    private static func bundleVersion(at bundleURL: URL) -> String? {
        guard let bundle = Bundle(url: bundleURL) else { return nil }
        return bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }
}
