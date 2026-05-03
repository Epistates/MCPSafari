import Foundation
import Logging
import Network

/// WebSocket server that bridges MCP tool calls to the Safari extension.
///
/// Listens on a local port for a WebSocket connection from the extension's
/// background.js. Automatically falls back to successive ports if the requested
/// port is in use. Provides a request/response pattern: sends a `BridgeRequest`,
/// awaits a correlated `BridgeResponse` by matching IDs.
actor WebSocketBridge {
    private var listener: NWListener?
    /// The authenticated extension connection currently allowed to receive MCP requests.
    private var connection: NWConnection?
    /// A newly accepted connection that has not completed the token handshake yet.
    private var authenticatingConnection: NWConnection?
    private struct PendingRequest {
        let connectionID: ObjectIdentifier
        let continuation: CheckedContinuation<BridgeResponse, any Error>
    }

    private var pendingRequests: [String: PendingRequest] = [:]
    private let logger: Logger
    private let requestedPort: UInt16
    private(set) var port: UInt16
    private let networkQueue = DispatchQueue(label: "mcp-safari.websocket", qos: .userInitiated)

    /// Authentication token that the extension must send as its first message.
    let authToken: String
    /// Directory where per-port auth tokens are written for the extension to read.
    static let tokenDirectoryURL: URL = {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config")
            .appendingPathComponent("mcp-safari")
            .appendingPathComponent("tokens")
    }()
    /// Legacy single-token path kept for older extension builds.
    static let legacyTokenFilePath: String = {
        tokenDirectoryURL
            .deletingLastPathComponent()
            .appendingPathComponent("token")
            .path
    }()

    static func tokenFilePath(for port: UInt16) -> String {
        tokenDirectoryURL.appendingPathComponent(String(port)).path
    }

    enum BridgeError: Error, CustomStringConvertible {
        case notConnected
        case timeout
        case encodingFailed
        case decodingFailed(String)
        case extensionError(String)
        case authenticationFailed

        var description: String {
            switch self {
            case .notConnected:
                "No Safari extension connected. Open Safari and click the MCPSafari extension icon to connect."
            case .timeout:
                "Request to Safari extension timed out after 30 seconds."
            case .encodingFailed:
                "Failed to encode bridge request."
            case .decodingFailed(let detail):
                "Failed to decode bridge response: \(detail)"
            case .extensionError(let message):
                "Safari extension error: \(message)"
            case .authenticationFailed:
                "Extension failed to authenticate. Token mismatch."
            }
        }
    }

    var isConnected: Bool { connection != nil }

    private static let maxPortRetries: UInt16 = 10

    private static func makeWebSocketParameters(for port: NWEndpoint.Port) -> NWParameters {
        let params = NWParameters(tls: nil)
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)

        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)
        return params
    }

    init(port: UInt16 = 8089, logger: Logger) throws {
        self.requestedPort = port
        self.port = port
        self.logger = logger

        // Generate a random auth token. It is written after the listener binds so
        // the token filename matches the actual fallback port.
        self.authToken = UUID().uuidString
    }

    private func writeAuthTokenFile(for port: UInt16) throws {
        let fileManager = FileManager.default
        let configDirectory = Self.tokenDirectoryURL.deletingLastPathComponent()

        try fileManager.createDirectory(at: Self.tokenDirectoryURL, withIntermediateDirectories: true)
        try fileManager.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: configDirectory.path
        )
        try fileManager.setAttributes(
            [.posixPermissions: 0o700],
            ofItemAtPath: Self.tokenDirectoryURL.path
        )

        let tokenFilePath = Self.tokenFilePath(for: port)
        try authToken.write(toFile: tokenFilePath, atomically: true, encoding: .utf8)
        try fileManager.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: tokenFilePath
        )

        // Keep the legacy path populated for older extension builds. Current
        // builds prefer the per-port token map and avoid this single-token race.
        try authToken.write(toFile: Self.legacyTokenFilePath, atomically: true, encoding: .utf8)
        try fileManager.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: Self.legacyTokenFilePath
        )
    }

    func start() async {
        // Try the requested port, then successive ports if in use
        let lastPort = min(
            UInt32(UInt16.max),
            UInt32(requestedPort) + UInt32(Self.maxPortRetries) - 1
        )

        for tryPortValue in UInt32(requestedPort)...lastPort {
            let tryPort = UInt16(tryPortValue)
            guard let nwPort = NWEndpoint.Port(rawValue: tryPort) else { continue }

            do {
                let newListener = try NWListener(using: Self.makeWebSocketParameters(for: nwPort), on: nwPort)
                self.listener = newListener
                self.port = tryPort

                let success = await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
                    nonisolated(unsafe) var resumed = false

                    newListener.stateUpdateHandler = { [weak self] state in
                        guard let self else { return }
                        switch state {
                        case .ready:
                            if !resumed {
                                resumed = true
                                cont.resume(returning: true)
                            }
                            Task { await self.handleListenerState(state) }
                        case .failed:
                            if !resumed {
                                resumed = true
                                cont.resume(returning: false)
                            }
                            Task { await self.handleListenerState(state) }
                        default:
                            Task { await self.handleListenerState(state) }
                        }
                    }

                    newListener.newConnectionHandler = { [weak self] newConnection in
                        guard let self else { return }
                        Task { await self.handleNewConnection(newConnection) }
                    }

                    newListener.start(queue: self.networkQueue)
                }

                if success {
                    if tryPort != requestedPort {
                        logger.info("Port \(requestedPort) in use — listening on \(tryPort) instead")
                    }
                    do {
                        try writeAuthTokenFile(for: tryPort)
                    } catch {
                        logger.error("Could not write auth token file for port \(tryPort): \(error)")
                    }
                    logger.info("WebSocket server listening on port \(tryPort)")
                    return
                } else {
                    newListener.cancel()
                    logger.debug("Port \(tryPort) unavailable, trying next")
                }
            } catch {
                logger.debug("Could not create listener on port \(tryPort): \(error)")
            }
        }

        logger.error("Could not bind to any port in range \(requestedPort)-\(lastPort)")
    }

    func stop() {
        listener?.cancel()
        listener = nil
        authenticatingConnection?.cancel()
        authenticatingConnection = nil
        connection?.cancel()
        connection = nil
        drainPendingRequests(error: BridgeError.notConnected)
        logger.info("WebSocket server stopped")
    }

    /// Send a request to the extension and await the correlated response.
    func send(action: String, params: [String: AnyCodable] = [:], timeout: TimeInterval = 30) async throws -> BridgeResponse {
        guard let connection else {
            throw BridgeError.notConnected
        }
        let connectionID = ObjectIdentifier(connection)

        let request = BridgeRequest(action: action, params: params)

        guard let data = try? JSONEncoder().encode(request) else {
            throw BridgeError.encodingFailed
        }

        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "ws", metadata: [metadata])

        // Use withCheckedThrowingContinuation at the actor-isolated level so
        // we can register the pending request BEFORE any message is sent.
        // This prevents the race where a fast response arrives before the
        // continuation is stored.
        return try await withCheckedThrowingContinuation { (responseContinuation: CheckedContinuation<BridgeResponse, any Error>) in
            // Register synchronously within the actor before sending
            self.pendingRequests[request.id] = PendingRequest(
                connectionID: connectionID,
                continuation: responseContinuation
            )

            // Send the WebSocket message
            connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] error in
                if let error {
                    Task {
                        if let self {
                            await self.removePendingAndResume(id: request.id, error: error)
                        }
                    }
                }
            })

            self.logger.debug("Sent bridge request: \(request.action) [\(request.id)]")

            // Timeout task
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                if let self {
                    await self.removePendingAndResume(id: request.id, error: BridgeError.timeout)
                }
            }
        }
    }

    // MARK: - Private

    /// Removes a pending request by ID and resumes its continuation with an error,
    /// but only if the continuation is still present (prevents double-resume).
    private func removePendingAndResume(id: String, error: any Error) {
        if let pending = pendingRequests.removeValue(forKey: id) {
            pending.continuation.resume(throwing: error)
        }
    }

    private func drainPendingRequests(error: any Error) {
        for (_, pending) in pendingRequests {
            pending.continuation.resume(throwing: error)
        }
        pendingRequests.removeAll()
    }

    private func handleListenerState(_ state: NWListener.State) {
        switch state {
        case .failed(let error):
            logger.error("WebSocket server failed: \(error)")
        case .cancelled:
            logger.info("WebSocket server cancelled")
        default:
            break
        }
    }

    private func handleNewConnection(_ newConnection: NWConnection) {
        // Accept the socket, but don't make it active until the token handshake
        // succeeds. This prevents unauthenticated local clients from receiving
        // or spoofing MCP tool traffic.
        if let existing = authenticatingConnection {
            logger.info("Replacing pending unauthenticated extension connection")
            existing.cancel()
        }

        authenticatingConnection = newConnection
        logger.info("Safari extension connected, awaiting authentication")

        newConnection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            Task { await self.handleConnectionState(state, connection: newConnection) }
        }

        newConnection.start(queue: networkQueue)

        // Start receiving messages immediately.
        // If the first message is an auth handshake, handle it inline.
        receiveMessages(from: newConnection)
    }

    private func handleConnectionState(_ state: NWConnection.State, connection conn: NWConnection) {
        switch state {
        case .ready:
            logger.info("Extension connection ready")
        case .failed(let error):
            logger.error("Extension connection failed: \(error)")
            if connection === conn {
                connection = nil
                drainPendingRequests(error: BridgeError.notConnected)
            }
            if authenticatingConnection === conn {
                authenticatingConnection = nil
            }
        case .cancelled:
            logger.info("Extension connection closed")
            if connection === conn {
                connection = nil
                drainPendingRequests(error: BridgeError.notConnected)
            }
            if authenticatingConnection === conn {
                authenticatingConnection = nil
            }
        default:
            break
        }
    }

    private nonisolated func receiveMessages(from conn: NWConnection) {
        conn.receiveMessage { [weak self] content, context, _, error in
            guard let self else { return }

            if let error {
                self.logger.error("WebSocket receive error: \(error)")
                return
            }

            if let data = content, let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata {
                switch metadata.opcode {
                case .text, .binary:
                    Task { await self.handleTextMessage(data, from: conn) }
                case .close:
                    self.logger.info("Extension sent close frame")
                    return
                default:
                    break
                }
            }

            // Continue receiving only if this connection is still current
            Task {
                let isCurrent = await self.isKnownConnection(conn)
                if isCurrent {
                    self.receiveMessages(from: conn)
                }
            }
        }
    }

    private func isKnownConnection(_ conn: NWConnection) -> Bool {
        connection === conn || authenticatingConnection === conn
    }

    private func handleTextMessage(_ data: Data, from conn: NWConnection) {
        // Check for auth handshake message: {"auth":"<token>"}
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let token = json["auth"] as? String {
            if token == authToken {
                authenticate(conn)
            } else {
                logger.warning("Auth token mismatch — closing connection")
                conn.cancel()
                if authenticatingConnection === conn {
                    authenticatingConnection = nil
                }
            }
            return
        }

        guard connection === conn else {
            logger.warning("Closing unauthenticated WebSocket connection that sent non-auth traffic")
            conn.cancel()
            if authenticatingConnection === conn {
                authenticatingConnection = nil
            }
            return
        }

        do {
            let response = try JSONDecoder().decode(BridgeResponse.self, from: data)
            logger.debug("Received bridge response: [\(response.id)] success=\(response.success)")

            if let pending = pendingRequests.removeValue(forKey: response.id) {
                guard pending.connectionID == ObjectIdentifier(conn) else {
                    logger.warning("Received response for request ID on a stale connection: \(response.id)")
                    pending.continuation.resume(throwing: BridgeError.notConnected)
                    return
                }
                pending.continuation.resume(returning: response)
            } else {
                logger.warning("Received response for unknown request ID: \(response.id)")
            }
        } catch {
            logger.error("Failed to decode bridge response: \(error)")
        }
    }

    private func authenticate(_ conn: NWConnection) {
        if let existing = connection, existing !== conn {
            logger.info("Replacing authenticated extension connection")
            existing.cancel()
            drainPendingRequests(error: BridgeError.notConnected)
        }

        connection = conn
        if authenticatingConnection === conn {
            authenticatingConnection = nil
        }

        logger.info("Safari extension authenticated")
        let ack = #"{"auth":"ok"}"#
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "ws-auth", metadata: [metadata])
        conn.send(
            content: ack.data(using: .utf8),
            contentContext: context,
            isComplete: true,
            completion: .contentProcessed { _ in }
        )
    }
}
