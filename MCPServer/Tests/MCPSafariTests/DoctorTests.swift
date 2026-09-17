import Foundation
import Testing
@testable import MCPSafari

struct DoctorTests {
    @Test func healthyInstallationProducesPasteSafeJSON() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let executable = root.appendingPathComponent("mcp-safari")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data().write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        let app = root.appendingPathComponent("MCPSafari.app")
        try writeBundle(at: app, identifier: "com.epistates.MCPSafari")
        try writeBundle(
            at: app.appendingPathComponent("Contents/PlugIns/MCPSafari Extension.appex"),
            identifier: MCPSafariProduct.extensionBundleIdentifier
        )

        let tokens = root.appendingPathComponent("tokens")
        try FileManager.default.createDirectory(at: tokens, withIntermediateDirectories: true)
        let token = tokens.appendingPathComponent("8089")
        try "do-not-print-this-token".write(to: token, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: token.path)

        let report = Doctor.inspect(
            paths: .init(executableURL: executable, appURL: app, tokenDirectoryURL: tokens),
            registration: .registered(bundlePath: nil)
        )
        let json = try Doctor.json(report)

        #expect(report.overall == .ok)
        #expect(report.appVersion == MCPSafariProduct.version)
        #expect(report.extensionVersion == MCPSafariProduct.version)
        #expect(report.extensionRegistered == true)
        #expect(report.extensionEnabled == "unknown")
        #expect(json.contains(#""extensionEnabled" : "unknown""#))
        #expect(!json.contains("do-not-print-this-token"))
        #expect(try JSONDecoder().decode(DoctorReport.self, from: Data(json.utf8)) == report)
    }

    @Test func versionMismatchAndUnsafeTokenAreDistinctChecks() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let executable = root.appendingPathComponent("mcp-safari")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data().write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        let app = root.appendingPathComponent("MCPSafari.app")
        try writeBundle(at: app, identifier: "com.epistates.MCPSafari", version: "0.2.8")
        try writeBundle(
            at: app.appendingPathComponent("Contents/PlugIns/MCPSafari Extension.appex"),
            identifier: MCPSafariProduct.extensionBundleIdentifier
        )

        let tokens = root.appendingPathComponent("tokens")
        try FileManager.default.createDirectory(at: tokens, withIntermediateDirectories: true)
        let token = tokens.appendingPathComponent("8089")
        try "secret".write(to: token, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: token.path)

        let report = Doctor.inspect(
            paths: .init(executableURL: executable, appURL: app, tokenDirectoryURL: tokens),
            registration: .registered(bundlePath: nil)
        )

        #expect(report.checks.first { $0.code == "app_version" }?.status == .error)
        #expect(report.checks.first { $0.code == "token_file" }?.status == .warning)
        #expect(report.checks.first { $0.code == "token_file" }?.message.contains("permissions") == true)
    }

    @Test func executablePathIgnoresArgv0AndTheWorkingDirectory() {
        // Invoked through $PATH, argv[0] is a bare name. Resolving that against the
        // working directory is what made doctor report a healthy install as broken.
        let resolved = DoctorPaths.resolveExecutableURL(
            bundlePath: "/opt/test-prefix/Cellar/mcp-safari-server/0.3.1/bin/mcp-safari",
            argv0: "mcp-safari"
        )

        #expect(resolved.path == "/opt/test-prefix/Cellar/mcp-safari-server/0.3.1/bin/mcp-safari")
        #expect(!resolved.path.hasPrefix(FileManager.default.currentDirectoryPath + "/"))
    }

    @Test func executablePathFallsBackToArgv0WhenTheBundleHasNone() {
        let resolved = DoctorPaths.resolveExecutableURL(
            bundlePath: nil,
            argv0: "/opt/test-prefix/bin/mcp-safari"
        )

        #expect(resolved.path == "/opt/test-prefix/bin/mcp-safari")
    }

    @Test func parsesDoctorCommandWithoutStartingServer() throws {
        #expect(
            try parseCommand(arguments: ["doctor", "--json", "--port", "8123"])
                == .doctor(port: 8123, json: true)
        )
        #expect(throws: CLIError.self) {
            try parseCommand(arguments: ["doctor", "--port", "not-a-port"])
        }
        #expect(throws: CLIError.self) {
            try parseCommand(arguments: ["doctor", "--verbose"])
        }
        #expect(throws: CLIError.self) {
            try parseCommand(arguments: ["doctor", "--log-level", "debug"])
        }
    }

    @Test func helpAndVersionAreRecognisedArguments() throws {
        for argument in ["--help", "-h"] {
            #expect(try parseCommand(arguments: [argument], environment: [:]) == .help)
        }
        for argument in ["--version", "-V"] {
            #expect(try parseCommand(arguments: [argument], environment: [:]) == .version)
        }
    }

    @Test func helpWinsOverEverythingElseOnTheLine() throws {
        // Someone reaching for --help is asking what the arguments are, so a bad
        // one sitting next to it should not be what they get told about.
        #expect(try parseCommand(arguments: ["doctor", "--help"], environment: [:]) == .help)
        #expect(try parseCommand(arguments: ["--log-level", "chatty", "--help"], environment: [:]) == .help)
        #expect(try parseCommand(arguments: ["--nonsense", "-h"], environment: [:]) == .help)
        #expect(try parseCommand(arguments: ["doctor", "--version"], environment: [:]) == .version)
    }

    @Test func usageTextCoversEveryAcceptedFlag() {
        for flag in ["--port", "--log-level", "--verbose", "--json", "--help", "--version"] {
            #expect(usageText.contains(flag), "usage text is missing \(flag)")
        }
        #expect(usageText.contains(MCPSafariProduct.version))
        #expect(usageText.contains("MCP_SAFARI_LOG_LEVEL"))
        #expect(usageText.contains("doctor"))
    }

    @Test func serveDefaultsToQuietLogging() throws {
        // stderr is the only channel a stdio server has and clients show it to
        // the user, so routine lifecycle lines stay off unless asked for.
        #expect(try parseCommand(arguments: [], environment: [:]) == .serve(port: 8089, logLevel: .notice))
    }

    @Test func logLevelComesFromFlagVerboseOrEnvironment() throws {
        #expect(
            try parseCommand(arguments: ["--log-level", "warning"], environment: [:])
                == .serve(port: 8089, logLevel: .warning)
        )
        #expect(
            try parseCommand(arguments: ["--log-level", "INFO"], environment: [:])
                == .serve(port: 8089, logLevel: .info)
        )
        #expect(
            try parseCommand(arguments: ["--verbose"], environment: [:])
                == .serve(port: 8089, logLevel: .debug)
        )
        #expect(
            try parseCommand(arguments: [], environment: ["MCP_SAFARI_LOG_LEVEL": "trace"])
                == .serve(port: 8089, logLevel: .trace)
        )
        // An explicit flag wins over both --verbose and the environment.
        #expect(
            try parseCommand(
                arguments: ["--verbose", "--log-level", "error"],
                environment: ["MCP_SAFARI_LOG_LEVEL": "trace"]
            ) == .serve(port: 8089, logLevel: .error)
        )
        #expect(
            try parseCommand(arguments: ["--verbose"], environment: ["MCP_SAFARI_LOG_LEVEL": "trace"])
                == .serve(port: 8089, logLevel: .debug)
        )
    }

    @Test func rejectsAnUnknownLogLevel() {
        #expect(throws: CLIError.self) {
            try parseCommand(arguments: ["--log-level", "chatty"], environment: [:])
        }
        #expect(throws: CLIError.self) {
            try parseCommand(arguments: ["--log-level"], environment: [:])
        }
    }

    @Test func missingInstallationHasActionableErrors() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let executable = root.appendingPathComponent("mcp-safari")
        try Data().write(to: executable)

        let report = Doctor.inspect(
            paths: DoctorPaths(
                executableURL: executable,
                appURL: root.appendingPathComponent("MCPSafari.app"),
                tokenDirectoryURL: root.appendingPathComponent("tokens")
            ),
            port: 8089,
            registration: .notRegistered
        )

        #expect(report.overall == .error)
        #expect(report.appVersion == nil)
        #expect(report.extensionVersion == nil)
        #expect(report.extensionEnabled == "unknown")
        #expect(report.checks.first { $0.code == "app_installed" }?.status == .error)
        #expect(report.checks.first { $0.code == "app_installed" }?.recovery == "Install MCPSafari.app in /Applications.")
        #expect(report.checks.first { $0.code == "extension_registered" }?.status == .error)
        #expect(report.checks.first { $0.code == "token_file" }?.status == .warning)
    }

    /// Safari's own Uninstall button deletes the app, and PlugInKit then falls
    /// back to whatever debug build is in DerivedData. Since neighbouring
    /// versions share a bridge protocol the handshake accepts it, so nothing
    /// else in the product notices. This is the check that does.
    @Test func doctorFlagsAnExtensionLoadedFromOutsideTheInstalledApp() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let appURL = root.appendingPathComponent("MCPSafari.app")
        try writeBundle(at: appURL, identifier: "com.epistates.MCPSafari")
        let installedExtension = appURL
            .appendingPathComponent("Contents/PlugIns")
            .appendingPathComponent("MCPSafari Extension.appex")
        try writeBundle(at: installedExtension, identifier: MCPSafariProduct.extensionBundleIdentifier)

        let paths = DoctorPaths(
            executableURL: URL(fileURLWithPath: "/opt/homebrew/bin/mcp-safari"),
            appURL: appURL,
            tokenDirectoryURL: root.appendingPathComponent("tokens")
        )
        let strayBuild = root.appendingPathComponent("DerivedData/Debug/MCPSafari.app/Contents/PlugIns")
            .appendingPathComponent("MCPSafari Extension.appex")

        let stale = Doctor.inspect(
            paths: paths,
            port: 8089,
            registration: .registered(bundlePath: strayBuild.path)
        )
        let flagged = stale.checks.first { $0.code == "extension_location" }
        #expect(flagged?.status == .warning)
        #expect(flagged?.message.contains("DerivedData") == true)

        let installed = Doctor.inspect(
            paths: paths,
            port: 8089,
            registration: .registered(bundlePath: installedExtension.path)
        )
        #expect(installed.checks.first { $0.code == "extension_location" }?.status == .ok)

        // A path PlugInKit would not give us is not evidence of anything, so the
        // check stays quiet rather than inventing a warning.
        let unknown = Doctor.inspect(paths: paths, port: 8089, registration: .registered(bundlePath: nil))
        #expect(unknown.checks.contains { $0.code == "extension_location" } == false)
    }

    /// The version check read the installed bundle rather than the one Safari
    /// loaded, so a stale build reported a clean match and the real mismatch
    /// stayed invisible. That is what made the DerivedData fallback silent.
    @Test func theVersionCheckReadsTheBundleSafariActuallyLoaded() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let appURL = root.appendingPathComponent("MCPSafari.app")
        try writeBundle(at: appURL, identifier: "com.epistates.MCPSafari")
        let installedExtension = appURL
            .appendingPathComponent("Contents/PlugIns")
            .appendingPathComponent("MCPSafari Extension.appex")
        // The installed copy is current, so reading it would report all clear.
        try writeBundle(at: installedExtension, identifier: MCPSafariProduct.extensionBundleIdentifier)

        let strayBuild = root.appendingPathComponent("DerivedData/MCPSafari.app/Contents/PlugIns")
            .appendingPathComponent("MCPSafari Extension.appex")
        try writeBundle(
            at: strayBuild,
            identifier: MCPSafariProduct.extensionBundleIdentifier,
            version: "0.0.1"
        )

        let report = Doctor.inspect(
            paths: DoctorPaths(
                executableURL: URL(fileURLWithPath: "/opt/homebrew/bin/mcp-safari"),
                appURL: appURL,
                tokenDirectoryURL: root.appendingPathComponent("tokens")
            ),
            port: 8089,
            registration: .registered(bundlePath: strayBuild.path)
        )

        let version = report.checks.first { $0.code == "extension_version" }
        #expect(version?.status == .error)
        #expect(version?.message.contains("0.0.1") == true)
        #expect(report.overall == .error)
    }

    /// Someone running the app from somewhere other than /Applications is
    /// already told so by `app_installed`. Saying it twice in different words
    /// would make doctor noisier for people who have done nothing wrong.
    @Test func anAppInstalledElsewhereIsNotWarnedAboutTwice() {
        // A path under a fresh temp root, so this does not quietly depend on
        // whether the machine running the tests happens to have the app.
        let absent = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("MCPSafari.app")

        let report = Doctor.inspect(
            paths: DoctorPaths(
                executableURL: URL(fileURLWithPath: "/opt/homebrew/bin/mcp-safari"),
                appURL: absent,
                tokenDirectoryURL: URL(fileURLWithPath: "/tmp/tokens")
            ),
            port: 8089,
            registration: .registered(bundlePath: "/Users/someone/Applications/MCPSafari.app/Contents/PlugIns"
                + "/MCPSafari Extension.appex")
        )

        #expect(report.checks.first { $0.code == "app_installed" }?.status == .error)
        #expect(report.checks.contains { $0.code == "extension_location" } == false)
    }

    /// PlugInKit answers one question, so it is modelled as one value. The
    /// previous pair of a `Bool?` and a `String?` could express "not registered,
    /// and here is where it is registered", and needed two readings to fill in.
    @Test func registrationCannotExpressAContradiction() {
        #expect(ExtensionRegistration.unknown.isRegistered == nil)
        #expect(ExtensionRegistration.unknown.bundlePath == nil)

        #expect(ExtensionRegistration.notRegistered.isRegistered == false)
        // Not registered has no path to offer, and no way to be given one.
        #expect(ExtensionRegistration.notRegistered.bundlePath == nil)

        let located = ExtensionRegistration.registered(bundlePath: "/Applications/MCPSafari.app")
        #expect(located.isRegistered == true)
        #expect(located.bundlePath == "/Applications/MCPSafari.app")

        // Registered somewhere PlugInKit would not name is still registered.
        #expect(ExtensionRegistration.registered(bundlePath: nil).isRegistered == true)
        #expect(ExtensionRegistration.registered(bundlePath: nil).bundlePath == nil)
    }

    /// The bundle path is the tail of the line and contains a space, so anything
    /// that splits on whitespace truncates it to "/Applications/MCPSafari.app/Contents/PlugIns/MCPSafari".
    @Test func theRegisteredPathSurvivesTheSpaceInItsName() {
        let output = "     com.epistates.MCPSafari.Extension(0.3.2)\t8AC12B3C-1B4B\t2026-09-16 23:56:34 +0000"
            + "\t/Applications/MCPSafari.app/Contents/PlugIns/MCPSafari Extension.appex\n (1 plug-in)\n"

        #expect(
            Doctor.parseExtensionPath(from: output)
                == "/Applications/MCPSafari.app/Contents/PlugIns/MCPSafari Extension.appex"
        )
        #expect(Doctor.parseExtensionPath(from: " (0 plug-ins)\n") == nil)
    }

    private func writeBundle(
        at url: URL,
        identifier: String,
        version: String = MCPSafariProduct.version
    ) throws {
        let contents = url.appendingPathComponent("Contents")
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        let info: [String: Any] = [
            "CFBundleIdentifier": identifier,
            "CFBundlePackageType": "BNDL",
            "CFBundleShortVersionString": version,
            "CFBundleVersion": "1",
        ]
        let data = try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
        try data.write(to: contents.appendingPathComponent("Info.plist"))
    }
}
