import Foundation
import Logging

enum CLICommand: Equatable {
    case serve(port: UInt16, portCount: UInt16 = WebSocketBridge.defaultPortCount, logLevel: Logger.Level)
    case doctor(port: UInt16, portCount: UInt16 = WebSocketBridge.defaultPortCount, json: Bool)
    case help
    case version
}

/// Routine lifecycle chatter is not worth surfacing by default: stderr is the
/// only channel a stdio server has, and MCP clients show it to the user.
/// Warnings and errors still come through; `--log-level info` brings the rest back.
let defaultLogLevel: Logger.Level = .notice

struct CLIError: Error, CustomStringConvertible {
    let description: String
}

func parseCommand(
    arguments: [String],
    environment: [String: String] = ProcessInfo.processInfo.environment
) throws -> CLICommand {
    // Both win over everything else on the line, including a bad argument next to
    // them: someone reaching for --help is asking what the arguments are.
    if arguments.contains(where: { $0 == "--help" || $0 == "-h" }) { return .help }
    if arguments.contains(where: { $0 == "--version" || $0 == "-V" }) { return .version }

    let doctorMode = arguments.first == "doctor"
    let options = doctorMode ? Array(arguments.dropFirst()) : arguments
    var port: UInt16 = 8089
    var explicitPortCount: (value: UInt16, source: String)?
    var logLevel: Logger.Level?
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
        case "--port-range":
            guard index + 1 < options.count, let parsed = portCount(from: options[index + 1]) else {
                throw CLIError(description: "--port-range requires \(portCountUsage)")
            }
            explicitPortCount = (parsed, "--port-range")
            index += 2
        case "--log-level" where !doctorMode:
            guard index + 1 < options.count else {
                throw CLIError(description: logLevelUsage)
            }
            guard let parsed = Logger.Level(rawValue: options[index + 1].lowercased()) else {
                throw CLIError(description: "Unknown log level: \(options[index + 1]). \(logLevelUsage)")
            }
            logLevel = parsed
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

    // The flag beats the environment, as with the log level. A value that was asked
    // for and cannot be honoured is an error rather than a quiet fallback to ten:
    // the user would find out when the extension missed a server.
    if explicitPortCount == nil, let text = environment[portRangeEnvironmentVariable]?
        .trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
        guard let parsed = portCount(from: text) else {
            throw CLIError(description: "\(portRangeEnvironmentVariable) must be \(portCountUsage), not \(text)")
        }
        explicitPortCount = (parsed, portRangeEnvironmentVariable)
    }
    // Only an explicit count is held to this. The default has always shortened
    // itself near the top of the port space, and refusing it would stop a
    // `--port 65535` that works today.
    if let (count, source) = explicitPortCount, UInt32(port) + UInt32(count) - 1 > UInt32(UInt16.max) {
        throw CLIError(
            description: "--port \(port) with a range of \(count) ports (set by \(source)) runs past port 65535. "
                + "Lower the port or the range."
        )
    }
    let portCount = explicitPortCount?.value ?? WebSocketBridge.defaultPortCount

    if doctorMode { return .doctor(port: port, portCount: portCount, json: json) }

    // An explicit flag beats --verbose, which beats the environment. MCP client
    // configs can set env but not always argv, so both need to work.
    let fromEnvironment = environment["MCP_SAFARI_LOG_LEVEL"].map { value -> Logger.Level in
        Logger.Level(rawValue: value.lowercased()) ?? defaultLogLevel
    }
    let resolved = logLevel ?? (verbose ? .debug : nil) ?? fromEnvironment ?? defaultLogLevel
    return .serve(port: port, portCount: portCount, logLevel: resolved)
}

/// A whole number of ports from one through `WebSocketBridge.maxPortCount`, or nil.
private func portCount(from text: String) -> UInt16? {
    guard let parsed = UInt16(text), (1...WebSocketBridge.maxPortCount).contains(parsed) else { return nil }
    return parsed
}

let portRangeEnvironmentVariable = "MCP_SAFARI_PORT_RANGE"
let portCountUsage = "a whole number of ports from 1 through \(WebSocketBridge.maxPortCount)"
let logLevelUsage = "Use trace, debug, info, notice, warning, error, or critical."

