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

    /// Binds and listens on `count` consecutive loopback ports with plain POSIX
    /// sockets. Deterministic in a way an NWListener is not: there is no ready
    /// state to wait for, so the ports are occupied the moment this returns.
    private func holdPorts(from first: UInt16, count: UInt16) -> [Int32] {
        var held: [Int32] = []
        for offset in 0..<count {
            let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
            guard descriptor >= 0 else { continue }
            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = (first + offset).bigEndian
            address.sin_addr.s_addr = inet_addr("127.0.0.1")
            let bound = withUnsafePointer(to: &address) { pointer in
                pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            if bound == 0, Darwin.listen(descriptor, 1) == 0 {
                held.append(descriptor)
            } else {
                Darwin.close(descriptor)
            }
        }
        return held
    }

    /// A plain TCP connection to the loopback address, or nil if it is refused.
    private static func connectLoopback(port: UInt16) -> Int32? {
        let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return nil }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let connected = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard connected == 0 else {
            Darwin.close(descriptor)
            return nil
        }
        return descriptor
    }

    /// Ports here sit above the extension's auto-scan range (8089-8098) so a
    /// running Safari never dials them.
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
            tokenRoots: [tokenRoot]
        )
        await bridge.start()

        var status = await bridge.status()
        #expect(status.listener == .failed)
        // Without a reason recorded, `doctor` and `status` report a dead bridge
        // and leave the user to guess that something else holds the ports.
        #expect(status.lastError?.code == "bridge_bind_failed")

        for descriptor in held { Darwin.close(descriptor) }
        held = []
        await bridge.start()

        status = await bridge.status()
        #expect(status.listener == .listening)
        #expect(status.lastError == nil)
        #expect(status.port == first)
        await bridge.stop()
    }

    /// Writes a WebSocket upgrade by hand so the request headers are under this
    /// test's control. `NWConnection`'s own WebSocket client wants a URL
    /// endpoint rather than a host and port, and `URLSessionWebSocketTask` sends
    /// no `Origin` at all, so neither can ask this question.
    private func upgradeRequest(port: UInt16, origin: String?) -> String {
        let key = Data((0..<16).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()
        var lines = [
            "GET / HTTP/1.1",
            "Host: 127.0.0.1:\(port)",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: \(key)",
            "Sec-WebSocket-Version: 13",
        ]
        if let origin { lines.append("Origin: \(origin)") }
        return lines.joined(separator: "\r\n") + "\r\n\r\n"
    }

    /// Whether a loopback WebSocket server can see the browser's `Origin` at all
    /// decides whether #121 is implementable, and it is: the header reaches
    /// `setClientRequestHandler`, which also gets to refuse the handshake.
    /// Nothing is refused on it yet, because what Safari sends is still unknown.
    @Test func theHandshakeOriginIsVisibleToTheServer() async throws {
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }

        let bridge = try WebSocketBridge(
            port: 8371,
            logger: Logger(label: "BridgeLifecycleTests"),
            tokenRoots: [tokenRoot]
        )
        await bridge.start()
        defer { Task { await bridge.stop() } }
        let port = await bridge.port
        #expect(await bridge.lastHandshakeOrigin == nil)

        let origin = "safari-web-extension://0E4C1B2A-TEST"
        let descriptor = try #require(Self.connectLoopback(port: port))
        defer { Darwin.close(descriptor) }

        let request = Array(upgradeRequest(port: port, origin: origin).utf8)
        try #require(Darwin.write(descriptor, request, request.count) == request.count)

        var reply = [UInt8](repeating: 0, count: 256)
        let read = Darwin.read(descriptor, &reply, reply.count)
        try #require(read > 0)
        let status = String(decoding: reply.prefix(read), as: UTF8.self)
        #expect(status.hasPrefix("HTTP/1.1 101"), "the handshake is accepted, not refused: \(status)")

        try await Task.sleep(for: .milliseconds(250))
        #expect(await bridge.lastHandshakeOrigin == origin)
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
            tokenRoots: [tokenRoot],
            beforeTokenPublication: { for await _ in gateStream { break } }
        )
        let starting = Task { await bridge.start() }
        defer { gate.finish(); Task { await bridge.stop() } }

        // The listener accepts TCP as soon as it is ready, which is before the
        // hook above returns, so this connects inside the gap.
        var descriptor: Int32?
        let deadline = Date().addingTimeInterval(10)
        while descriptor == nil, Date() < deadline { descriptor = Self.connectLoopback(port: port) }
        let socket = try #require(descriptor, "the listener never came up")
        defer { Darwin.close(socket) }

        let request = Array(upgradeRequest(port: port, origin: nil).utf8)
        try #require(Darwin.write(socket, request, request.count) == request.count)

        var timeout = timeval(tv_sec: 0, tv_usec: 300_000)
        setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var reply = [UInt8](repeating: 0, count: 256)
        // Held means silent: a read that times out. A cancelled socket instead
        // reads end-of-file, or is reset.
        let held = Darwin.read(socket, &reply, reply.count)
        #expect(held == -1 && errno == EAGAIN, "the socket is neither served nor dropped yet")

        gate.yield()
        await starting.value

        timeout = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(socket, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        let read = Darwin.read(socket, &reply, reply.count)
        #expect(read > 0 && String(decoding: reply.prefix(read), as: UTF8.self).hasPrefix("HTTP/1.1 101"))
    }

    /// A listener left in place by one failed attempt would also make `stop()`
    /// the only way back, so check the ordinary restart path stays intact.
    @Test func aStoppedBridgeCanBeStartedAgain() async throws {
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }

        let bridge = try WebSocketBridge(
            port: 8311,
            logger: Logger(label: "BridgeLifecycleTests"),
            tokenRoots: [tokenRoot]
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
