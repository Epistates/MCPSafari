import Foundation
import Logging
import Testing
@testable import MCPSafari

/// Safari runs a separate extension instance per profile, and every one of them
/// authenticates against the same bridge. The bug in #54 lives entirely in how those
/// live connections interact, so these drive real loopback WebSockets: a faked
/// transport cannot reproduce one connection evicting another.
struct ProfileConnectionTests {

    // MARK: - Harness

    /// Ports here sit above the extension's auto-scan range (8089-8098) so a running
    /// Safari never dials them, and the token files `start()` writes are removed after.
    private func withStartedBridge(
        port: UInt16,
        _ body: (WebSocketBridge, UInt16) async throws -> Void
    ) async throws {
        let bridge = try WebSocketBridge(
            port: port,
            logger: Logger(label: "ProfileConnectionTests")
        )
        await bridge.start()
        let boundPort = await bridge.port

        do {
            try await body(bridge, boundPort)
        } catch {
            await bridge.stop()
            removeTokenFile(for: boundPort)
            throw error
        }

        await bridge.stop()
        removeTokenFile(for: boundPort)
    }

    private func removeTokenFile(for port: UInt16) {
        for root in WebSocketBridge.tokenRootURLs {
            let path = root.appendingPathComponent("tokens").appendingPathComponent(String(port))
            try? FileManager.default.removeItem(at: path)
        }
    }

    /// Connects and completes the handshake, returning the server's auth reply.
    @discardableResult
    private func authenticate(
        port: UInt16,
        token: String,
        profileId: String?,
        task: URLSessionWebSocketTask
    ) async throws -> [String: Any] {
        task.resume()

        var handshake: [String: Any] = [
            "auth": token,
            "extensionVersion": "0.3.1",
            "protocolVersion": MCPSafariProduct.bridgeProtocolVersion,
        ]
        if let profileId { handshake["profileId"] = profileId }

        let payload = try JSONSerialization.data(withJSONObject: handshake)
        try await task.send(.string(String(decoding: payload, as: UTF8.self)))

        guard case let .string(reply) = try await task.receive(),
              let parsed = try JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any]
        else {
            throw BridgeTestError.unexpectedReply
        }

        return parsed
    }

    private func makeTask(port: UInt16) -> URLSessionWebSocketTask {
        URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
    }

    /// A ping round-trip is the only honest liveness check: a cancelled connection
    /// fails it, whereas simply not receiving anything proves nothing.
    private func isAlive(_ task: URLSessionWebSocketTask) async -> Bool {
        await withCheckedContinuation { continuation in
            nonisolated(unsafe) var resumed = false
            task.sendPing { error in
                guard !resumed else { return }
                resumed = true
                continuation.resume(returning: error == nil)
            }
        }
    }

    private enum BridgeTestError: Error {
        case unexpectedReply
    }

    // MARK: - Tests

    @Test func twoProfilesStayConnectedInsteadOfEvictingEachOther() async throws {
        try await withStartedBridge(port: 8131) { bridge, port in
            let token = await bridge.authToken

            let personal = makeTask(port: port)
            let work = makeTask(port: port)

            let personalReply = try await authenticate(
                port: port, token: token, profileId: "default", task: personal
            )
            let workReply = try await authenticate(
                port: port, token: token, profileId: "WORK-UUID", task: work
            )

            #expect(personalReply["auth"] as? String == "ok")
            #expect(workReply["auth"] as? String == "ok")
            #expect(workReply["profile"] as? String == "WORK-UUID")

            // The regression: the second handshake used to cancel the first.
            #expect(await isAlive(personal))
            #expect(await isAlive(work))

            let status = await bridge.status()
            #expect(status.bridge == .authenticated)
            #expect(status.profiles.map(\.id) == ["default", "WORK-UUID"])
            #expect(status.profiles.map(\.index) == [0, 1])

            personal.cancel()
            work.cancel()
        }
    }

    @Test func aProfileReconnectingReplacesOnlyItsOwnConnection() async throws {
        try await withStartedBridge(port: 8132) { bridge, port in
            let token = await bridge.authToken

            let work = makeTask(port: port)
            let personal = makeTask(port: port)
            try await authenticate(port: port, token: token, profileId: "WORK-UUID", task: work)
            try await authenticate(port: port, token: token, profileId: "default", task: personal)

            // The same profile dialling in again is a genuine reconnect, so replacing
            // its predecessor is correct. The other profile must not notice.
            let workAgain = makeTask(port: port)
            let reply = try await authenticate(
                port: port, token: token, profileId: "WORK-UUID", task: workAgain
            )
            #expect(reply["auth"] as? String == "ok")

            #expect(await isAlive(personal))
            #expect(await isAlive(workAgain))

            let status = await bridge.status()
            #expect(status.profiles.count == 2)
            // The index survives the reconnect, so a handle stays meaningful.
            #expect(status.profiles.first { $0.id == "WORK-UUID" }?.index == 0)

            work.cancel()
            personal.cancel()
            workAgain.cancel()
        }
    }

    @Test func aProfileDisconnectingLeavesTheOthersConnected() async throws {
        try await withStartedBridge(port: 8133) { bridge, port in
            let token = await bridge.authToken

            let personal = makeTask(port: port)
            let work = makeTask(port: port)
            try await authenticate(port: port, token: token, profileId: "default", task: personal)
            try await authenticate(port: port, token: token, profileId: "WORK-UUID", task: work)

            work.cancel(with: .goingAway, reason: nil)

            // Closing is reported through Network.framework, so poll rather than
            // assume the teardown has landed by the next line.
            var remaining = await bridge.status().profiles
            for _ in 0..<50 where remaining.count > 1 {
                try await Task.sleep(for: .milliseconds(20))
                remaining = await bridge.status().profiles
            }

            #expect(remaining.map(\.id) == ["default"])
            #expect(await bridge.isConnected)
            #expect(await isAlive(personal))

            personal.cancel()
        }
    }

    @Test func anExtensionThatSendsNoProfileCountsAsTheDefault() async throws {
        // Builds predating profile support send no profileId at all, and Safari sends
        // none for the default profile. Both have to keep working unchanged.
        let legacy = Data(#"{"auth":"secret","extensionVersion":"0.3.0","protocolVersion":1}"#.utf8)
        #expect(
            BridgeHandshake.decision(for: legacy, expectedToken: "secret")
                == .accept(.init(version: "0.3.0", protocolVersion: 1, profileID: "default"))
        )

        let blank = Data(#"{"auth":"secret","profileId":"   "}"#.utf8)
        #expect(
            BridgeHandshake.decision(for: blank, expectedToken: "secret")
                == .accept(.init(version: nil, protocolVersion: nil, profileID: "default"))
        )

        let named = Data(#"{"auth":"secret","profileId":"WORK-UUID"}"#.utf8)
        #expect(
            BridgeHandshake.decision(for: named, expectedToken: "secret")
                == .accept(.init(version: nil, protocolVersion: nil, profileID: "WORK-UUID"))
        )
    }
}
