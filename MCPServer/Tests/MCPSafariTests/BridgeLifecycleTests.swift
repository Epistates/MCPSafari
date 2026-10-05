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
        let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        try #require(descriptor >= 0)
        defer { Darwin.close(descriptor) }
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
        try #require(connected == 0)

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