let usageText = """
    mcp-safari \(MCPSafariProduct.version)
    Safari browser automation over the Model Context Protocol.

    USAGE:
      mcp-safari [options]          Serve MCP over stdio
      mcp-safari doctor [options]   Report on the installation and exit

    OPTIONS:
      -p, --port <n>        WebSocket port the Safari extension connects to (default: 8089)
          --port-range <n>  Ports to try from --port when one is taken, 1 through 64 (default: 10)
          --log-level <l>   trace, debug, info, notice, warning, error, critical (default: notice)
          --verbose         Shorthand for --log-level debug
      -h, --help            Show this help and exit
      -V, --version         Show the version and exit

    DOCTOR OPTIONS:
      -p, --port <n>        First port whose token file to check (default: 8089)
          --port-range <n>  Ports to check from --port, 1 through 64 (default: 10)
          --json            Emit the report as JSON

    ENVIRONMENT:
      MCP_SAFARI_LOG_LEVEL   Log level used when --log-level and --verbose are absent
      MCP_SAFARI_PORT_RANGE  Port count used when --port-range is absent

    The Safari extension finds a server through its token file, so the port range needs no
    matching setting there.

    Logs go to stderr. stdout carries the MCP stdio transport, so nothing else writes there.
    https://github.com/Epistates/MCPSafari
    """

enum MCPSafariProduct {
    static let version = "0.4.0"
    static let bridgeProtocolVersion = 2
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

    func encode(to encoder: any Encoder) throws {
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

    /// argv[0] is whatever the parent process handed to `exec`, so it can be a bare
    /// name, a relative path, or something unrelated. Invoked through `$PATH` it
    /// carries no directory at all, and `URL(fileURLWithPath:)` then resolves it
    /// against the working directory: `doctor` run from `/tmp` went looking for
    /// `/private/tmp/mcp-safari` and called a healthy install broken. SE-0513 adds
    /// `CommandLine.executablePath` for exactly this, but it is not in the toolchain
    /// yet, and Foundation already knows the real path.
    static func resolveExecutableURL(
        bundlePath: String? = Bundle.main.executablePath,
        argv0: String = CommandLine.arguments[0]
    ) -> URL {
        URL(fileURLWithPath: bundlePath ?? argv0).resolvingSymlinksInPath()
    }

    static var system: DoctorPaths {
        DoctorPaths(
            executableURL: resolveExecutableURL(),
            appURL: URL(fileURLWithPath: "/Applications/MCPSafari.app"),
            tokenDirectoryURL: WebSocketBridge.tokenDirectoryURL
        )
    }
}

/// What PlugInKit says about the Safari extension.
///
/// One value rather than a `Bool?` alongside a `String?`. That pair admits a
/// state that cannot exist, not registered yet here is its path, and filling it
/// in took two `pluginkit` readings that were free to disagree with each other.
enum ExtensionRegistration: Equatable, Sendable {
    /// PlugInKit could not be asked, which is not the same as an answer of no.
    case unknown
    case notRegistered
    /// Registered, with where it was loaded from when that could be read.
    case registered(bundlePath: String?)

    /// The shape the JSON report has always carried.
    var isRegistered: Bool? {
        switch self {
        case .unknown: nil
        case .notRegistered: false
        case .registered: true
        }
    }

