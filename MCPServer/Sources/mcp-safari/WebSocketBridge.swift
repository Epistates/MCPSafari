import Foundation
import Logging
import Network

struct ExtensionMetadata: Codable, Equatable {
    let version: String?
    let protocolVersion: Int?
    /// Which Safari profile's extension instance authenticated. Safari omits the
    /// profile key for the default profile, and extension builds predating profile
    /// support send nothing at all, so both land on `WebSocketBridge.defaultProfileID`.
    let profileID: String

    init(
        version: String?,
        protocolVersion: Int?,
        profileID: String = WebSocketBridge.defaultProfileID
    ) {
        self.version = version
        self.protocolVersion = protocolVersion
        self.profileID = profileID
    }
}

enum HandshakeDecision: Equatable {
    case accept(ExtensionMetadata)
    case rejectToken
    case rejectProtocol(extensionVersion: String?, protocolVersion: Int)
}

enum BridgeHandshake {
    private struct Message: Decodable {
        let auth: String
        let extensionVersion: String?
        let protocolVersion: Int?
        let profileId: String?
    }

    /// Blank or absent means the default profile, which is also what Safari sends
    /// for it and what an extension build without profile support sends for every
    /// profile. Trimmed because it is reflected back in log lines.
    /// Safari sends a `SFExtensionProfileKey` UUID or nothing at all, so this is
    /// generous rather than a UUID check. Both halves earn their place: the id is
    /// logged and reaches the MCP client, where an embedded newline forges log
    /// lines and control characters land in the model's context.
    static let maxProfileIDLength = 64

    static func normalizedProfileID(_ raw: String?) -> String {
        guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty
        else { return WebSocketBridge.defaultProfileID }

        let bounded = String(trimmed.prefix(maxProfileIDLength).filter {
            $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_")
        })
        return bounded.isEmpty ? WebSocketBridge.defaultProfileID : bounded
    }

    static func decision(for data: Data, expectedToken: String) -> HandshakeDecision? {
        guard let message = try? JSONDecoder().decode(Message.self, from: data) else { return nil }
        guard message.auth == expectedToken else { return .rejectToken }
        if let protocolVersion = message.protocolVersion,
           protocolVersion != MCPSafariProduct.bridgeProtocolVersion {
            return .rejectProtocol(
                extensionVersion: message.extensionVersion,
                protocolVersion: protocolVersion
            )
        }
        return .accept(.init(
            version: message.extensionVersion,
            protocolVersion: message.protocolVersion,
            profileID: normalizedProfileID(message.profileId)
        ))
    }
}

