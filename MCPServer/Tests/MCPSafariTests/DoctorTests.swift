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
            extensionRegistered: true
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
            extensionRegistered: true
        )

        #expect(report.checks.first { $0.code == "app_version" }?.status == .error)
        #expect(report.checks.first { $0.code == "token_file" }?.status == .warning)
        #expect(report.checks.first { $0.code == "token_file" }?.message.contains("permissions") == true)
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
            extensionRegistered: false
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
