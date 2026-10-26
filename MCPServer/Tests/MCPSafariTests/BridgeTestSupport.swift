import CryptoKit
import Darwin
import Foundation
import Logging
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

/// Binds and listens on `count` consecutive loopback ports with plain POSIX
/// sockets. Deterministic in a way an NWListener is not: there is no ready
/// state to wait for, so the ports are occupied the moment this returns.
/// The caller closes the descriptors.
func holdPorts(from first: UInt16, count: UInt16) -> [Int32] {
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

/// Runs `body` against a started bridge and stops it afterwards, with its token
/// files in a directory of its own. `port` 0 takes any free port, which keeps
/// tests from colliding; the port it bound is passed to `body`.
func withStartedBridge(
    port: UInt16 = 0,
    handshakeDeadline: Duration = .seconds(30),
    _ body: (WebSocketBridge, UInt16) async throws -> Void
) async throws {
    let tokenRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tokenRoot) }
    let bridge = try WebSocketBridge(
        port: port,
        logger: Logger(label: "BridgeTests"),
        tokenRoot: tokenRoot,
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

func webSocketTask(port: UInt16) -> URLSessionWebSocketTask {
    URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)")!)
}

/// Waits for the server to hang up on this socket, reading past anything it says
/// first. Gives up after `timeout`, because a read that never fails would
/// otherwise stall the whole suite on exactly the bug the test is looking for.
func serverHungUp(on task: URLSessionWebSocketTask, timeout: Duration = .seconds(5)) async -> Bool {
    await withTaskGroup(of: Bool.self) { group in
        group.addTask {
            while true {
                do { _ = try await task.receive() } catch { return true }
            }
        }
        group.addTask {
            try? await Task.sleep(for: timeout)
            return false
        }
        let first = await group.next() ?? false
        // A pending `receive` is ended by cancelling the task, not the Swift task.
        if !first { task.cancel() }
        group.cancelAll()
        return first
    }
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

    /// The bytes of a WebSocket upgrade request, with an `Origin` header if given.
    static func upgradeRequest(port: UInt16, origin: String? = nil) -> [UInt8] {
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
        return Array((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    }

    @discardableResult
    func sendUpgrade(port: UInt16, origin: String? = nil) -> Bool {
        let request = Self.upgradeRequest(port: port, origin: origin)
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

    /// Sends one masked text frame, as a client must. Payloads here are small: the
    /// two-byte length form covers anything under 64 KiB.
    @discardableResult
    func sendText(_ text: String) -> Bool {
        let payload = Array(text.utf8)
        precondition(payload.count < 65536, "RawSocket frames are short ones")
        let mask: [UInt8] = [0x37, 0xFA, 0x21, 0x3D]
        var frame: [UInt8] = [0x81]
        if payload.count < 126 {
            frame.append(0x80 | UInt8(payload.count))
        } else {
            frame += [0x80 | 126, UInt8(payload.count >> 8), UInt8(payload.count & 0xFF)]
        }
        frame += mask
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

// MARK: - The extension's side of the handshake

/// Something that carries text frames to and from the bridge.
protocol FrameTransport {
    func sendFrame(_ text: String) async throws
    func receiveFrame() async throws -> String
}

enum FrameTransportError: Error {
    case closed
    case notText
}

extension URLSessionWebSocketTask: FrameTransport {
    func sendFrame(_ text: String) async throws { try await send(.string(text)) }

    func receiveFrame() async throws -> String {
        guard case let .string(text) = try await receive() else { throw FrameTransportError.notText }
        return text
    }
}

extension RawSocket: FrameTransport {
    func sendFrame(_ text: String) async throws {
        guard sendText(text) else { throw FrameTransportError.closed }
    }

    func receiveFrame() async throws -> String {
        guard let text = readText() else { throw FrameTransportError.closed }
        return text
    }
}

/// The extension's half of the handshake, written independently of
/// `BridgeHandshake`: its HMACs come straight from CryptoKit over the documented
/// message text, so a mistake in the server's proof code cannot be reproduced here
/// and hide itself. The known-answer vectors in the tests pin both to the same bytes.
struct TestExtension {
    var token: String
    var port: UInt16
    var profileId: String? = "default"
    var extensionVersion = "0.4.0"
    var protocolVersion = MCPSafariProduct.bridgeProtocolVersion
    var clientNonce = BridgeHandshake.makeNonce()

    // MARK: Proofs

    static func mac(_ token: String, _ message: String) -> String {
        let code = HMAC<SHA256>.authenticationCode(
            for: Data(message.utf8),
            using: SymmetricKey(data: Data(token.utf8))
        )
        return Data(code).base64URLEncodedString()
    }

    static func serverProof(token: String, port: UInt16, clientNonce: String, serverNonce: String) -> String {
        mac(token, "mcpsafari-v\(MCPSafariProduct.bridgeProtocolVersion)-server|\(port)|\(clientNonce)|\(serverNonce)")
    }

    static func clientProof(token: String, port: UInt16, clientNonce: String, serverNonce: String) -> String {
        mac(token, "mcpsafari-v\(MCPSafariProduct.bridgeProtocolVersion)-client|\(port)|\(serverNonce)|\(clientNonce)")
    }

    // MARK: Frames

    func helloFrame() throws -> String {
        var hello: [String: Any] = [
            "clientNonce": clientNonce,
            "extensionVersion": extensionVersion,
            "protocolVersion": protocolVersion,
        ]
        if let profileId { hello["profileId"] = profileId }
        return try Self.json(["hello": hello])
    }

    static func proofFrame(_ proof: String) throws -> String {
        try json(["auth": ["clientProof": proof]])
    }

    static func json(_ object: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    static func parse(_ text: String) throws -> [String: Any] {
        guard let object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
        else { throw FrameTransportError.notText }
        return object
    }

    // MARK: Exchanges

    /// Sends the hello and returns the challenge the server answers with, or
    /// whatever else it answered with instead.
    func sayHello(over transport: some FrameTransport) async throws -> [String: Any] {
        try await transport.sendFrame(helloFrame())
        return try Self.parse(try await transport.receiveFrame())
    }

    /// The server's proof as it appears in `challenge`, checked against the token
    /// this client holds. False when the server's answer was not a challenge at all.
    func serverIsGenuine(_ challengeFrame: [String: Any]) -> Bool {
        guard let challenge = challengeFrame["challenge"] as? [String: Any],
              let serverNonce = challenge["serverNonce"] as? String,
              let proof = challenge["serverProof"] as? String
        else { return false }
        return proof == Self.serverProof(token: token, port: port, clientNonce: clientNonce, serverNonce: serverNonce)
    }

    /// Runs the whole exchange against a real server and returns its last frame.
    /// `proofToken` is the key the client proof is made with, which differs from
    /// `token` when a test plays an extension holding a stale token.
    func handshake(
        over transport: some FrameTransport,
        proofToken: String? = nil
    ) async throws -> [String: Any] {
        let challengeFrame = try await sayHello(over: transport)
        guard let challenge = challengeFrame["challenge"] as? [String: Any],
              let serverNonce = challenge["serverNonce"] as? String
        else { return challengeFrame }
        guard serverIsGenuine(challengeFrame) else { throw HandshakeFailure.serverNotGenuine }

        let proof = Self.clientProof(
            token: proofToken ?? token,
            port: port,
            clientNonce: clientNonce,
            serverNonce: serverNonce
        )
        try await transport.sendFrame(Self.proofFrame(proof))
        return try Self.parse(try await transport.receiveFrame())
    }
}

enum HandshakeFailure: Error {
    case serverNotGenuine
}
