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

        let message = try await withTimeout { try await task.receive() }
        guard case let .string(reply) = message,
              let parsed = try JSONSerialization.jsonObject(with: Data(reply.utf8)) as? [String: Any]
        else {
            throw BridgeTestError.unexpectedReply
        }

        return parsed
    }

    private func makeTask(port: UInt16) -> URLSessionWebSocketTask {
        URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
    }

    /// Which profiles the bridge still holds, once any cancellation has landed.
    ///
    /// The bridge's own registry is the deterministic signal here: evicting a
    /// connection runs `forget()`, which drops it from `connections`, so a profile
    /// that survives is one that was not evicted. An earlier version asked the
    /// client instead, with a WebSocket ping, and that measured URLSession
    /// scheduling as much as liveness: it timed out on both sockets of one test
    /// under parallel load in CI while the same check passed elsewhere.
    private func settledProfiles(_ bridge: WebSocketBridge) async throws -> [String] {
        // Cancellation arrives through Network.framework rather than inline, so
        // give it room to land. Eviction is immediate when it happens, so this
        // only has to outlast the callback hop.
        try await Task.sleep(for: .milliseconds(250))
        return await bridge.status().profiles.map(\.id).sorted()
    }

    /// Receives one bridge request, failing rather than hanging when it never comes.
    ///
    /// The socket is closed on timeout rather than the task being cancelled:
    /// URLSession's async `receive()` does not answer task cancellation, so a
    /// pending one holds its enclosing task group open at scope exit and hangs the
    /// whole suite instead of failing one test. Closing the socket makes it throw.
    private func receiveRequest(
        on task: URLSessionWebSocketTask,
        within seconds: Double = 10
    ) async throws -> [String: Any] {
        let deadline = Task {
            try await Task.sleep(for: .seconds(seconds))
            task.cancel()
        }
        defer { deadline.cancel() }

        guard case let .string(text) = try await task.receive(),
              let parsed = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
        else { throw BridgeTestError.unexpectedReply }
        return parsed
    }

    /// Answers a bridge request the way background.js does, with the correlation id.
    private func respond(
        to request: [String: Any],
        on task: URLSessionWebSocketTask,
        data: String,
        success: Bool = true
    ) async throws {
        guard let id = request["id"] as? String else { throw BridgeTestError.unexpectedReply }
        let payload: [String: Any] = [
            "id": id,
            "success": success,
            "data": success ? data : NSNull(),
            "error": success ? NSNull() : data,
        ]
        let encoded = try JSONSerialization.data(withJSONObject: payload)
        try await task.send(.string(String(decoding: encoded, as: UTF8.self)))
    }

    private enum BridgeTestError: Error {
        case unexpectedReply
        case timedOut
    }

    /// Bounds every wait on the socket. These tests bind fixed ports, so another
    /// copy of the suite running at the same time takes them and the handshake
    /// never answers. Failing after a few seconds is diagnosable; hanging holds
    /// the SwiftPM build lock until someone notices.
    private func withTimeout<T: Sendable>(
        _ seconds: Double = 30,
        _ operation: @escaping @Sendable () async throws -> T
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(for: .seconds(seconds))
                throw BridgeTestError.timedOut
            }
            guard let result = try await group.next() else { throw BridgeTestError.timedOut }
            group.cancelAll()
            return result
        }
    }

    // MARK: - Tests

    @Test func ephemeralPortIsPublishedAndAuthenticates() async throws {
        try await withStartedBridge(port: 0) { bridge, port in
            // A zero here would make both status and the per-port token unusable.
            try #require(port != 0)
            let status = await bridge.status()
            #expect(status.requestedPort == 0)
            #expect(status.port == port)
            #expect(status.tokenFileSecure == true)
            let token = try String(contentsOfFile: WebSocketBridge.tokenFilePath(for: port), encoding: .utf8)
            let client = makeTask(port: port)
            defer { client.cancel() }
            let reply = try await authenticate(port: port, token: token, profileId: "default", task: client)
            #expect(reply["auth"] as? String == "ok")
        }
    }

    @Test func anotherProfilesReplyCannotConsumeAPendingRequest() async throws {
        try await withStartedBridge(port: 0) { bridge, port in
            let token = await bridge.authToken
            let personal = makeTask(port: port)
            let work = makeTask(port: port)
            defer { personal.cancel(); work.cancel() }
            try await authenticate(port: port, token: token, profileId: "default", task: personal)
            try await authenticate(port: port, token: token, profileId: "WORK-UUID", task: work)

            async let answered = bridge.send(action: "snapshot", timeout: 5, profileIndex: 0)
            let request = try await receiveRequest(on: personal)
            try await respond(to: request, on: work, data: "wrong profile")
            // A second request on the same socket is a barrier: its reply proves
            // the bridge has processed the preceding wrong-profile message.
            async let barrier = bridge.send(action: "tabs_query", timeout: 5, profileIndex: 1)
            let check = try await receiveRequest(on: work)
            try await respond(to: check, on: work, data: "barrier")
            _ = try await barrier
            try await respond(to: request, on: personal, data: "correct profile")
            #expect(try await answered.data?.stringValue == "correct profile")
        }
    }

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

            // The regression: the second handshake used to cancel the first, which
            // would leave only one of these behind.
            #expect(try await settledProfiles(bridge) == ["WORK-UUID", "default"])

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

            // Replacing WORK-UUID must not take the default profile with it.
            #expect(try await settledProfiles(bridge) == ["WORK-UUID", "default"])

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
            // The surviving profile stays put rather than being swept with the other.
            #expect(try await settledProfiles(bridge) == ["default"])

            personal.cancel()
        }
    }

    // MARK: - Routing

    @Test func aProfileIndexRoutesTheRequestToThatProfileAlone() async throws {
        try await withStartedBridge(port: 8134) { bridge, port in
            let token = await bridge.authToken

            let personal = makeTask(port: port)
            let work = makeTask(port: port)
            try await authenticate(port: port, token: token, profileId: "default", task: personal)
            try await authenticate(port: port, token: token, profileId: "WORK-UUID", task: work)

            // p1 is WORK-UUID, which is neither the default profile nor the one an
            // untargeted call would drive, so reaching it proves the routing.
            async let workAnswered: BridgeResponse = bridge.send(
                action: "tabs_query",
                params: ["tabId": AnyCodable(5)],
                timeout: 10,
                profileIndex: 1
            )

            let workRequest = try await receiveRequest(on: work)
            #expect(workRequest["action"] as? String == "tabs_query")
            #expect((workRequest["params"] as? [String: Any])?["tabId"] as? Int == 5)
            try await respond(to: workRequest, on: work, data: "work tabs")
            #expect(try await workAnswered.data?.stringValue == "work tabs")

            // Then the other way. If the first request had gone to the default
            // profile, this is the frame the default socket would be holding, and
            // its action would read tabs_query rather than snapshot.
            async let personalAnswered: BridgeResponse = bridge.send(
                action: "snapshot", timeout: 10, profileIndex: 0
            )
            let personalRequest = try await receiveRequest(on: personal)
            #expect(personalRequest["action"] as? String == "snapshot")
            try await respond(to: personalRequest, on: personal, data: "default snapshot")
            #expect(try await personalAnswered.data?.stringValue == "default snapshot")

            personal.cancel()
            work.cancel()
        }
    }

    @Test func namingAProfileThatIsNotConnectedFailsInsteadOfFallingBack() async throws {
        try await withStartedBridge(port: 8135) { bridge, port in
            let token = await bridge.authToken
            let personal = makeTask(port: port)
            try await authenticate(port: port, token: token, profileId: "default", task: personal)

            // Answering from a different profile would be worse than refusing: the
            // caller asked for one browser window and would get another.
            await #expect(throws: WebSocketBridge.BridgeError.self) {
                _ = try await bridge.send(action: "tabs_query", timeout: 5, profileIndex: 3)
            }

            do {
                _ = try await bridge.send(action: "tabs_query", timeout: 5, profileIndex: 3)
            } catch let error as WebSocketBridge.BridgeError {
                #expect(error.description.contains("p3"))
                #expect(error.toolFailure.code == "profile_not_connected")
            }

            personal.cancel()
        }
    }

    @Test func selectingAProfilePinsWhereUntargetedCallsLand() async throws {
        try await withStartedBridge(port: 8136) { bridge, port in
            let token = await bridge.authToken

            let personal = makeTask(port: port)
            let work = makeTask(port: port)
            try await authenticate(port: port, token: token, profileId: "default", task: personal)
            try await authenticate(port: port, token: token, profileId: "WORK-UUID", task: work)

            // The default profile wins until something says otherwise.
            #expect(await bridge.connectedProfiles().first { $0.selected }?.id == "default")

            try await bridge.selectProfile(atIndex: 1)
            #expect(await bridge.connectedProfiles().first { $0.selected }?.id == "WORK-UUID")

            // No profile named, so this follows the pin to WORK-UUID rather than
            // going to the default profile it would have gone to a moment ago.
            async let answered: BridgeResponse = bridge.send(action: "snapshot", timeout: 10)
            let delivered = try await receiveRequest(on: work)
            #expect(delivered["action"] as? String == "snapshot")
            try await respond(to: delivered, on: work, data: "work snapshot")
            #expect(try await answered.data?.stringValue == "work snapshot")

            personal.cancel()
            work.cancel()
        }
    }

    @Test func aPinnedProfileGoingAwayFallsThroughRatherThanBreakingEveryCall() async throws {
        try await withStartedBridge(port: 8137) { bridge, port in
            let token = await bridge.authToken

            let personal = makeTask(port: port)
            let work = makeTask(port: port)
            try await authenticate(port: port, token: token, profileId: "default", task: personal)
            try await authenticate(port: port, token: token, profileId: "WORK-UUID", task: work)
            try await bridge.selectProfile(atIndex: 1)

            work.cancel(with: .goingAway, reason: nil)

            var profiles = await bridge.connectedProfiles()
            for _ in 0..<50 where profiles.count > 1 {
                try await Task.sleep(for: .milliseconds(20))
                profiles = await bridge.connectedProfiles()
            }

            // Closing the pinned profile's window must not leave every untargeted
            // call failing until someone calls select_tab again.
            #expect(profiles.map(\.id) == ["default"])
            #expect(profiles.first { $0.selected }?.id == "default")

            personal.cancel()
        }
    }

    @Test func broadcastReachesEveryProfileAndReportsEachSeparately() async throws {
        try await withStartedBridge(port: 8138) { bridge, port in
            let token = await bridge.authToken

            let personal = makeTask(port: port)
            let work = makeTask(port: port)
            try await authenticate(port: port, token: token, profileId: "default", task: personal)
            try await authenticate(port: port, token: token, profileId: "WORK-UUID", task: work)

            async let outcomes: [WebSocketBridge.ProfileOutcome] = bridge.broadcast(
                action: "tabs_query", timeout: 10
            )

            // Both sockets are sent to at once, so both frames are already in
            // flight and the order these are read in does not matter.
            let personalRequest = try await receiveRequest(on: personal)
            let workRequest = try await receiveRequest(on: work)
            #expect(personalRequest["action"] as? String == "tabs_query")
            #expect(workRequest["action"] as? String == "tabs_query")

            try await respond(to: personalRequest, on: personal, data: "default tabs")
            // One profile refusing a read must not withhold what the other returned.
            try await respond(to: workRequest, on: work, data: "extension busy", success: false)

            let results = try await outcomes
            #expect(results.map(\.index) == [0, 1])
            #expect(results.map(\.profileID) == ["default", "WORK-UUID"])
            // Both profiles replied, so neither outcome is `.unreachable`. A
            // refusal is still a reply, which is the distinction that keeps
            // "the extension said no" apart from "nothing came back".
            guard case .answered(let fromPersonal) = results[0].reply,
                  case .answered(let fromWork) = results[1].reply
            else {
                Issue.record("Both profiles answered, so both replies should be .answered.")
                return
            }
            #expect(fromPersonal.success == true)
            #expect(fromPersonal.data?.stringValue == "default tabs")
            #expect(fromWork.success == false)
            #expect(fromWork.error == "extension busy")

            personal.cancel()
            work.cancel()
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
