import Darwin
import Foundation
import Logging
import Network
import Testing
@testable import MCPSafari

/// Collects what a logger is told, for tests that assert on how often something is said.
final class LogCapture: @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [(level: Logger.Level, message: String)] = []

    func record(_ level: Logger.Level, _ message: String) {
        lock.lock(); defer { lock.unlock() }
        entries.append((level, message))
    }

    func messages(containing text: String, at level: Logger.Level? = nil) -> [String] {
        lock.lock(); defer { lock.unlock() }
        return entries.filter { (level == nil || $0.level == level) && $0.message.contains(text) }.map(\.message)
    }

    var logger: Logger {
        Logger(label: "LogCapture") { _ in CapturingLogHandler(capture: self) }
    }
}

struct CapturingLogHandler: LogHandler {
    let capture: LogCapture
    var metadata: Logger.Metadata = [:]
    var logLevel: Logger.Level = .trace

    subscript(metadataKey key: String) -> Logger.Metadata.Value? {
        get { metadata[key] }
        set { metadata[key] = newValue }
    }

    func log(event: LogEvent) {
        capture.record(event.level, "\(event.message)")
    }
}

/// How the bridge behaves when its peers are slow, hostile or gone. Each of these
/// was a way for the extension to be locked out, or for a caller to wait on an
/// answer that was never coming.
struct BridgeRobustnessTests {
    private func makeDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    // MARK: - Rate-limited refusals

    @Test func aThrottleLetsOneThroughPerIntervalAndCountsTheRest() {
        var throttle = LogThrottle(interval: .seconds(30))
        let start = ContinuousClock.now

        #expect(throttle.admit(at: start) == 0, "the first is reported, with nothing held back")
        #expect(throttle.admit(at: start + .seconds(1)) == nil)
        #expect(throttle.admit(at: start + .seconds(29)) == nil)
        #expect(throttle.admit(at: start + .seconds(30)) == 2, "and the next says how many it stands for")
        #expect(throttle.admit(at: start + .seconds(31)) == nil)
    }

    /// Whatever fills the handshake slots can be refused far faster than anyone
    /// reads stderr, and each line reaches the user through the MCP client.
    @Test func aFloodOfRefusedConnectionsIsLoggedOnce() async throws {
        let capture = LogCapture()
        let tokenRoot = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        let bridge = try WebSocketBridge(
            port: 0,
            logger: capture.logger,
            tokenRoot: tokenRoot,
            handshakeDeadline: .seconds(30)
        )
        await bridge.start()
        defer { Task { await bridge.stop() } }
        let port = await bridge.port

        // Eight that say nothing take every slot, and the rest are all refused.
        var sockets: [RawSocket] = []
        for _ in 0..<30 {
            if let socket = RawSocket.dial(port: port) { sockets.append(socket) }
        }
        try #require(sockets.count == 30)

        #expect(await eventually { !capture.messages(containing: "Refusing a connection").isEmpty })
        try await Task.sleep(for: .milliseconds(500))
        #expect(capture.messages(containing: "Refusing a connection").count == 1)
    }

    // MARK: - A reply that cannot be decoded

