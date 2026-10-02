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
        guard case let .string(reply) = try await task.receive(),
              let parsed = try JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any]
        else { throw HandshakeTestError.unexpectedReply }
        return parsed
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
            var squatters: [URLSessionWebSocketTask] = []
            defer { for task in squatters { task.cancel() } }
            for _ in 0..<8 {
                let task = makeTask(port: port)
                task.resume()
                squatters.append(task)
            }
            try await Task.sleep(for: .milliseconds(500))

            // The ninth used to evict the oldest, which is whichever connection
            // is furthest along and so most likely to be the real extension.
            let ninth = makeTask(port: port)
            defer { ninth.cancel() }
            ninth.resume()
            try await Task.sleep(for: .milliseconds(250))

            let token = await bridge.authToken
            let reply = try await authenticate(token: token, profileId: "default", on: squatters[0])
            #expect(reply["auth"] as? String == "ok")
            #expect(await bridge.status().profiles.map(\.id) == ["default"])
        }
    }

    @Test func aSocketThatNeverSpeaksGivesUpItsSlot() async throws {
        // Refusing the newest only works if silent sockets age out, otherwise a
        // handful of them would hold every slot and the refusal would land on
        // the extension instead.
        try await withStartedBridge(port: 8341, handshakeDeadline: .milliseconds(200)) { bridge, port in
            var squatters: [URLSessionWebSocketTask] = []
            defer { for task in squatters { task.cancel() } }
            for _ in 0..<8 {
                let task = makeTask(port: port)
                task.resume()
                squatters.append(task)
            }
            try await Task.sleep(for: .milliseconds(600))

            let arriving = makeTask(port: port)
            defer { arriving.cancel() }
            arriving.resume()

            let token = await bridge.authToken
            let reply = try await authenticate(token: token, profileId: "default", on: arriving)
            #expect(reply["auth"] as? String == "ok")
        }
    }
}
