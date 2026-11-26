import Foundation
import Logging
import Testing
@testable import MCPSafari

/// Each Safari profile finds a newly started server on its next keepalive token
/// read, which comes every 30 seconds (#168). A call made in that time used to wait
/// out only the 12-second reconnect grace and then fail, though Safari was on its
/// way. These pin the wait: through the discovery window for a new server, ended
/// the moment Safari connects, and never past the call's own time.
struct ProfileDiscoveryTests {
    private let tokenRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)

    private func makeBridge(grace: Duration, discovery: Duration) throws -> WebSocketBridge {
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        return try WebSocketBridge(
            port: 0,
            logger: Logger(label: "ProfileDiscoveryTests"),
            tokenRoot: tokenRoot,
            connectGraceTimeout: grace,
            discoveryWindow: discovery
        )
    }

    /// Connects a stand-in for one Safari profile and answers the first request with an empty listing.
    private func connectProfile(to bridge: WebSocketBridge, after wait: Duration) async throws -> URLSessionWebSocketTask {
        try await Task.sleep(for: wait)
        let port = await bridge.port
        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
        task.resume()
        let ext = TestExtension(token: await bridge.authToken, port: port, profileId: "default", extensionVersion: "0.4.1")
        _ = try await ext.handshake(over: task)
        guard case let .string(text) = try await task.receive(),
              let request = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let id = request["id"] as? String
        else { throw CancellationError() }
        let reply = try JSONSerialization.data(withJSONObject: ["id": id, "success": true, "data": "[]"])
        try await task.send(.string(String(decoding: reply, as: UTF8.self)))
        return task
    }

    @Test func aCallJustAfterStartWaitsPastTheReconnectGraceForSafariToFindTheServer() async throws {
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        let bridge = try makeBridge(grace: .milliseconds(150), discovery: .seconds(5))
        await bridge.start()
        defer { Task { await bridge.stop() } }

        let call = Task { try await bridge.send(action: "tabs_query", timeout: 10) }
        // Well past the grace, as a profile reading on its next keepalive is.
        let profile = try await connectProfile(to: bridge, after: .seconds(1))
        defer { profile.cancel() }

        let response = try await call.value
        #expect(response.success == true)
    }

    @Test func theWaitEndsTheMomentSafariConnectsRatherThanAtTheWindowsEnd() async throws {
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        let bridge = try makeBridge(grace: .milliseconds(150), discovery: .seconds(30))
        await bridge.start()
        defer { Task { await bridge.stop() } }

        let start = ContinuousClock.now
        let call = Task { try await bridge.send(action: "tabs_query", timeout: 40) }
        let profile = try await connectProfile(to: bridge, after: .milliseconds(300))
        defer { profile.cancel() }
        _ = try await call.value

        #expect(ContinuousClock.now - start < .seconds(5))
    }

    @Test func theDiscoveryWaitStillEndsWithTheCallsOwnTime() async throws {
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        let bridge = try makeBridge(grace: .milliseconds(150), discovery: .seconds(30))
        await bridge.start()
        defer { Task { await bridge.stop() } }

        let start = ContinuousClock.now
        let failure = await bridgeFailure { _ = try await bridge.send(action: "tabs_query", timeout: 0.3) }

        #expect(failure?.code == "bridge_disconnected")
        #expect(ContinuousClock.now - start < .seconds(3))
    }

    @Test func onceTheWindowHasPassedACallWaitsOnlyTheReconnectGrace() async throws {
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        let bridge = try makeBridge(grace: .milliseconds(150), discovery: .milliseconds(300))
        await bridge.start()
        defer { Task { await bridge.stop() } }
        try await Task.sleep(for: .milliseconds(400))

        let start = ContinuousClock.now
        let failure = await bridgeFailure { _ = try await bridge.send(action: "tabs_query", timeout: 10) }

        #expect(failure?.code == "bridge_disconnected")
        #expect(ContinuousClock.now - start < .seconds(2))
    }

    @Test func theTimeLeftForProfilesToFindTheServerIsReportedOnlyWhileThereIsSome() async throws {
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        let young = try makeBridge(grace: .zero, discovery: .seconds(30))
        #expect(await young.profileDiscoveryTimeLeft() == nil, "nothing to find before it listens")
        await young.start()
        defer { Task { await young.stop() } }

        let left = try #require(await young.profileDiscoveryTimeLeft())
        #expect(left > .seconds(25) && left <= .seconds(30))

        let settled = try makeBridge(grace: .zero, discovery: .zero)
        await settled.start()
        defer { Task { await settled.stop() } }
        #expect(await settled.profileDiscoveryTimeLeft() == nil)
    }

    @Test func aListingWhileProfilesMayStillBeConnectingSaysSoAndWhenToLookAgain() {
        let note = SafariMCPServer.profileDiscoveryNote(timeLeft: .seconds(23.4))
        #expect(note.contains("24 seconds"))
        #expect(note.contains("tabs_context"))
    }
}
