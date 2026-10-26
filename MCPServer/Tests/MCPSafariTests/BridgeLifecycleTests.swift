import Darwin
import Foundation
import Logging
import Testing
@testable import MCPSafari

/// `start()` returns early while `listener` is non-nil, so anything the failing
/// bind path leaves behind decides whether the bridge can ever recover. These
/// occupy the real ports rather than faking a failure, because the defect is in
/// what the sweep leaves set rather than in any computation.
struct BridgeLifecycleTests {
    private let tokenRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)

    /// The token files go to a directory of this test's own, so a running Safari
    /// never reads them and never dials these ports.
    @Test func aBridgeThatCouldNotBindStillStartsOnceAPortFreesUp() async throws {
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }

        let first: UInt16 = 8301
        var held = holdPorts(from: first, count: 10)
        defer { for descriptor in held { Darwin.close(descriptor) } }
        try #require(held.count == 10, "every port in the sweep has to be occupied for this to test anything")

        let bridge = try WebSocketBridge(
            port: first,
            logger: Logger(label: "BridgeLifecycleTests"),
            tokenRoot: tokenRoot
        )
        await bridge.start()

        var status = await bridge.status()
        #expect(status.listener == .failed)
        // Without a reason recorded, `doctor` and `status` report a dead bridge
        // and leave the user to guess that something else holds the ports.
        #expect(status.lastError?.code == "bridge_bind_failed")
        // The last port tried is held by someone else. Reporting it would point
        // `status` at that other server's token file.
        #expect(status.port == first)

        for descriptor in held { Darwin.close(descriptor) }
        held = []
        await bridge.start()

        status = await bridge.status()
        #expect(status.listener == .listening)
        #expect(status.lastError == nil)
        #expect(status.port == first)
        await bridge.stop()
    }

    /// "Open Safari and click the extension icon" is the wrong advice when the
    /// server never opened its port, and it is what every tool said (#154).
    @Test func everyCallSaysWhyWhenTheBridgeCouldNotBind() async throws {
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }

        let first: UInt16 = 8401
        let held = holdPorts(from: first, count: 10)
        defer { for descriptor in held { Darwin.close(descriptor) } }
        try #require(held.count == 10, "every port in the sweep has to be occupied for this to test anything")

        let bridge = try WebSocketBridge(
            port: first,
            logger: Logger(label: "BridgeLifecycleTests"),
            tokenRoot: tokenRoot
        )
        await bridge.start()
        defer { Task { await bridge.stop() } }
        let reason = try #require(await bridge.status().lastError)

        let failures = [
            await bridgeFailure { _ = try await bridge.send(action: "tabs_query") },
            await bridgeFailure { _ = try await bridge.send(action: "tabs_query", profileIndex: 0) },
            await bridgeFailure { _ = try await bridge.broadcast(action: "tabs_query") },
        ]
        for failure in failures {
            #expect(failure?.code == "bridge_unavailable")
            #expect(failure?.message.contains(reason.message) == true)
            #expect(failure?.message.contains(reason.recovery) == true)
        }
    }

    /// A port held when the client started is not a reason to stay dead for the
    /// life of the process (#154).
    @Test func aBridgeThatCouldNotBindRetriesWithoutBeingAsked() async throws {
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }

        let first: UInt16 = 8411
        var held = holdPorts(from: first, count: 10)
        defer { for descriptor in held { Darwin.close(descriptor) } }
        try #require(held.count == 10, "every port in the sweep has to be occupied for this to test anything")

        let bridge = try WebSocketBridge(
            port: first,
            logger: Logger(label: "BridgeLifecycleTests"),
            tokenRoot: tokenRoot,
            rebindDelay: .milliseconds(50)
        )
        await bridge.start()
        #expect(await bridge.status().listener == .failed)

        for descriptor in held { Darwin.close(descriptor) }
        held = []

        #expect(await eventually { await bridge.status().listener == .listening })
        let status = await bridge.status()
        #expect(status.port == first)
        #expect(status.lastError == nil)
        // With the listener up, a call is back to being about the extension.
        let failure = await bridgeFailure { _ = try await bridge.send(action: "tabs_query") }
        #expect(failure?.code == "bridge_disconnected")
        await bridge.stop()
    }

    /// The listener is ready a little before its token is on disk, and a socket
    /// accepted in that gap used to be cancelled before the upgrade, which the
    /// extension saw as a bridge that hung up on it for no reason (#156). This
    /// holds the bridge in that gap and dials into it.
    @Test func aDialInsideTheStartupGapIsHeldAndThenServed() async throws {
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }

        let (gateStream, gate) = AsyncStream<Void>.makeStream()
        let port: UInt16 = 8391
        let bridge = try WebSocketBridge(
            port: port,
            logger: Logger(label: "BridgeLifecycleTests"),
            tokenRoot: tokenRoot,
            beforeTokenPublication: { for await _ in gateStream { break } }
        )
        let starting = Task { await bridge.start() }
        defer { gate.finish(); Task { await bridge.stop() } }

        // The listener accepts TCP as soon as it is ready, which is before the
        // hook above returns, so this connects inside the gap.
        var dialled: RawSocket?
        let deadline = Date().addingTimeInterval(10)
        while dialled == nil, Date() < deadline { dialled = RawSocket.dial(port: port) }
        let socket = try #require(dialled, "the listener never came up")

        // Held means silent. A cancelled socket instead reads end-of-file or is reset.
        #expect(socket.reply(within: 0.3) == .silent, "the socket is neither served nor dropped yet")

        gate.yield()
        await starting.value

        #expect(socket.reply() == .upgraded)
    }

    /// A listener left in place by one failed attempt would also make `stop()`
    /// the only way back, so check the ordinary restart path stays intact.
    @Test func aStoppedBridgeCanBeStartedAgain() async throws {
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }

        let bridge = try WebSocketBridge(
            port: 8311,
            logger: Logger(label: "BridgeLifecycleTests"),
            tokenRoot: tokenRoot
        )
        await bridge.start()
        #expect(await bridge.status().listener == .listening)

        await bridge.stop()
        #expect(await bridge.status().listener == .stopped)

        await bridge.start()
        #expect(await bridge.status().listener == .listening)
        await bridge.stop()
    }
}
