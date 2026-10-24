import Foundation
import Logging
import Testing
@testable import MCPSafari

/// Anything on the machine can open a bridge socket, since acceptance happens
/// before the token is checked, and anything holding the token can finish a
/// handshake. These drive real loopback sockets because the defects are all in
/// which connection the bridge decides to keep.
struct HandshakeHygieneTests {
    private let tokenRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)

    private enum HandshakeTestError: Error {
        case unexpectedReply
    }

    /// Ports sit above the extension's auto-scan range (8089-8098) so a running
    /// Safari never dials them.
    private func withStartedBridge(
        port: UInt16,
        handshakeDeadline: Duration = .seconds(10),
        _ body: (WebSocketBridge, UInt16) async throws -> Void
    ) async throws {
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        let bridge = try WebSocketBridge(
            port: port,
            logger: Logger(label: "HandshakeHygieneTests"),
            tokenRoots: [tokenRoot],
            handshakeDeadline: handshakeDeadline
        )
        await bridge.start()
        let boundPort = await bridge.port
        do {
            try await body(bridge, boundPort)
        } catch {
            await bridge.stop()
            throw error
        }
        await bridge.stop()
    }

    private func makeTask(port: UInt16) -> URLSessionWebSocketTask {
        URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
    }

    private func handshakePayload(token: String, profileId: String?) throws -> String {
        var message: [String: Any] = [
            "auth": token,
            "extensionVersion": "0.3.2",
            "protocolVersion": MCPSafariProduct.bridgeProtocolVersion,
        ]
        if let profileId { message["profileId"] = profileId }
        return String(decoding: try JSONSerialization.data(withJSONObject: message), as: UTF8.self)
    }

    @discardableResult
    private func authenticate(
        token: String,
        profileId: String?,
        on task: URLSessionWebSocketTask
    ) async throws -> [String: Any] {
        try await task.send(.string(handshakePayload(token: token, profileId: profileId)))
        return try await receiveObject(on: task)
    }

    private func receiveObject(on task: URLSessionWebSocketTask) async throws -> [String: Any] {
        guard case let .string(reply) = try await task.receive(),
              let parsed = try JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any]
        else { throw HandshakeTestError.unexpectedReply }
        return parsed
    }

    /// Waits for the server to hang up on this socket, reading past anything it says
    /// first. Gives up after `timeout`, because a read that never fails would
    /// otherwise stall the whole suite on exactly the bug the test is looking for.
    private func serverHungUp(on task: URLSessionWebSocketTask, timeout: Duration = .seconds(5)) async -> Bool {
        let hungUp = await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                while true {
                    do { _ = try await task.receive() } catch { return true }
                }
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return false
            }
            let first = await group.next() ?? false
            // A pending `receive` is ended by cancelling the task, not the Swift task.
            if !first { task.cancel() }
            group.cancelAll()
            return first
        }
        return hungUp
    }

    /// Completes the handshake over a raw socket, which is how the tests that need a
    /// socket admitted without any WebSocket machinery behind it do it.
    private func authenticate(token: String, on socket: RawSocket) throws -> [String: Any] {
        try #require(socket.sendText(try handshakePayload(token: token, profileId: "default")))
        let reply = try #require(socket.readText())
        return try #require(try JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any])
    }

    @Test func aWrongTokenIsToldWhyAndNeverRegistersAProfile() async throws {
        try await withStartedBridge(port: 0) { bridge, port in
            let task = makeTask(port: port)
            defer { task.cancel() }
            task.resume()

            let reply = try await authenticate(token: "not-the-token", profileId: "default", on: task)
            // A silent close looks like a crash, so an extension holding the token
            // of a previous server run had no way to know it should read the new
            // one (#156).
            #expect(reply["auth"] as? String == "error")
            #expect(reply["error"] as? String == "token_mismatch")
            #expect(await serverHungUp(on: task))

            let status = await bridge.status()
            #expect(status.profiles.isEmpty)
            #expect(status.bridge == .disconnected)
        }
    }

    @Test func aSecondHandshakeDoesNotRegisterTheSameSocketTwice() async throws {
        try await withStartedBridge(port: 8321) { bridge, port in
            let task = makeTask(port: port)
            defer { task.cancel() }
            task.resume()

            let token = await bridge.authToken
            let reply = try await authenticate(token: token, profileId: "default", on: task)
            #expect(reply["auth"] as? String == "ok")

            // Re-handshaking under a different id used to add a second
            // `connections` entry for this one socket. Only the newer key is in
            // the reverse map, so closing the socket would strand the older one
            // and leave a profile that is gone reporting as connected.
            try await task.send(.string(handshakePayload(token: token, profileId: "WORK-PROFILE")))
            try await Task.sleep(for: .milliseconds(250))

            let profiles = await bridge.status().profiles.map(\.id)
            #expect(profiles == ["default"])
        }
    }

    @Test func aFloodOfSilentSocketsCannotEvictOneMidHandshake() async throws {
        try await withStartedBridge(port: 8331) { bridge, port in
            // Eight is the cap, so these fill it without authenticating.
            let squatters = try (0..<8).map { _ in try #require(RawSocket.dial(port: port)) }
            // The upgrade answer means the bridge has admitted the socket, so all
            // eight are counted before the ninth arrives.
            for socket in squatters { #expect(socket.reply() == .upgraded) }

            // The ninth used to evict the oldest, which is whichever connection
            // is furthest along and so most likely to be the real extension. It is
            // the newcomer that is turned away now.
            let ninth = try #require(RawSocket.dial(port: port))
            #expect(ninth.reply() == .closed, "the ninth mid-handshake socket is refused")

            let token = await bridge.authToken
            let reply = try authenticate(token: token, on: squatters[0])
            #expect(reply["auth"] as? String == "ok", "and the oldest is still there to finish")
            #expect(await bridge.status().profiles.map(\.id) == ["default"])
        }
    }

    @Test func aRejectedOldBuildDoesNotRelabelAConnectedProfile() async throws {
        try await withStartedBridge(port: 8351) { bridge, port in
            let task = makeTask(port: port)
            defer { task.cancel() }
            task.resume()

            let token = await bridge.authToken
            try await authenticate(token: token, profileId: "default", on: task)

            // A mismatched build used to overwrite the one shared pair of
            // version fields, so `status` described the healthy profile above
            // using the numbers of the build it had just turned away.
            let stale = makeTask(port: port)
            defer { stale.cancel() }
            stale.resume()
            let mismatch = #"{"auth":"\#(token)","extensionVersion":"99.0.0","protocolVersion":2}"#
            try await stale.send(.string(mismatch))
            try await Task.sleep(for: .milliseconds(250))

            let status = await bridge.status()
            #expect(status.extensionVersion == "0.3.2")
            #expect(status.extensionProtocolVersion == MCPSafariProduct.bridgeProtocolVersion)
            // The refusal is still reported, just not as the live profile's own.
            #expect(status.lastError?.code == "protocol_version_mismatch")
            #expect(status.profiles.map(\.id) == ["default"])
        }
    }

    @Test func cancellingABroadcastIsNotReportedAsABrowserFailure() async throws {
        try await withStartedBridge(port: 8361) { bridge, port in
            let task = makeTask(port: port)
            defer { task.cancel() }
            task.resume()
            try await authenticate(token: await bridge.authToken, profileId: "default", on: task)

            // Nothing answers, so the broadcast is still waiting when it is
            // cancelled. Each child turns its own CancellationError into an
            // `.unreachable` outcome, so without a cancellation check the call
            // returns normally and blames Safari for the caller's own decision.
            let broadcast = Task { try await bridge.broadcast(action: "tabs_context") }
            try await Task.sleep(for: .milliseconds(200))
            broadcast.cancel()

            await #expect(throws: CancellationError.self) { try await broadcast.value }
        }
    }

    @Test func aSocketThatNeverSpeaksGivesUpItsSlot() async throws {
        // Refusing the newest only works if silent sockets age out, otherwise a
        // handful of them would hold every slot and the refusal would land on
        // the extension instead.
        try await withStartedBridge(port: 8341, handshakeDeadline: .milliseconds(200)) { bridge, port in
            let squatters = try (0..<8).map { _ in try #require(RawSocket.dial(port: port)) }
            for socket in squatters { #expect(socket.reply() == .upgraded) }
            // Each is hung up on once its deadline passes.
            for socket in squatters { #expect(socket.reply() == .closed) }

            let arriving = makeTask(port: port)
            defer { arriving.cancel() }
            arriving.resume()

            let token = await bridge.authToken
            let reply = try await authenticate(token: token, profileId: "default", on: arriving)
            #expect(reply["auth"] as? String == "ok")
        }
    }

    /// The real extension sends its handshake within milliseconds of opening, so
    /// the deadline that ships only needs to cover a slow machine. Ten seconds let
    /// one silent socket hold a slot far longer than anything legitimate needs.
    @Test func theShippedDeadlineDropsASilentSocketWithinSeconds() async throws {
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        let bridge = try WebSocketBridge(
            port: 0,
            logger: Logger(label: "HandshakeHygieneTests"),
            tokenRoots: [tokenRoot]
        )
        await bridge.start()
        defer { Task { await bridge.stop() } }

        let socket = try #require(RawSocket.dial(port: await bridge.port))
        #expect(socket.reply() == .upgraded, "it is admitted first")
        #expect(socket.reply(within: 5) == .closed)
    }

    @Test func aFirstFrameThatIsNotAHandshakeClosesTheSocket() async throws {
        try await withStartedBridge(port: 0) { bridge, port in
            let task = makeTask(port: port)
            defer { task.cancel() }
            task.resume()

            // The shape of a bridge response, which is all an unauthenticated peer
            // has any reason to send if it is pretending to be the extension.
            try await task.send(.string(#"{"id":"x","success":true}"#))
            #expect(await serverHungUp(on: task))

            #expect(await eventually { await bridge.status().bridge == .disconnected })
            #expect(await bridge.status().profiles.isEmpty)
        }
    }

    @Test func anOversizedFirstFrameIsClosedEvenWithTheRightToken() async throws {
        try await withStartedBridge(port: 0) { bridge, port in
            let task = makeTask(port: port)
            defer { task.cancel() }
            task.resume()

            // Valid in every other respect, so only its size can be what is refused.
            let padding = String(repeating: "x", count: BridgeHandshake.maxFrameBytes * 2)
            let frame = #"{"auth":"\#(await bridge.authToken)","protocolVersion":\#(MCPSafariProduct.bridgeProtocolVersion),"padding":"\#(padding)"}"#
            try await task.send(.string(frame))

            #expect(await serverHungUp(on: task))
            #expect(await bridge.status().profiles.isEmpty)
        }
    }

    @Test func aFrameAtTheLimitIsStillDecoded() throws {
        let token = "token"
        let prefix = #"{"auth":"\#(token)","padding":""#
        let suffix = #""}"#
        let padding = String(repeating: "x", count: BridgeHandshake.maxFrameBytes - prefix.utf8.count - suffix.utf8.count)
        let atLimit = Data((prefix + padding + suffix).utf8)
        #expect(atLimit.count == BridgeHandshake.maxFrameBytes)
        #expect(BridgeHandshake.decision(for: atLimit, expectedToken: token) != nil)
        #expect(BridgeHandshake.decision(for: atLimit + Data(" ".utf8), expectedToken: token) == nil)
    }

    @Test func anUnauthenticatedSocketCannotAnswerAPendingRequest() async throws {
        try await withStartedBridge(port: 0) { bridge, port in
            let extensionSocket = makeTask(port: port)
            defer { extensionSocket.cancel() }
            extensionSocket.resume()
            try await authenticate(token: await bridge.authToken, profileId: "default", on: extensionSocket)

            let pending = Task { try await bridge.send(action: "tabs_query", timeout: 10) }
            let request = try await receiveObject(on: extensionSocket)
            let id = try #require(request["id"] as? String)

            // A local process that has not got the token, answering for the extension.
            let impostor = makeTask(port: port)
            defer { impostor.cancel() }
            impostor.resume()
            try await impostor.send(.string(#"{"id":"\#(id)","success":true,"data":"forged"}"#))
            #expect(await serverHungUp(on: impostor))

            try await extensionSocket.send(.string(#"{"id":"\#(id)","success":true,"data":"genuine"}"#))
            let response = try await pending.value
            #expect(response.data?.stringValue == "genuine")
        }
    }
}