    var bundlePath: String? {
        guard case .registered(let path) = self else { return nil }
        return path
    }
}

enum Doctor {
    static func inspect(
        paths: DoctorPaths = .system,
        port: UInt16 = 8089,
        portCount: UInt16 = WebSocketBridge.defaultPortCount,
        registration: ExtensionRegistration = .unknown
    ) -> DoctorReport {
        let extensionRegistered = registration.isRegistered
        let registeredExtensionPath = registration.bundlePath
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

        // Safari runs whichever bundle PlugInKit registered, and that is not
        // always the one inside the installed app. Reading the version from the
        // installed copy reports a match while Safari runs something else, which
        // is how a stale build stays invisible: every check passes and the wrong
        // extension is driving. Ask the bundle Safari actually loaded.
        let runningExtensionURL = registeredExtensionPath.map(URL.init(fileURLWithPath:)) ?? extensionURL
        let extensionVersion = bundleVersion(at: runningExtensionURL)
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

        // Safari's own Uninstall button deletes MCPSafari.app outright. On a
        // machine with an Xcode checkout, PlugInKit then falls back to whatever
        // debug build is sitting in DerivedData, and because neighbouring
        // versions share a bridge protocol the handshake accepts it. The result
        // is an old extension driving a current server with nothing to say so.
        //
        // Only when an app is actually installed where we expect one. Someone
        // running MCPSafari.app from somewhere else entirely is already being
        // told that by `app_installed`, and a second warning saying the same
        // thing in different words helps nobody. The case worth flagging is the
        // confusing one: the app is installed, and Safari is running something
        // else anyway.
        if appInstalled, let registeredExtensionPath, !registeredExtensionPath.isEmpty {
            let isInstalledCopy = registeredExtensionPath.hasPrefix(paths.appURL.path + "/")
            checks.append(.init(
                code: "extension_location",
                status: isInstalledCopy ? .ok : .warning,
                message: isInstalledCopy
                    ? "Safari is using the installed extension."
                    : "MCPSafari.app is installed, but Safari is running the extension from "
                      + "\(registeredExtensionPath) instead.",
                recovery: isInstalledCopy
                    ? nil
                    : "That build can be any version. Open \(paths.appURL.path) once so PlugInKit "
                      + "re-registers it, then reopen Safari."
            ))
        }

        checks.append(tokenFileCheck(
            in: paths.tokenDirectoryURL,
            ports: port...WebSocketBridge.lastPort(from: port, count: portCount)
        ))

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

    /// Asks PlugInKit once. `-v` appends the bundle path to each match, which is
    /// how the extension Safari actually loaded gets identified, and that is not
    /// always the one inside the installed app.
    static func extensionRegistration() -> ExtensionRegistration {
        guard let output = pluginkitOutput() else { return .unknown }
        guard output.contains(MCPSafariProduct.extensionBundleIdentifier) else {
            return .notRegistered
        }
        return .registered(bundlePath: parseExtensionPath(from: output))
    }

    /// The path is the tail of the line, after the date, and can contain spaces
    /// ("MCPSafari Extension.appex"), so it is taken from the first path
    /// separator rather than by splitting on whitespace.
    static func parseExtensionPath(from output: String) -> String? {
        for line in output.split(separator: "\n") {
            guard line.contains(MCPSafariProduct.extensionBundleIdentifier),
                  let start = line.firstIndex(of: "/")
            else { continue }
            let path = line[start...].trimmingCharacters(in: .whitespacesAndNewlines)
            if !path.isEmpty { return path }
        }
        return nil
    }

    private static func pluginkitOutput() -> String? {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/pluginkit")
        process.arguments = ["-m", "-v", "-i", MCPSafariProduct.extensionBundleIdentifier]
        process.standardOutput = output
        process.standardError = Pipe()

        do {
            try process.run()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { return nil }
            return String(decoding: data, as: UTF8.self)
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

    /// Looks for the token a server leaves for the extension, anywhere in the range
    /// that server was told to use. A server whose first port was taken binds a
    /// later one and writes its token there, so checking only the first port
    /// called a working install broken.
    static func tokenFileCheck(in tokenDirectoryURL: URL, ports: ClosedRange<UInt16>) -> DiagnosticCheck {
        let fileManager = FileManager.default
        let present = ports
            .map { tokenDirectoryURL.appendingPathComponent(String($0)) }
            .filter { fileManager.fileExists(atPath: $0.path) }
        let insecure = present.filter { url in
            let permissions = (try? fileManager.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue
            return permissions != 0o600
        }

        guard !present.isEmpty else {
            let scanned = ports.lowerBound == ports.upperBound
                ? "at \(tokenDirectoryURL.appendingPathComponent(String(ports.lowerBound)).path)"
                : "for ports \(ports.lowerBound)-\(ports.upperBound) in \(tokenDirectoryURL.path)"
            return .init(
                code: "token_file",
                status: .warning,
                message: "No authentication token file exists \(scanned).",
                recovery: "Start an MCP client configured to run mcp-safari."
            )
        }
        guard insecure.isEmpty else {
            return .init(
                code: "token_file",
                status: .warning,
                message: "Authentication token file exists at \(insecure.map(\.path).joined(separator: ", ")), "
                    + "but its permissions are not 0600.",
                recovery: "Restart mcp-safari to recreate the token file securely."
            )
        }
        let located = present.count == 1
            ? "at \(present[0].path)"
            : "for ports \(present.map(\.lastPathComponent).joined(separator: ", ")) in \(tokenDirectoryURL.path)"
        return .init(
            code: "token_file",
            status: .ok,
            message: "Authentication token file exists with mode 0600 \(located).",
            recovery: nil
        )
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
