import Foundation
import Testing
@testable import MCPSafari

struct TokenDirectoryTests {
    /// The extension's sandbox exception is granted on the literal home-relative
    /// path, so a symlinked token root leaves the token unreadable to it. The
    /// server writes it either way, which is why this needs to be diagnosable.
    @Test func doctorFlagsATokenDirectoryThatResolvesElsewhere() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let real = root.appendingPathComponent("dotfiles-repo/mcp-safari/tokens")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        let link = root.appendingPathComponent("linked-tokens")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)

        let symlinked = Doctor.tokenPathCheck(for: link)
        #expect(symlinked.status == .warning)
        #expect(symlinked.code == "token_path")
        #expect(symlinked.message.contains(real.standardizedFileURL.path))
        #expect(symlinked.recovery != nil)

        let direct = Doctor.tokenPathCheck(for: real)
        #expect(direct.status == .ok)
        #expect(direct.recovery == nil)
    }

    /// A symlinked token root is a warning, not a hard failure: the server still
    /// runs, and an older extension reading the legacy root may still connect.
    @Test func aSymlinkedTokenDirectoryDoesNotFailTheWholeReport() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let executable = root.appendingPathComponent("mcp-safari")
        try Data().write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        let real = root.appendingPathComponent("real-tokens")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        let token = real.appendingPathComponent("8089")
        try "token".write(to: token, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: token.path)
        let link = root.appendingPathComponent("linked-tokens")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)

        let report = Doctor.inspect(
            paths: .init(
                executableURL: executable,
                appURL: root.appendingPathComponent("absent.app"),
                tokenDirectoryURL: link
            ),
            extensionRegistered: true
        )

        let tokenPath = try #require(report.checks.first { $0.code == "token_path" })
        #expect(tokenPath.status == .warning)
        // The token itself is readable through the link from an unsandboxed
        // process, so that check passes while the path check does not.
        #expect(report.checks.first { $0.code == "token_file" }?.status == .ok)
    }

    /// Application Support is preferred precisely because `~/.config` is the
    /// path users symlink into dotfiles repos.
    @Test func applicationSupportIsThePreferredTokenRoot() {
        #expect(WebSocketBridge.tokenRootURLs.first == WebSocketBridge.applicationSupportDirectoryURL)
        #expect(WebSocketBridge.tokenRootURLs.contains(WebSocketBridge.configDirectoryURL))
        #expect(
            WebSocketBridge.tokenDirectoryURL
                == WebSocketBridge.applicationSupportDirectoryURL.appendingPathComponent("tokens")
        )
        #expect(WebSocketBridge.tokenDirectoryURL.path.contains("Library/Application Support/MCPSafari"))
        #expect(!WebSocketBridge.tokenDirectoryURL.path.contains(".config"))
    }

    /// Both roots stay populated so an extension build predating the move keeps
    /// authenticating against a newer server.
    @Test func theLegacyRootIsStillTheConfigDirectory() {
        #expect(WebSocketBridge.legacyTokenFilePath.hasSuffix(".config/mcp-safari/token"))
        #expect(WebSocketBridge.configDirectoryURL.path.hasSuffix(".config/mcp-safari"))
    }

    private func makeDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}
