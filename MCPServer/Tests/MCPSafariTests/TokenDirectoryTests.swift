import Foundation
import Logging
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

    /// A symlinked token root is a warning, not a hard failure: the server still runs.
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
            registration: .registered(bundlePath: nil)
        )

        let tokenPath = try #require(report.checks.first { $0.code == "token_path" })
        #expect(tokenPath.status == .warning)
        // The token itself is readable through the link from an unsandboxed
        // process, so that check passes while the path check does not.
        #expect(report.checks.first { $0.code == "token_file" }?.status == .ok)
    }

    /// Application Support is the only token root precisely because `~/.config` is
    /// the path users symlink into dotfiles repos.
    @Test func applicationSupportIsTheOnlyTokenRoot() {
        // Compared as paths on purpose. URL equality also compares the trailing
        // slash, and the one-argument `appendingPathComponent` decides that by
        // asking the filesystem, so a URL comparison here passes or fails on
        // whether the directory happens to exist yet.
        #expect(
            WebSocketBridge.tokenDirectoryURL.path
                == WebSocketBridge.applicationSupportDirectoryURL
                    .appendingPathComponent("tokens", isDirectory: true).path
        )
        #expect(WebSocketBridge.tokenDirectoryURL.path.contains("Library/Application Support/MCPSafari"))
        #expect(!WebSocketBridge.tokenDirectoryURL.path.contains(".config"))
    }

    /// A shared `token` file beside the per-port ones used to be written for
    /// extension builds that predate per-port tokens. Those builds cannot speak the
    /// current protocol, so it only left a second copy of the secret on disk, in a
    /// file another process could replace.
    @Test func onlyThePerPortTokenAndItsOwnerRecordAreWritten() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let bridge = try WebSocketBridge(port: 0, logger: Logger(label: "token-test"), tokenRoot: root)
        await bridge.start()
        defer { Task { await bridge.stop() } }
        let port = await bridge.port

        let atRoot = try FileManager.default.contentsOfDirectory(atPath: root.path)
        #expect(atRoot == ["tokens"])
        let tokens = try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("tokens").path)
        #expect(Set(tokens) == [String(port), "\(port).pid"])
    }

    @Test func tokenPublicationFailureStopsListenerAndIsDiagnosable() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let blocked = root.appendingPathComponent("not-a-directory")
        try Data().write(to: blocked)
        let bridge = try WebSocketBridge(port: 0, logger: Logger(label: "token-test"), tokenRoot: blocked)
        await bridge.start()
        let status = await bridge.status()
        #expect(status.listener == .failed)
        #expect(status.lastError?.code == "token_write_failed")
        // Not the generic "open Safari" advice: Safari is not the problem (#154).
        let failure = await bridgeFailure { _ = try await bridge.send(action: "tabs_query") }
        #expect(failure?.code == "bridge_unavailable")
        #expect(failure?.message.contains("Could not publish the authentication token") == true)
        await bridge.stop()
    }

    @Test func shutdownRemovesOnlyOwnedPerPortTokens() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let bridge = try WebSocketBridge(port: 0, logger: Logger(label: "token-test"), tokenRoot: root)
        await bridge.start()
        let port = await bridge.port
        let token = root.appendingPathComponent("tokens/\(port)")
        #expect(FileManager.default.fileExists(atPath: token.path))
        await bridge.stop()
        #expect(!FileManager.default.fileExists(atPath: token.path))
        await bridge.start()
        let nextToken = root.appendingPathComponent("tokens/\(await bridge.port)")
        try "different-owner".write(to: nextToken, atomically: true, encoding: .utf8)
        await bridge.stop()
        #expect(try String(contentsOf: nextToken, encoding: .utf8) == "different-owner")
    }

    /// The token file stays exactly what the native handler parses, which is the
    /// whole file as the token, so who owns it is recorded in a file beside it. The
    /// handler only takes names that are a bare port number, and `<port>.pid` is not.
    @Test func theOwnerIsRecordedBesideTheTokenWithoutChangingIt() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let bridge = try WebSocketBridge(port: 0, logger: Logger(label: "token-test"), tokenRoot: root)
        await bridge.start()
        let port = await bridge.port
        let token = root.appendingPathComponent("tokens/\(port)")
        let owner = root.appendingPathComponent("tokens/\(port).pid")

        let authToken = await bridge.authToken
        #expect(try String(contentsOf: token, encoding: .utf8) == authToken)
        #expect(UUID(uuidString: authToken) != nil)
        #expect(try String(contentsOf: owner, encoding: .utf8) == String(getpid()))
        #expect(UInt16(owner.lastPathComponent) == nil, "the handler must not mistake it for a port")
        let permissions = try FileManager.default.attributesOfItem(atPath: owner.path)[.posixPermissions] as? NSNumber
        #expect(permissions?.intValue == 0o600)

        await bridge.stop()
        #expect(!FileManager.default.fileExists(atPath: owner.path))
    }

    /// Killed outright, a server never gets to remove its token, and the extension
    /// then dials a port nothing serves.
    @Test func startingSweepsTokensWhoseOwnerIsGoneAndNothingElse() async throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let directory = root.appendingPathComponent("tokens", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let finished = Process()
        finished.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try finished.run()
        finished.waitUntilExit()
        let deadPID = finished.processIdentifier

        func plant(_ port: Int, owner: String?) throws {
            try "token-\(port)".write(to: directory.appendingPathComponent("\(port)"), atomically: true, encoding: .utf8)
            if let owner {
                try owner.write(to: directory.appendingPathComponent("\(port).pid"), atomically: true, encoding: .utf8)
            }
        }
        try plant(9001, owner: String(deadPID))
        try plant(9002, owner: String(getppid()))
        try plant(9003, owner: nil)
        try plant(9004, owner: "not a pid")
        try plant(9005, owner: "1")

        let bridge = try WebSocketBridge(port: 0, logger: Logger(label: "token-test"), tokenRoot: root)
        await bridge.start()
        defer { Task { await bridge.stop() } }

        func exists(_ name: String) -> Bool {
            FileManager.default.fileExists(atPath: directory.appendingPathComponent(name).path)
        }
        #expect(!exists("9001") && !exists("9001.pid"), "a dead owner's token goes")
        #expect(exists("9002") && exists("9002.pid"), "a live owner's token stays")
        #expect(exists("9003"), "a token with no owner record is not provably stale")
        #expect(exists("9004") && exists("9004.pid"), "an unreadable owner record proves nothing")
        #expect(exists("9005") && exists("9005.pid"), "pid 1 is alive, and is never signalled to find out")
    }

    private func makeDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}
