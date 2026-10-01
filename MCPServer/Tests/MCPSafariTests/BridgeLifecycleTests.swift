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