/// WebSocket server that bridges MCP tool calls to the Safari extension.
///
/// Listens on a local port for a WebSocket connection from the extension's
/// background.js. Automatically falls back to successive ports if the requested
/// port is in use. Provides a request/response pattern: sends a `BridgeRequest`,
/// awaits a correlated `BridgeResponse` by matching IDs.
actor WebSocketBridge {
    struct Failure: Codable, Equatable {
        let code: String
        let message: String
        let recovery: String

        static func protocolMismatch(extensionProtocolVersion: Int) -> Self {
            .init(
                code: "protocol_version_mismatch",
                message: "Extension bridge protocol \(extensionProtocolVersion) does not match server protocol \(MCPSafariProduct.bridgeProtocolVersion).",
                recovery: "Install matching MCPSafari app and mcp-safari server versions, then restart Safari and the MCP client."
            )
        }
    }

    enum ListenerStatus: String, Codable {
        case stopped
        case binding
        case listening
        case failed
    }

    enum ConnectionStatus: String, Codable {
        case disconnected
        case authenticating
        case authenticated
    }

    /// One connected Safari profile. Safari exposes no profile *name* to either the
    /// extension or the app extension, so `id` is the opaque `SFExtensionProfileKey`
    /// UUID (or `"default"`), and `index` is this server's stable short handle for it.
    struct ProfileStatus: Codable, Equatable {
        let id: String
        let index: Int
        /// The `p<index>` prefix that this profile's tab handles carry.
        let handle: String
        /// Whether a call that names no tab drives this profile.
        let selected: Bool
        let extensionVersion: String?
        let extensionProtocolVersion: Int?
    }

    /// What one profile made of a broadcast. Failures are reported rather than
    /// thrown, because one profile refusing a read is not a reason to withhold
    /// what the others returned.
    struct ProfileOutcome: Sendable {
        /// Answered and unreachable are the only two ways this ends, so they are
        /// the only two it can hold. A `BridgeResponse?` beside a `String?` could
        /// also be both at once, or neither, and every reader had to decide what
        /// those meant.
        enum Reply: Sendable {
            /// The profile replied. The reply can still carry a refusal.
            case answered(BridgeResponse)
            /// Nothing came back: a timeout, a dropped connection, a send that threw.
            case unreachable(String)
        }

        let index: Int
        let profileID: String
        let reply: Reply

        /// How a profile is named in anything a user reads, e.g. `p1 (WORK-UUID)`.
        var label: String { "p\(index) (\(profileID))" }
    }

    struct Status: Codable, Equatable {
        let serverVersion: String
        let protocolVersion: Int
        let requestedPort: UInt16
        let port: UInt16
        let listener: ListenerStatus
        let bridge: ConnectionStatus
        let tokenFileExists: Bool
        let tokenFileSecure: Bool?
        let extensionVersion: String?
        let extensionProtocolVersion: Int?
        let profiles: [ProfileStatus]
        let lastError: Failure?

        enum CodingKeys: String, CodingKey {
            case serverVersion
            case protocolVersion
            case requestedPort
            case port
            case listener
            case bridge
            case tokenFileExists
            case tokenFileSecure
            case extensionVersion
            case extensionProtocolVersion
            case profiles
            case lastError
        }

        func encode(to encoder: any Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(serverVersion, forKey: .serverVersion)
            try container.encode(protocolVersion, forKey: .protocolVersion)
            try container.encode(requestedPort, forKey: .requestedPort)
            try container.encode(port, forKey: .port)
            try container.encode(listener, forKey: .listener)
            try container.encode(bridge, forKey: .bridge)
            try container.encode(tokenFileExists, forKey: .tokenFileExists)
            if let tokenFileSecure {
                try container.encode(tokenFileSecure, forKey: .tokenFileSecure)
            } else {
                try container.encodeNil(forKey: .tokenFileSecure)
            }
            if let extensionVersion {
                try container.encode(extensionVersion, forKey: .extensionVersion)
            } else {
                try container.encodeNil(forKey: .extensionVersion)
            }
            if let extensionProtocolVersion {
                try container.encode(extensionProtocolVersion, forKey: .extensionProtocolVersion)
            } else {
                try container.encodeNil(forKey: .extensionProtocolVersion)
            }
            try container.encode(profiles, forKey: .profiles)
            if let lastError {
                try container.encode(lastError, forKey: .lastError)
            } else {
                try container.encodeNil(forKey: .lastError)
            }
        }
    }

    private var listener: NWListener?
    /// One authenticated connection per Safari profile.
    ///
    /// Safari runs a separate, complete instance of the extension in every profile:
    /// its own background page, its own storage, its own tab ID space. They all read
    /// the same token and dial the same port. Holding a single connection here meant
    /// each instance evicted the last one, whose reconnect then evicted it back, and a
    /// two-profile setup flapped instead of working (#54).
    private var connections: [String: NWConnection] = [:]
    /// Reverse lookup so a connection's own callbacks can find their profile.
    private var profileIDsByConnection: [ObjectIdentifier: String] = [:]
    private var metadataByProfile: [String: ExtensionMetadata] = [:]
    /// Profiles in the order they first authenticated. A profile keeps its index for
    /// this server's lifetime, including across its own reconnects, so the short
    /// handle in `status` does not shuffle under the caller.
    private var profileOrder: [String] = []
    /// Profile pinned by `select_tab`, driving every call that names no tab.
    private var selectedProfileIndex: Int?
    /// Accepted connections that have not completed the token handshake, oldest first.
    /// Kept as a list rather than a single slot for the same reason as `connections`:
    /// a second profile dialing in must not cancel the first one mid-handshake.
    private var authenticatingConnections: [NWConnection] = []
    private struct PendingRequest {
        let connectionID: ObjectIdentifier
        let continuation: CheckedContinuation<BridgeResponse, any Error>
        let timeoutTask: Task<Void, Never>
    }

    private var pendingRequests: [String: PendingRequest] = [:]
    private let logger: Logger
    private let tokenRoots: [URL]
    private let requestedPort: UInt16
    private(set) var port: UInt16
    private var listenerStatus = ListenerStatus.stopped
    private var lastError: Failure?
    /// The build turned away by the most recent protocol mismatch, reported only
    /// while no profile is connected. `doctor` has to be able to name the version
    /// it refused, and with nothing connected there is nothing better to report.
    /// A connected profile's own numbers always win.
    private var rejectedExtension: ExtensionMetadata?
    private let networkQueue = DispatchQueue(label: "mcp-safari.websocket", qos: .userInitiated)

    /// Authentication token that the extension must send as its first message.
    let authToken: String

    /// Stands in for Safari's default profile, which sends no `SFExtensionProfileKey`.
    /// Must match `SafariWebExtensionHandler.defaultProfileID`.
    static let defaultProfileID = "default"

    /// Cap on connections held mid-handshake. Generous for real profile counts, and
    /// bounds what an unauthenticated local process can pin open.
    private static let maxAuthenticatingConnections = 8
    /// How many distinct profile ids this bridge will ever hand a handle to.
    private static let maxProfiles = 32
    /// How long a connection may sit without completing its handshake. Injected
    /// so a test does not have to wait out the real one.
    private let handshakeDeadline: Duration
    static let maxMessageBytes = 32 * 1024 * 1024
    static let maxPendingRequests = 128
    /// Primary token root. The sandboxed extension reads tokens through a
    /// home-relative-path exception that the sandbox evaluates against the
    /// *resolved* path, and `~/.config` is commonly symlinked into a dotfiles
    /// repo — which puts the real file outside the granted path and makes it
    /// unreadable. `~/Library/Application Support` is effectively never
    /// symlinked, so tokens live there.
    ///
    /// Every component below says whether it is a directory. The one-argument
    /// `appendingPathComponent` asks the filesystem instead, and appends a
    /// trailing slash only for a path that already exists, so these constants
    /// would otherwise hold a different value depending on whether anything had
    /// created the directory before the first read. They are compared for
    /// equality in tests, and two URLs differing only by that slash are not
    /// equal.
    static let applicationSupportDirectoryURL: URL = {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent("MCPSafari", isDirectory: true)
    }()

    /// Legacy token root, still written so extension builds that predate the
    /// move keep authenticating.
    static let configDirectoryURL: URL = {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config", isDirectory: true)
            .appendingPathComponent("mcp-safari", isDirectory: true)
    }()

    /// Token roots to populate, most preferred first.
    static let tokenRootURLs: [URL] = [applicationSupportDirectoryURL, configDirectoryURL]

    /// Directory where per-port auth tokens are written for the extension to read.
    static let tokenDirectoryURL: URL = applicationSupportDirectoryURL
        .appendingPathComponent("tokens", isDirectory: true)

    /// Legacy single-token path kept for older extension builds.
    static let legacyTokenFilePath: String = configDirectoryURL
        .appendingPathComponent("token", isDirectory: false)
        .path

    enum BridgeError: Error, CustomStringConvertible {
        case notConnected
        case profileNotConnected(Int)
        case timeout(action: String, seconds: TimeInterval)
        case encodingFailed
        case decodingFailed(String)
        case extensionError(String)
        case authenticationFailed

        var description: String {
            switch self {
            case .notConnected:
                "No Safari extension connected. Open Safari and click the MCPSafari extension icon to connect."
            case .profileNotConnected(let index):
                "Safari profile p\(index) is not connected. Call status to see which profiles are connected, or tabs_context for current tab handles."
            case .timeout(let action, let seconds):
                "Timed out waiting for \(action) after \(seconds) seconds. The operation may already have completed; inspect the browser state before retrying."
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

        var toolFailure: ToolFailure {
            switch self {
            case .notConnected:
                ToolFailure(
                    code: "bridge_disconnected",
                    message: description,
                    retryable: false,
                    recoveryAction: "call_status"
                )
            case .profileNotConnected:
                ToolFailure(
                    code: "profile_not_connected",
                    message: description,
                    retryable: false,
                    recoveryAction: "call_status"
                )
            case .timeout:
                ToolFailure(
                    code: "bridge_timeout",
                    message: description,
                    retryable: false,
                    recoveryAction: "inspect_error"
                )
            case .authenticationFailed:
                ToolFailure(
                    code: "bridge_authentication_failed",
                    message: description,
                    retryable: false,
                    recoveryAction: "call_status"
                )
            case .encodingFailed, .decodingFailed, .extensionError:
                ToolFailure(
                    code: "bridge_error",
                    message: description,
                    retryable: false,
                    recoveryAction: "inspect_error"
                )
            }
        }
    }

    var isConnected: Bool { !connections.isEmpty }

    /// The profile that tool calls target when the caller names none.
    ///
    /// Safari gives an extension no way to ask which profile is frontmost, so this
    /// takes `select_tab`'s pin when that profile is still connected, then prefers
    /// the default profile, then the earliest to connect. The point is that it is
    /// deterministic and that `status` marks the winner, rather than silently
    /// picking a different one between calls.
    private var activeProfileID: String? {
        if let selectedProfileIndex,
           let pinned = profileID(atIndex: selectedProfileIndex),
           connections[pinned] != nil {
            return pinned
        }
        if connections[Self.defaultProfileID] != nil { return Self.defaultProfileID }
        return profileOrder.first { connections[$0] != nil }
    }

    func profileID(atIndex index: Int) -> String? {
        profileOrder.indices.contains(index) ? profileOrder[index] : nil
    }

    /// Pins the profile that untargeted calls drive. `select_tab` sets this from the
    /// handle it was given; it is never cleared, because a disconnected pin falls
    /// through in `activeProfileID` and comes back if that profile reconnects.
    func selectProfile(atIndex index: Int) throws {
        guard let profileID = profileID(atIndex: index), connections[profileID] != nil else {
            throw BridgeError.profileNotConnected(index)
        }
        selectedProfileIndex = index
    }

    func connectedProfiles() -> [ProfileStatus] { profileStatuses() }

    private func profileStatuses() -> [ProfileStatus] {
        let active = activeProfileID
        return profileOrder.enumerated().compactMap { index, profileID in
            guard connections[profileID] != nil else { return nil }
            let metadata = metadataByProfile[profileID]
            return ProfileStatus(
                id: profileID,
                index: index,
                handle: "p\(index)",
                selected: profileID == active,
                extensionVersion: metadata?.version,
                extensionProtocolVersion: metadata?.protocolVersion
            )
        }
    }

    func status() -> Status {
        let tokenFilePath = tokenFile(for: port, under: tokenRoots[0]).path
        // Whichever profile a call with no tab handle would drive, falling back
        // to a rejected build only when nothing is connected to report instead.
        let reported = activeProfileID.flatMap { metadataByProfile[$0] } ?? rejectedExtension
        let fileManager = FileManager.default
        let tokenFileExists = fileManager.fileExists(atPath: tokenFilePath)
        let permissions = (try? fileManager.attributesOfItem(atPath: tokenFilePath)[.posixPermissions] as? NSNumber)?.intValue
        let connectionStatus: ConnectionStatus = !connections.isEmpty
            ? .authenticated
            : authenticatingConnections.isEmpty ? .disconnected : .authenticating

        return Status(
            serverVersion: MCPSafariProduct.version,
            protocolVersion: MCPSafariProduct.bridgeProtocolVersion,
            requestedPort: requestedPort,
            port: port,
            listener: listenerStatus,
            bridge: connectionStatus,
            tokenFileExists: tokenFileExists,
            tokenFileSecure: tokenFileExists ? permissions == 0o600 : nil,
            extensionVersion: reported?.version,
            extensionProtocolVersion: reported?.protocolVersion,
            profiles: profileStatuses(),
            lastError: lastError
        )
    }

    private static let maxPortRetries: UInt16 = 10

    private static func makeWebSocketParameters(for port: NWEndpoint.Port) -> NWParameters {
        let params = NWParameters(tls: nil)
        params.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)

        let wsOptions = NWProtocolWebSocket.Options()
        wsOptions.autoReplyPing = true
        wsOptions.maximumMessageSize = Self.maxMessageBytes
        params.defaultProtocolStack.applicationProtocols.insert(wsOptions, at: 0)
        return params
    }

    init(
        port: UInt16 = 8089,
        logger: Logger,
        tokenRoots: [URL] = WebSocketBridge.tokenRootURLs,
        handshakeDeadline: Duration = .seconds(10)
    ) throws {
        precondition(!tokenRoots.isEmpty)
        self.tokenRoots = tokenRoots
        self.requestedPort = port
        self.port = port
        self.logger = logger
        self.handshakeDeadline = handshakeDeadline

        // Generate a random auth token. It is written after the listener binds so
        // the token filename matches the actual fallback port.
        self.authToken = UUID().uuidString
    }

    private func writeAuthTokenFile(for port: UInt16) throws {
        // The preferred root must succeed; the legacy root is best effort so a
        // broken or unwritable `~/.config` cannot stop the server from starting.
        try writeToken(for: port, under: tokenRoots[0])
        for root in tokenRoots.dropFirst() {
            do { try writeToken(for: port, under: root) }
            catch { logger.debug("Could not write legacy token under \(root.path): \(error)") }
        }
    }

    /// The per-port token file under one root.
    ///
    /// Every component says whether it is a directory. The one-argument
    /// `appendingPathComponent` asks the filesystem instead and appends a
    /// trailing slash only for a path that already exists, so the same
    /// expression produced different values depending on whether the server had
    /// ever run. That was a real CI flake once; two callers still had that form.
    private func tokenFile(for port: UInt16, under root: URL) -> URL {
        root.appendingPathComponent("tokens", isDirectory: true)
            .appendingPathComponent(String(port), isDirectory: false)
    }

    private func writeToken(for port: UInt16, under root: URL) throws {
        let fileManager = FileManager.default
        let tokenDirectory = root.appendingPathComponent("tokens", isDirectory: true)

        try fileManager.createDirectory(at: tokenDirectory, withIntermediateDirectories: true)
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: tokenDirectory.path)

        let tokenFilePath = tokenFile(for: port, under: root).path
        try authToken.write(toFile: tokenFilePath, atomically: true, encoding: .utf8)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenFilePath)

        // Keep the single-token path populated for older extension builds.
        // Current builds prefer the per-port map and avoid its rewrite race.
        let singleTokenPath = root.appendingPathComponent("token", isDirectory: false).path
        try authToken.write(toFile: singleTokenPath, atomically: true, encoding: .utf8)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: singleTokenPath)
    }

    func start() async {
        guard listener == nil else { return }
        lastError = nil
        listenerStatus = .binding
        // Try the requested port, then successive ports if in use
        let lastPort = min(
            UInt32(UInt16.max),
            UInt32(requestedPort) + UInt32(Self.maxPortRetries) - 1
        )

        for tryPortValue in UInt32(requestedPort)...lastPort {
            let tryPort = UInt16(tryPortValue)
            guard let nwPort = NWEndpoint.Port(rawValue: tryPort) else { continue }

            do {
                let newListener = try NWListener(using: Self.makeWebSocketParameters(for: nwPort))
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
                            Task { await self.handleListenerState(state, listener: newListener) }
                        // `.cancelled` is terminal too, and a concurrent `stop()`
                        // can produce it while this continuation is still
                        // suspended. Without it here, `start()` never returns and
                        // takes the whole MCP server down with it, since
                        // `withCheckedContinuation` cannot be cancelled either.
                        case .failed, .cancelled:
                            if !resumed {
                                resumed = true
                                cont.resume(returning: false)
                            }
                            Task { await self.handleListenerState(state, listener: newListener) }
                        default:
                            Task { await self.handleListenerState(state, listener: newListener) }
                        }
                    }

                    newListener.newConnectionHandler = { [weak self] newConnection in
                        guard let self else { return }
                        Task { await self.handleNewConnection(newConnection) }
                    }

                    newListener.start(queue: self.networkQueue)
                }

                if success {
                    guard let boundPort = newListener.port?.rawValue else {
                        discard(listener: newListener)
                        continue
                    }
                    self.port = boundPort
                    if requestedPort != 0 && boundPort != requestedPort {
                        logger.info("Port \(requestedPort) in use — listening on \(boundPort) instead")
                    }
                    do {
                        try writeAuthTokenFile(for: boundPort)
                    } catch {
                        stop()
                        listenerStatus = .failed
                        lastError = Failure(
                            code: "token_write_failed",
                            message: "Could not publish the authentication token for port \(boundPort).",
                            recovery: "Check permissions for \(tokenRoots[0].path), then restart the MCP client."
                        )
                        logger.error("Could not write auth token file for port \(boundPort): \(error)")
                        return
                    }
                    listenerStatus = .listening
                    logger.info("WebSocket server listening on port \(boundPort)")
                    return
                } else {
                    discard(listener: newListener)
                    logger.debug("Port \(tryPort) unavailable, trying next")
                }
            } catch {
                logger.debug("Could not create listener on port \(tryPort): \(error)")
            }
        }

        listenerStatus = .failed
        lastError = Failure(
            code: "bridge_bind_failed",
            message: "No free port in \(requestedPort)-\(lastPort) for the extension bridge.",
            recovery: "Quit whatever is holding those ports, or start the server with --port on a free one."
        )
        logger.error("Could not bind to any port in range \(requestedPort)-\(lastPort)")
    }

    /// Releases a listener this bridge is finished with.
    ///
    /// Both halves matter. `stateUpdateHandler` captures the listener and is
    /// stored on it, so the two keep each other alive until the handler is
    /// cleared. And `self.listener` has to go back to nil, because `start()`
    /// returns early while it is set: a cancelled listener left in place turns
    /// every later `start()` into a silent no-op with nothing listening.
    private func discard(listener candidate: NWListener) {
        candidate.stateUpdateHandler = nil
        candidate.newConnectionHandler = nil
        candidate.cancel()
        if listener === candidate { listener = nil }
    }

    func stop() {
        // Remove only owned per-port tokens while this listener still owns its port.
        // The shared legacy `token` is deliberately left alone: another process
        // can replace it between an ownership check and unlink.
        for root in tokenRoots {
            let url = tokenFile(for: port, under: root)
            if (try? String(contentsOf: url, encoding: .utf8)) == authToken {
                try? FileManager.default.removeItem(at: url)
            }
        }
        if let listener { discard(listener: listener) }
        for pending in authenticatingConnections {
            pending.stateUpdateHandler = nil
            pending.cancel()
        }
        authenticatingConnections.removeAll()
        for connection in connections.values {
            connection.stateUpdateHandler = nil
            connection.cancel()
        }
        connections.removeAll()
        profileIDsByConnection.removeAll()
        metadataByProfile.removeAll()
        profileOrder.removeAll()
        selectedProfileIndex = nil
        listenerStatus = .stopped
        rejectedExtension = nil
        drainPendingRequests(error: BridgeError.notConnected)
        logger.info("WebSocket server stopped")
    }

    /// Send a request to one profile's extension instance and await the correlated
    /// response. `profileIndex` nil drives `activeProfileID`.
    func send(
        action: String,
        params: [String: AnyCodable] = [:],
        timeout: TimeInterval = 30,
        profileIndex: Int? = nil
    ) async throws -> BridgeResponse {
        guard pendingRequests.count < Self.maxPendingRequests else {
            throw BridgeError.extensionError("Too many in-flight requests (maximum \(Self.maxPendingRequests)). Wait for pending operations to finish.")
        }
        let connection = try connection(forProfileIndex: profileIndex)
        let connectionID = ObjectIdentifier(connection)

        let request = BridgeRequest(action: action, params: params)

        guard let data = try? JSONEncoder().encode(request) else {
            throw BridgeError.encodingFailed
        }

        guard data.count <= Self.maxMessageBytes else {
            throw BridgeError.encodingFailed
        }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "ws", metadata: [metadata])

        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            // Registration and sending are synchronous on the actor. Cancellation
            // queues its removal on this same actor, so it cannot miss registration.
            return try await withCheckedThrowingContinuation { responseContinuation in
                let timeoutTask = Task { [weak self] in
                    do {
                        try await Task.sleep(for: .seconds(timeout))
                    } catch { return }
                    await self?.removePendingAndResume(
                        id: request.id,
                        error: BridgeError.timeout(action: action, seconds: timeout)
                    )
                }
                self.pendingRequests[request.id] = PendingRequest(
                    connectionID: connectionID,
                    continuation: responseContinuation,
                    timeoutTask: timeoutTask
                )

                connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { [weak self] error in
                    if let error {
                        Task { await self?.removePendingAndResume(id: request.id, error: error) }
                    }
                })
                self.logger.debug("Sent bridge request: \(request.action) [\(request.id)]")
            }
        } onCancel: {
            // Stops waiting; it cannot retract browser work already sent over the
            // wire. Never report cancellation as evidence that a mutation did not run.
            Task { await self.removePendingAndResume(id: request.id, error: CancellationError()) }
        }
    }

    /// Sends the same request to every connected profile at once and reports what
    /// each one made of it. Used by `tabs_context`, which has to see the whole
    /// browser rather than one profile's slice of it.
    func broadcast(
        action: String,
        params: [String: AnyCodable] = [:],
        timeout: TimeInterval = 30
    ) async throws -> [ProfileOutcome] {
        let targets = profileStatuses().map { (index: $0.index, id: $0.id) }
        guard !targets.isEmpty else { throw BridgeError.notConnected }

        let outcomes = await withTaskGroup(of: ProfileOutcome.self) { group in
            for target in targets {
                group.addTask {
                    do {
                        let response = try await self.send(
                            action: action,
                            params: params,
                            timeout: timeout,
                            profileIndex: target.index
                        )
                        return ProfileOutcome(
                            index: target.index, profileID: target.id,
                            reply: .answered(response)
                        )
                    } catch {
                        return ProfileOutcome(
                            index: target.index, profileID: target.id,
                            reply: .unreachable("\(error)")
                        )
                    }
                }
            }

            var outcomes: [ProfileOutcome] = []
            for await outcome in group { outcomes.append(outcome) }
            return outcomes.sorted { $0.index < $1.index }
        }

        // Cancelling is not a browser failure. Each child turns its own error
        // into `.unreachable`, including the CancellationError it gets when the
        // caller walks away, so without this a cancelled `tabs_context` reports
        // that no profile answered and blames Safari for it.
        try Task.checkCancellation()
        return outcomes
    }

    // MARK: - Private

    /// The connection a request should go out on. A named profile that is not
    /// connected is an error rather than a silent fallback: the caller asked for a
    /// specific browser window, and answering from a different one would be worse
    /// than refusing.
    private func connection(forProfileIndex index: Int?) throws -> NWConnection {
        guard let index else {
            guard let profileID = activeProfileID, let connection = connections[profileID] else {
                throw BridgeError.notConnected
            }
            return connection
        }
        guard let profileID = profileID(atIndex: index), let connection = connections[profileID] else {
            throw BridgeError.profileNotConnected(index)
        }
        return connection
    }

    /// Removes a pending request by ID and resumes its continuation with an error,
    /// but only if the continuation is still present (prevents double-resume).
    private func removePendingAndResume(id: String, error: any Error) {
        if let pending = pendingRequests.removeValue(forKey: id) {
            pending.timeoutTask.cancel()
            pending.continuation.resume(throwing: error)
        }
    }

    private func drainPendingRequests(error: any Error) {
        for (_, pending) in pendingRequests {
            pending.timeoutTask.cancel()
            pending.continuation.resume(throwing: error)
        }
        pendingRequests.removeAll()
    }

    /// Fails only the work that was in flight on one connection. One profile going
    /// away must not fail another profile's requests, which is what a blanket drain
    /// would do now that several are held at once.
    private func drainPendingRequests(for conn: NWConnection, error: any Error) {
        let connectionID = ObjectIdentifier(conn)
        for (id, pending) in pendingRequests where pending.connectionID == connectionID {
            pendingRequests.removeValue(forKey: id)
            pending.timeoutTask.cancel()
            pending.continuation.resume(throwing: error)
        }
    }

    /// Closes a connection that never finished its handshake, so a socket that
    /// opens and then says nothing cannot sit in one of the few slots forever.
    private func dropIfStillAuthenticating(_ conn: NWConnection) {
        guard authenticatingConnections.contains(where: { $0 === conn }) else { return }
        logger.warning("Closing a connection that did not authenticate in time")
        removeAuthenticating(conn)
        conn.stateUpdateHandler = nil
        conn.cancel()
    }

    private func removeAuthenticating(_ conn: NWConnection) {
        authenticatingConnections.removeAll { $0 === conn }
    }

    private func handleListenerState(_ state: NWListener.State, listener source: NWListener) {
        guard listener === source else { return }
        switch state {
        case .failed(let error):
            listenerStatus = .failed
            logger.error("WebSocket server failed: \(error)")
        case .cancelled:
            logger.info("WebSocket server cancelled")
        default:
            break
        }
    }

    private func handleNewConnection(_ newConnection: NWConnection) {
        guard listenerStatus == .listening else {
            newConnection.cancel()
            return
        }
        // Accept the socket, but don't make it active until the token handshake
        // succeeds. This prevents unauthenticated local clients from receiving
        // or spoofing MCP tool traffic.
        // Refuse the newest rather than evicting the oldest. Evicting took out
        // whichever connection was furthest along, which is the one most likely
        // to be the extension mid-handshake, so anything opening sockets in a
        // loop could keep Safari from ever authenticating. That is the invariant
        // stated above `authenticatingConnections`.
        if authenticatingConnections.count >= Self.maxAuthenticatingConnections {
            logger.warning("Refusing a connection: \(Self.maxAuthenticatingConnections) others are still mid-handshake")
            newConnection.cancel()
            return
        }

        authenticatingConnections.append(newConnection)
        logger.info("Safari extension connected, awaiting authentication")

        // The other half of refusing the newest: without a deadline a handful of
        // sockets that simply never speak would hold every slot forever, and the
        // refusal above would then fall on the real extension.
        let deadline = handshakeDeadline
        Task { [weak self] in
            try? await Task.sleep(for: deadline)
            await self?.dropIfStillAuthenticating(newConnection)
        }

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
            forget(conn)
        case .cancelled:
            logger.info("Extension connection closed")
            forget(conn)
        default:
            break
        }
    }

    /// Drops every trace of one connection. Safe to call for a connection that was
    /// never authenticated, and for one already superseded by a reconnect from the
    /// same profile: the identity check keeps a late `.cancelled` from the old socket
    /// from evicting the new one.
    private func forget(_ conn: NWConnection) {
        // Same cycle as a listener: `stateUpdateHandler` captures `conn` and is
        // stored on `conn`, so without this the connection and its receive
        // buffers outlive every reference dropped below, once per reconnect for
        // the life of the process.
        conn.stateUpdateHandler = nil
        removeAuthenticating(conn)

        guard let profileID = profileIDsByConnection.removeValue(forKey: ObjectIdentifier(conn))
        else { return }

        if connections[profileID] === conn {
            connections.removeValue(forKey: profileID)
            metadataByProfile.removeValue(forKey: profileID)
            logger.info("Safari extension disconnected (profile \(profileID))")
        }

        drainPendingRequests(for: conn, error: BridgeError.notConnected)
    }

    private nonisolated func receiveMessages(from conn: NWConnection) {
        conn.receiveMessage { [weak self] content, context, _, error in
            guard let self else { return }

            if let error {
                self.logger.error("WebSocket receive error: \(error)")
                // The read loop ends here and is not re-armed below, so without
                // dropping the registry entry the profile keeps reporting as
                // connected and every later send to it waits out the full
                // timeout against a socket nobody is reading.
                Task { await self.forget(conn) }
                return
            }

            let opcode = (context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
                as? NWProtocolWebSocket.Metadata)?.opcode

            if opcode == .close {
                self.logger.info("Extension sent close frame")
                // The peer asked to close, so tear down here rather than
                // waiting for a state transition a half-closed socket may
                // never send. The read loop is not re-armed below either.
                Task { await self.forget(conn) }
                conn.cancel()
                return
            }

            // One task handles this frame and only then arms the next read.
            // Handling and re-arming used to be two tasks, and Swift orders
            // unstructured tasks however it likes, so a handshake could be
            // processed after the frame that followed it and get its own
            // connection closed as unauthenticated traffic.
            Task {
                if let data = content, opcode == .text || opcode == .binary {
                    await self.handleTextMessage(data, from: conn)
                }
                if await self.isKnownConnection(conn) {
                    self.receiveMessages(from: conn)
                }
            }
        }
    }

    private func isKnownConnection(_ conn: NWConnection) -> Bool {
        profileIDsByConnection[ObjectIdentifier(conn)] != nil
            || authenticatingConnections.contains { $0 === conn }
    }

    private func handleTextMessage(_ data: Data, from conn: NWConnection) {
        // A handshake only means anything before this connection has one. Taking
        // a second one re-registered the same socket under a new profile id and
        // left the first `connections` entry pointing at it forever, so
        // `isConnected` stayed true for a profile that was gone. It also let a
        // later handshake overwrite `lastError` through `handshakeDecision`.
        let authenticated = profileIDsByConnection[ObjectIdentifier(conn)] != nil
        if !authenticated, let decision = handshakeDecision(for: data) {
            switch decision {
            case .accept(let metadata):
                authenticate(conn, metadata: metadata)
            case .rejectToken:
                logger.warning("Auth token mismatch — closing connection")
                conn.cancel()
                removeAuthenticating(conn)
            case .rejectProtocol(_, let received):
                logger.warning("Bridge protocol mismatch: extension=\(received), server=\(MCPSafariProduct.bridgeProtocolVersion)")
                // Free the slot now. `closeAfterSending` only cancels from the
                // send completion, which never arrives if the peer vanishes
                // first, and there are only a few slots to go round.
                removeAuthenticating(conn)
                sendAuthResponse([
                    "auth": "error",
                    "error": "protocol_version_mismatch",
                    "extensionProtocolVersion": received,
                    "serverProtocolVersion": MCPSafariProduct.bridgeProtocolVersion,
                ], to: conn, closeAfterSending: true)
            }
            return
        }

        guard authenticated else {
            logger.warning("Closing unauthenticated WebSocket connection that sent non-auth traffic")
            conn.cancel()
            removeAuthenticating(conn)
            return
        }

        do {
            let response = try JSONDecoder().decode(BridgeResponse.self, from: data)
            logger.debug("Received bridge response: [\(response.id)] success=\(response.success)")

            if let pending = pendingRequests[response.id] {
                guard pending.connectionID == ObjectIdentifier(conn) else {
                    logger.warning("Received response for request ID on a stale connection: \(response.id)")
                    return
                }
                pendingRequests.removeValue(forKey: response.id)
                pending.timeoutTask.cancel()
                pending.continuation.resume(returning: response)
            } else {
                logger.warning("Received response for unknown request ID: \(response.id)")
            }
        } catch {
            logger.error("Failed to decode bridge response: \(error)")
        }
    }

    func handshakeDecision(for data: Data) -> HandshakeDecision? {
        let decision = BridgeHandshake.decision(for: data, expectedToken: authToken)
        // Held separately from any connected profile's metadata. This used to
        // overwrite the shared version fields, so an old build rejected in a
        // second profile relabelled a healthy first one with its version.
        if case .rejectProtocol(let rejectedVersion, let protocolVersion) = decision {
            rejectedExtension = ExtensionMetadata(version: rejectedVersion, protocolVersion: protocolVersion)
            lastError = .protocolMismatch(extensionProtocolVersion: protocolVersion)
        }
        return decision
    }

    private func authenticate(_ conn: NWConnection, metadata: ExtensionMetadata) {
        let profileID = metadata.profileID

        // Replace only this profile's own connection, which is a genuine reconnect.
        // Evicting across profiles is what made two of them flap against each other.
        if let existing = connections[profileID], existing !== conn {
            logger.info("Replacing authenticated extension connection (profile \(profileID))")
            profileIDsByConnection.removeValue(forKey: ObjectIdentifier(existing))
            existing.cancel()
            drainPendingRequests(for: existing, error: BridgeError.notConnected)
        }

        connections[profileID] = conn
        profileIDsByConnection[ObjectIdentifier(conn)] = profileID
        metadataByProfile[profileID] = metadata
        if !profileOrder.contains(profileID) {
            // Bounded rather than pruned. The index into this array *is* the
            // `p0` handle that every tab handle carries, so dropping a
            // disconnected entry would renumber the live ones and quietly point
            // `p1t5` at a different profile. Capping keeps handles stable while
            // still refusing to grow forever for a client that reconnects under
            // a fresh id each time. Safari has nothing like this many profiles.
            guard profileOrder.count < Self.maxProfiles else {
                logger.warning("Refusing profile \(profileID): already tracking \(Self.maxProfiles)")
                connections.removeValue(forKey: profileID)
                profileIDsByConnection.removeValue(forKey: ObjectIdentifier(conn))
                metadataByProfile.removeValue(forKey: profileID)
                removeAuthenticating(conn)
                conn.stateUpdateHandler = nil
                conn.cancel()
                return
            }
            profileOrder.append(profileID)
        }

        // Something works now, so a refusal recorded earlier is stale.
        lastError = nil
        rejectedExtension = nil
        removeAuthenticating(conn)

        logger.info("Safari extension authenticated (profile \(profileID))")
        sendAuthResponse([
            "auth": "ok",
            "serverVersion": MCPSafariProduct.version,
            "protocolVersion": MCPSafariProduct.bridgeProtocolVersion,
            "profile": profileID,
        ], to: conn)
    }

    private func sendAuthResponse(
        _ response: [String: Any],
        to conn: NWConnection,
        closeAfterSending: Bool = false
    ) {
        guard let data = try? JSONSerialization.data(withJSONObject: response) else { return }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "ws-auth", metadata: [metadata])
        conn.send(
            content: data,
            contentContext: context,
            isComplete: true,
            completion: .contentProcessed { _ in
                if closeAfterSending { conn.cancel() }
            }
        )
    }
}
