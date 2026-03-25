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
    private var connection: NWConnection?
    private var pendingRequests: [String: CheckedContinuation<BridgeResponse, any Error>] = [:]
    private let logger: Logger
    private let requestedPort: UInt16
    private(set) var port: UInt16
    private let networkQueue = DispatchQueue(label: "mcp-safari.websocket", qos: .userInitiated)
    private let wsParams: NWParameters

    /// Authentication token that the extension must send as its first message.
    let authToken: String
    /// Path where the auth token is written for the extension to read.
    static let tokenFilePath: String = {
        let dir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config")
            .appendingPathComponent("mcp-safari")
        return dir.appendingPathComponent("token").path
    }()

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

    init(port: UInt16 = 8089, logger: Logger) throws {
        self.requestedPort = port
        self.port = port
        self.logger = logger

        // Generate a random auth token and try to write it to a well-known file.
        self.authToken = UUID().uuidString
        do {
            let tokenDir = URL(fileURLWithPath: Self.tokenFilePath).deletingLastPathComponent()
            try FileManager.default.createDirectory(at: tokenDir, withIntermediateDirectories: true)
            try authToken.write(toFile: Self.tokenFilePath, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o600],
                ofItemAtPath: Self.tokenFilePath
            )
        } catch {
            logger.warning("Could not write auth token file: \(error). Auth will be skipped.")
        }

        let params = NWParameters(tls: nil)
        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)
        self.wsParams = params
    }

    func start() async {
        // Try the requested port, then successive ports if in use
        for offset: UInt16 in 0..<Self.maxPortRetries {
            let tryPort = requestedPort + offset
            guard let nwPort = NWEndpoint.Port(rawValue: tryPort) else { continue }

            do {
                let newListener = try NWListener(using: wsParams, on: nwPort)
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
                    if offset > 0 {
                        logger.info("Port \(requestedPort) in use — listening on \(tryPort) instead")
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

        logger.error("Could not bind to any port in range \(requestedPort)-\(requestedPort + Self.maxPortRetries - 1)")
    }

    func stop() {
        listener?.cancel()
        connection?.cancel()
        connection = nil
        // Fail all pending requests
        for (_, continuation) in pendingRequests {
            continuation.resume(throwing: BridgeError.notConnected)
        }
        pendingRequests.removeAll()
        logger.info("WebSocket server stopped")
    }

    /// Send a request to the extension and await the correlated response.
    func send(action: String, params: [String: AnyCodable] = [:], timeout: TimeInterval = 30) async throws -> BridgeResponse {
        guard let connection else {
            throw BridgeError.notConnected
        }

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
            self.pendingRequests[request.id] = responseContinuation

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
        if let continuation = pendingRequests.removeValue(forKey: id) {
            continuation.resume(throwing: error)
        }
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
        // Accept immediately — replace any existing connection
        if let existing = connection {
            logger.info("Replacing existing extension connection")
            existing.cancel()
        }

        connection = newConnection
        logger.info("Safari extension connected")

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
            }
            // Fail all pending requests
            for (_, continuation) in pendingRequests {
                continuation.resume(throwing: BridgeError.notConnected)
            }
            pendingRequests.removeAll()
        case .cancelled:
            logger.info("Extension connection closed")
            if connection === conn {
                connection = nil
            }
            // Drain pending requests so callers fail immediately instead of
            // waiting for the 30-second timeout.
            for (_, continuation) in pendingRequests {
                continuation.resume(throwing: BridgeError.notConnected)
            }
            pendingRequests.removeAll()
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
                    Task { await self.handleTextMessage(data) }
                case .close:
                    self.logger.info("Extension sent close frame")
                    return
                default:
                    break
                }
            }

            // Continue receiving only if this connection is still current
            Task {
                let isCurrent = await self.isCurrentConnection(conn)
                if isCurrent {
                    self.receiveMessages(from: conn)
                }
            }
        }
    }

    private func isCurrentConnection(_ conn: NWConnection) -> Bool {
        connection === conn
    }

    private func handleTextMessage(_ data: Data) {
        // Check for auth handshake message: {"auth":"<token>"}
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let token = json["auth"] as? String {
            if token == authToken {
                logger.info("Safari extension authenticated")
                // Send auth acknowledgment
                let ack = #"{"auth":"ok"}"#
                let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
                let context = NWConnection.ContentContext(identifier: "ws-auth", metadata: [metadata])
                connection?.send(content: ack.data(using: .utf8), contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
            } else {
                logger.warning("Auth token mismatch — ignoring (connection stays open)")
            }
            return
        }

        do {
            let response = try JSONDecoder().decode(BridgeResponse.self, from: data)
            logger.debug("Received bridge response: [\(response.id)] success=\(response.success)")

            if let continuation = pendingRequests.removeValue(forKey: response.id) {
                continuation.resume(returning: response)
            } else {
                logger.warning("Received response for unknown request ID: \(response.id)")
            }
        } catch {
            logger.error("Failed to decode bridge response: \(error)")
        }
    }
}
