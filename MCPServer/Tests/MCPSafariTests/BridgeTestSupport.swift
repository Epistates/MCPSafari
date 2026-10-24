import Darwin
import Foundation
@testable import MCPSafari

/// Polls until `condition` holds or `timeout` passes, and returns whether it held.
///
/// For asserting on something an actor does on its own schedule. Sleeping a fixed
/// time and then checking passes on a slow machine for the wrong reason and fails
/// on a busy one, and a negative check after a sleep proves nothing; waiting on
/// the observable condition does neither.
func eventually(
    timeout: Duration = .seconds(5),
    _ condition: () async -> Bool
) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return await condition()
}

/// What a bridge call fails with as the MCP client would see it, or nil if the call
/// succeeded or failed some other way.
func bridgeFailure(of call: () async throws -> Void) async -> ToolFailure? {
    do {
        try await call()
        return nil
    } catch let error as WebSocketBridge.BridgeError {
        return error.toolFailure
    } catch {
        return nil
    }
}

/// A plain TCP client to the loopback bridge, speaking the upgrade by hand.
///
/// `URLSessionWebSocketTask` sends no `Origin` and reports a refused upgrade only
/// after a long timeout, and `NWConnection`'s WebSocket client wants a URL rather
/// than a host and port. Writing the request directly puts the headers under the
/// test's control and shows the server's first answer as soon as it gives one.
final class RawSocket {
    enum Reply: Equatable {
        /// `101 Switching Protocols`: the bridge admitted the connection.
        case upgraded
        /// An HTTP answer that is not an upgrade, with its status line.
        case rejected(String)
        /// The server closed or reset the connection without answering.
        case closed
        /// Nothing arrived in time.
        case silent
    }

    let descriptor: Int32

    /// Nil if the connection is refused.
    init?(port: UInt16) {
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
        self.descriptor = descriptor
    }

    deinit { Darwin.close(descriptor) }

    @discardableResult
    func sendUpgrade(port: UInt16, origin: String? = nil) -> Bool {
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
        let request = Array((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
        return Darwin.write(descriptor, request, request.count) == request.count
    }

    func reply(within seconds: Double = 5) -> Reply {
        var timeout = timeval(tv_sec: Int(seconds), tv_usec: Int32((seconds - seconds.rounded(.down)) * 1_000_000))
        setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var buffer = [UInt8](repeating: 0, count: 512)
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count > 0 {
            let text = String(decoding: buffer.prefix(count), as: UTF8.self)
            if text.hasPrefix("HTTP/1.1 101") { return .upgraded }
            return .rejected(String(text.prefix { $0 != "\r" }))
        }
        return count == 0 || errno != EAGAIN ? .closed : .silent
    }

    /// Sends one masked text frame, as a client must. Payloads here are small.
    @discardableResult
    func sendText(_ text: String) -> Bool {
        let payload = Array(text.utf8)
        precondition(payload.count < 126, "RawSocket frames are short ones")
        let mask: [UInt8] = [0x37, 0xFA, 0x21, 0x3D]
        var frame: [UInt8] = [0x81, 0x80 | UInt8(payload.count)] + mask
        for (index, byte) in payload.enumerated() { frame.append(byte ^ mask[index % 4]) }
        return Darwin.write(descriptor, frame, frame.count) == frame.count
    }

    /// The next text frame the server sends, or nil if it closes or goes quiet.
    func readText(within seconds: Double = 5) -> String? {
        var timeout = timeval(tv_sec: Int(seconds), tv_usec: Int32((seconds - seconds.rounded(.down)) * 1_000_000))
        setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var buffer = [UInt8](repeating: 0, count: 1024)
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        guard count >= 2, buffer[0] & 0x0F == 0x1, buffer[1] <= 126 else { return nil }
        let extended = buffer[1] == 126
        let start = extended ? 4 : 2
        guard count >= start else { return nil }
        let length = extended ? Int(buffer[2]) << 8 | Int(buffer[3]) : Int(buffer[1])
        guard count >= start + length else { return nil }
        return String(decoding: buffer[start..<(start + length)], as: UTF8.self)
    }

    /// A connection that has sent its upgrade request, or nil if it could not.
    static func dial(port: UInt16, origin: String? = nil) -> RawSocket? {
        guard let socket = RawSocket(port: port), socket.sendUpgrade(port: port, origin: origin) else { return nil }
        return socket
    }
}