    @Test func theIDOfAReplyNoParserWillReadIsStillFound() {
        let lone = Data(#"{"id":"3F2504E0-4F89-11D3-9A0C-0305E82C3301","success":true,"data":"\ud83d"}"#.utf8)
        #expect(BridgeResponse.recoverID(from: lone) == "3F2504E0-4F89-11D3-9A0C-0305E82C3301")
        #expect((try? JSONDecoder().decode(BridgeResponse.self, from: lone)) == nil, "this is the case it exists for")

        #expect(BridgeResponse.recoverID(from: Data(#"{"success":true}"#.utf8)) == nil)
        #expect(BridgeResponse.recoverID(from: Data(#"{"id":"","success":true}"#.utf8)) == nil)
        #expect(BridgeResponse.recoverID(from: Data(#"{"id":"has space"}"#.utf8)) == nil)
        #expect(BridgeResponse.recoverID(from: Data(#"{"id":"unterminated"#.utf8)) == nil)
        #expect(BridgeResponse.recoverID(from: Data(#"{"id":"a\"b"}"#.utf8)) == nil, "an escaped id is not one this server issued")
    }

    @Test func aReplyTheServerCannotReadFailsItsRequestAtOnce() async throws {
        try await withStartedBridge { bridge, port in
            let client = webSocketTask(port: port)
            client.resume()
            defer { client.cancel() }
            let handshake = try await TestExtension(token: await bridge.authToken, port: port).handshake(over: client)
            try #require(handshake["auth"] as? String == "ok")

            let started = ContinuousClock.now
            let call = Task { try await bridge.send(action: "snapshot", timeout: 20) }
            guard case let .string(text) = try await client.receive(),
                  let request = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  let id = request["id"] as? String
            else { Issue.record("no request arrived"); return }

            // What JSON.stringify writes for a string cut through an emoji.
            try await client.send(.string(#"{"id":"\#(id)","success":true,"data":"cut \ud83d"}"#))

            let failure = await bridgeFailure { _ = try await call.value }
            #expect(failure?.code == "malformed_response")
            #expect(failure?.retryable == false)
            #expect(failure?.message.contains("may already have completed") == true)
            #expect(ContinuousClock.now - started < .seconds(10), "it did not wait out its timeout")
        }
    }

    @Test func aReplyThatNamesNoPendingRequestChangesNothing() async throws {
        try await withStartedBridge { bridge, port in
            let client = webSocketTask(port: port)
            client.resume()
            defer { client.cancel() }
            _ = try await TestExtension(token: await bridge.authToken, port: port).handshake(over: client)

            try await client.send(.string(#"{"id":"not-a-request-we-sent","data":"\ud83d"}"#))
            try await client.send(.string(#"{"data":"\ud83d"}"#))

            let next = Task { try await bridge.send(action: "snapshot", timeout: 5) }
            guard case let .string(text) = try await client.receive(),
                  let request = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  let id = request["id"] as? String
            else { Issue.record("no request arrived"); return }
            try await client.send(.string(#"{"id":"\#(id)","success":true,"data":"fine"}"#))

            #expect(try await next.value.data?.stringValue == "fine")
        }
    }

    // MARK: - What status reports

    /// After a failed bind `port` goes back to the requested one, where the file
    /// belongs to whichever other server holds the port.
    @Test func aBridgeThatCouldNotBindDoesNotReportAnotherServersToken() async throws {
        let tokenRoot = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        let (first, held) = try #require(holdFreePorts(count: 1), "no free port to occupy")
        defer { for descriptor in held { Darwin.close(descriptor) } }

        let tokens = tokenRoot.appendingPathComponent("tokens", isDirectory: true)
        try FileManager.default.createDirectory(at: tokens, withIntermediateDirectories: true)
        let theirs = tokens.appendingPathComponent(String(first))
        try "someone-elses-token".write(to: theirs, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: theirs.path)

        let bridge = try WebSocketBridge(
            port: first,
            portCount: 1,
            logger: Logger(label: "BridgeRobustnessTests"),
            tokenRoot: tokenRoot
        )
        await bridge.start()
        defer { Task { await bridge.stop() } }

        let status = await bridge.status()
        try #require(status.listener == .failed)
        #expect(status.tokenFileExists == false)
        #expect(status.tokenFileSecure == nil)
    }

    // MARK: - A frame that outlives its connection

    @Test func aHelloFromAConnectionThatIsAlreadyGoneLeavesNothingBehind() async throws {
        try await withStartedBridge { bridge, port in
            // The deadline dropped this connection, and a receive that had already
            // read its hello handled it afterwards.
            let socket = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
            let dropped = BridgeConnection(id: 9_999, socket: socket)
            let hello = try TestExtension(token: await bridge.authToken, port: port).helloFrame()

            await bridge.handleTextMessage(Data(hello.utf8), from: dropped)

            #expect(await bridge.pendingHandshakes.isEmpty, "a challenge was recorded for a connection nobody holds")
        }
    }

    // MARK: - The owner record

    /// A pid that was alive when the sweep read it, or one that is dead and has
    /// since been replaced by a server that claimed the port, cannot be told from a
    /// stale one by reading. The lock can.
    @Test func aLiveBridgeHoldsItsOwnerRecordLocked() async throws {
        let tokenRoot = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        let bridge = try WebSocketBridge(port: 0, logger: Logger(label: "BridgeRobustnessTests"), tokenRoot: tokenRoot)
        await bridge.start()
        let port = await bridge.port
        let record = tokenRoot.appendingPathComponent("tokens/\(port).pid")

        let probe = open(record.path, O_RDONLY)
        try #require(probe >= 0)
        defer { close(probe) }
        #expect(flock(probe, LOCK_EX | LOCK_NB) == -1 && errno == EWOULDBLOCK, "a running bridge keeps its record locked")

        await bridge.stop()
        #expect(!FileManager.default.fileExists(atPath: record.path))
        #expect(flock(probe, LOCK_EX | LOCK_NB) == 0, "and lets go of it when it stops")
    }

    @Test func aSweepLeavesARecordAloneWhileItsLockIsHeld() async throws {
        let tokenRoot = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        let directory = tokenRoot.appendingPathComponent("tokens", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let finished = Process()
        finished.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try finished.run()
        finished.waitUntilExit()

        // A record naming a dead process, as a crashed server leaves behind, that
        // another server has locked while it claims the port.
        let token = directory.appendingPathComponent("9001")
        let record = directory.appendingPathComponent("9001.pid")
        try "token".write(to: token, atomically: true, encoding: .utf8)
        try String(finished.processIdentifier).write(to: record, atomically: true, encoding: .utf8)
        let holder = open(record.path, O_RDWR)
        try #require(holder >= 0)
        try #require(flock(holder, LOCK_EX | LOCK_NB) == 0)
        defer { close(holder) }

        let bridge = try WebSocketBridge(port: 0, logger: Logger(label: "BridgeRobustnessTests"), tokenRoot: tokenRoot)
        await bridge.start()
        defer { Task { await bridge.stop() } }

        #expect(FileManager.default.fileExists(atPath: token.path) && FileManager.default.fileExists(atPath: record.path),
                "files under a held lock were swept")

        // Once the lock is gone the same record is stale and the next server removes it.
        flock(holder, LOCK_UN)
        let next = try WebSocketBridge(port: 0, logger: Logger(label: "BridgeRobustnessTests"), tokenRoot: tokenRoot)
        await next.start()
        defer { Task { await next.stop() } }
        #expect(!FileManager.default.fileExists(atPath: token.path) && !FileManager.default.fileExists(atPath: record.path))
    }

    // MARK: - The token root override

    @Test func theTokenRootMovesWithTheEnvironmentAndOnlyWhenItIsAbsolute() {
        let standard = WebSocketBridge.standardApplicationSupportDirectoryURL.path

        #expect(WebSocketBridge.applicationSupportDirectory(environment: [:]).path == standard)
        #expect(
            WebSocketBridge.applicationSupportDirectory(environment: ["MCP_SAFARI_TOKEN_ROOT": "/tmp/mcpsafari-test"]).path
                == "/tmp/mcpsafari-test"
        )
        #expect(WebSocketBridge.applicationSupportDirectory(environment: ["MCP_SAFARI_TOKEN_ROOT": "relative"]).path == standard)
        #expect(WebSocketBridge.applicationSupportDirectory(environment: ["MCP_SAFARI_TOKEN_ROOT": " "]).path == standard)
        #expect(standard.hasSuffix("Library/Application Support/MCPSafari"))
    }

    /// The protected roots read the same URL, so the override needs no edit there.
    @Test func theProtectedRootsFollowTheOverride() {
        let moved = WebSocketBridge.applicationSupportDirectory(environment: ["MCP_SAFARI_TOKEN_ROOT": "/tmp/mcpsafari-test"])
        let roots = ProtectedPaths.roots(for: [moved])
        #expect(ProtectedPaths.isProtected("/tmp/mcpsafari-test/tokens/8089", roots: roots))
        #expect(ProtectedPaths.isProtected("/tmp/mcpsafari-test/tokens/8089.png", roots: roots) == true)
    }

    @Test func statusSaysWhenTheTokensAreSomewhereTheExtensionDoesNotLook() async throws {
        let tokenRoot = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: tokenRoot) }

        let moved = try WebSocketBridge(port: 0, logger: Logger(label: "BridgeRobustnessTests"), tokenRoot: tokenRoot)
        let status = await moved.status()
        #expect(status.tokenRootOverride == tokenRoot.path)
        let json = String(decoding: try JSONEncoder().encode(status), as: UTF8.self)
        #expect(json.contains(#""tokenRootOverride":"#))

        let standard = try WebSocketBridge(
            port: 0,
            logger: Logger(label: "BridgeRobustnessTests"),
            tokenRoot: WebSocketBridge.standardApplicationSupportDirectoryURL
        )
        #expect(await standard.status().tokenRootOverride == nil)
    }

    @Test func doctorWarnsThatAnOverriddenServerIsInvisibleToTheExtension() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let paths = DoctorPaths(
            executableURL: root.appendingPathComponent("mcp-safari"),
            appURL: root.appendingPathComponent("absent.app"),
            tokenDirectoryURL: root.appendingPathComponent("tokens")
        )

        let set = Doctor.inspect(paths: paths, registration: .unknown, tokenRootOverride: "/tmp/mcpsafari-test")
        let check = try #require(set.checks.first { $0.code == "token_root_override" })
        #expect(check.status == .warning)
        #expect(check.message.contains("/tmp/mcpsafari-test"))
        #expect(check.message.contains("cannot see"))

        let unset = Doctor.inspect(paths: paths, registration: .unknown, tokenRootOverride: nil)
        #expect(!unset.checks.contains { $0.code == "token_root_override" })
    }
}
