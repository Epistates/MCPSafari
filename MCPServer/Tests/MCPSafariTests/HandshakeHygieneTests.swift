import Foundation
import Logging
import Testing
@testable import MCPSafari

/// Anything on the machine can open a bridge socket, since acceptance happens
/// before anyone has proved anything, and anything holding the token can finish a
/// handshake. These drive real loopback sockets because the defects are all in
/// which connection the bridge decides to keep.
///
/// The exchange itself, in both directions, is `ChallengeHandshakeTests`.
struct HandshakeHygieneTests {
    private enum HandshakeTestError: Error {
        case unexpectedReply
    }

    /// Completes the handshake as the real extension would.
    @discardableResult
    private func authenticate(
        _ bridge: WebSocketBridge,
        profileId: String? = "default",
        on transport: some FrameTransport
    ) async throws -> [String: Any] {
        let extensionSide = TestExtension(
            token: await bridge.authToken,
            port: await bridge.port,
            profileId: profileId
        )
        return try await extensionSide.handshake(over: transport)
    }

    private func receiveObject(on task: URLSessionWebSocketTask) async throws -> [String: Any] {
        guard case let .string(reply) = try await task.receive(),
              let parsed = try JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any]
        else { throw HandshakeTestError.unexpectedReply }
        return parsed
    }

    @Test func aWrongTokenIsToldWhyAndNeverRegistersAProfile() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()

            // An extension holding the token of a previous server run: it checks the
            // server's proof against that token, so to see the rejection it has to
            // answer with the stale token's proof anyway, as a client that did not
            // verify would. The server is what is under test here.
            let extensionSide = TestExtension(token: await bridge.authToken, port: port)
            let reply = try await extensionSide.handshake(over: task, proofToken: "not-the-token")

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
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()

            let reply = try await authenticate(bridge, on: task)
            #expect(reply["auth"] as? String == "ok")

            // Re-handshaking under a different id used to add a second
            // `connections` entry for this one socket. Only the newer key is in
            // the reverse map, so closing the socket would strand the older one
            // and leave a profile that is gone reporting as connected.
            let again = TestExtension(token: await bridge.authToken, port: port, profileId: "WORK-PROFILE")
            try await task.send(.string(again.helloFrame()))

            // Frames on a connection are handled in order, so a request answered
            // after the second hello proves the hello has been dealt with.
            let pending = Task { try await bridge.send(action: "tabs_query", timeout: 10) }
            let request = try await receiveObject(on: task)
            let id = try #require(request["id"] as? String)
            try await task.send(.string(#"{"id":"\#(id)","success":true,"data":"ok"}"#))
            _ = try await pending.value

            #expect(await bridge.status().profiles.map(\.id) == ["default"])
        }
    }

    @Test func aFloodOfSilentSocketsCannotEvictOneMidHandshake() async throws {
        try await withStartedBridge { bridge, port in
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

            let reply = try await authenticate(bridge, on: squatters[0])
            #expect(reply["auth"] as? String == "ok", "and the oldest is still there to finish")
            #expect(await bridge.status().profiles.map(\.id) == ["default"])
        }
    }

    @Test func aRejectedOldBuildDoesNotRelabelAConnectedProfile() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()
            try await authenticate(bridge, on: task)

            // A build from before the challenge exchange puts the token in its first
            // frame. It cannot finish this handshake, but it is told why.
            // Deliberately not a real release: the rejection turns on the protocol
            // number, and a shipped version here reads as though it is refused.
            let token = await bridge.authToken
            let stale = webSocketTask(port: port)
            defer { stale.cancel() }
            stale.resume()
            try await stale.send(.string(#"{"auth":"\#(token)","extensionVersion":"99.0.0","protocolVersion":1}"#))
            let reply = try await receiveObject(on: stale)
            #expect(reply["error"] as? String == "protocol_version_mismatch")

            // A mismatched build used to overwrite the one shared pair of version
            // fields, so `status` described the healthy profile above using the
            // numbers of the build it had just turned away.
            let status = await bridge.status()
            #expect(status.extensionVersion == "0.4.0")
            #expect(status.extensionProtocolVersion == MCPSafariProduct.bridgeProtocolVersion)
            // The refusal is still reported, just not as the live profile's own.
            #expect(status.lastError?.code == "protocol_version_mismatch")
            #expect(status.profiles.map(\.id) == ["default"])
        }
    }

    @Test func cancellingABroadcastIsNotReportedAsABrowserFailure() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()
            try await authenticate(bridge, on: task)

            // Nothing answers, so the broadcast is still waiting when it is
            // cancelled. Each child turns its own CancellationError into an
            // `.unreachable` outcome, so without a cancellation check the call
            // returns normally and blames Safari for the caller's own decision.
            let broadcast = Task { try await bridge.broadcast(action: "tabs_context") }
            // The request reaching the extension is the sign it is waiting.
            _ = try await receiveObject(on: task)
            broadcast.cancel()

            await #expect(throws: CancellationError.self) { try await broadcast.value }
        }
    }

    @Test func aSocketThatNeverSpeaksGivesUpItsSlot() async throws {
        // Refusing the newest only works if silent sockets age out, otherwise a
        // handful of them would hold every slot and the refusal would land on
        // the extension instead.
        try await withStartedBridge(handshakeDeadline: .milliseconds(200)) { bridge, port in
            let squatters = try (0..<8).map { _ in try #require(RawSocket.dial(port: port)) }
            for socket in squatters { #expect(socket.reply() == .upgraded) }
            // Each is hung up on once its deadline passes.
            for socket in squatters { #expect(socket.reply() == .closed) }

            let arriving = webSocketTask(port: port)
            defer { arriving.cancel() }
            arriving.resume()

            let reply = try await authenticate(bridge, on: arriving)
            #expect(reply["auth"] as? String == "ok")
        }
    }

    /// The real extension sends its handshake within milliseconds of opening, so
    /// the deadline that ships only needs to cover a slow machine. Ten seconds let
    /// one silent socket hold a slot far longer than anything legitimate needs.
    @Test func theShippedDeadlineDropsASilentSocketWithinSeconds() async throws {
        let tokenRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        let bridge = try WebSocketBridge(
            port: 0,
            logger: Logger(label: "HandshakeHygieneTests"),
            tokenRoot: tokenRoot
        )
        await bridge.start()
        defer { Task { await bridge.stop() } }

        let socket = try #require(RawSocket.dial(port: await bridge.port))
        #expect(socket.reply() == .upgraded, "it is admitted first")
        #expect(socket.reply(within: 5) == .closed)
    }

    @Test func aFirstFrameThatIsNotAHandshakeClosesTheSocket() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
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

    @Test func anOversizedFirstFrameIsClosedEvenWhenItIsAValidHello() async throws {
        try await withStartedBridge { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()

            // Valid in every other respect, so only its size can be what is refused.
            var extensionSide = TestExtension(token: await bridge.authToken, port: port)
            extensionSide.extensionVersion = String(repeating: "x", count: BridgeHandshake.maxFrameBytes * 2)
            try await task.send(.string(extensionSide.helloFrame()))

            #expect(await serverHungUp(on: task))
            #expect(await bridge.status().profiles.isEmpty)
        }
    }

    @Test func aFrameAtTheLimitIsStillDecoded() throws {
        var extensionSide = TestExtension(token: "token", port: 8089)
        // Pad the version string until the whole frame is exactly the limit.
        let bare = try extensionSide.helloFrame().utf8.count
        extensionSide.extensionVersion = String(
            repeating: "x",
            count: extensionSide.extensionVersion.utf8.count + BridgeHandshake.maxFrameBytes - bare
        )
        let atLimit = Data(try extensionSide.helloFrame().utf8)
        #expect(atLimit.count == BridgeHandshake.maxFrameBytes)

        guard case .challenge? = BridgeHandshake.begin(with: atLimit, token: "token", port: 8089) else {
            Issue.record("a frame at the limit should be decoded")
            return
        }
        #expect(BridgeHandshake.begin(with: atLimit + Data(" ".utf8), token: "token", port: 8089) == nil)
    }

    @Test func anUnauthenticatedSocketCannotAnswerAPendingRequest() async throws {
        try await withStartedBridge { bridge, port in
            let extensionSocket = webSocketTask(port: port)
            defer { extensionSocket.cancel() }
            extensionSocket.resume()
            try await authenticate(bridge, on: extensionSocket)

            let pending = Task { try await bridge.send(action: "tabs_query", timeout: 10) }
            let request = try await receiveObject(on: extensionSocket)
            let id = try #require(request["id"] as? String)

            // A local process that has not got the token, answering for the extension.
            let impostor = webSocketTask(port: port)
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
