import Foundation
import Logging
import MCP

/// Repairs the one incoming shape swift-sdk 0.12.1 cannot decode: an `initialize`
/// request carrying object values under `capabilities.experimental`.
///
/// The SDK types that field `[String: String]`, but the protocol has always allowed
/// arbitrary objects there and clients send them. Codex CLI 0.154.0 sends
/// `{"codex/auth-change": {}}` and ChatGPT sends `{"openai/visibility": {"enabled": true}}`.
/// Decoding fails for the whole request, so a valid `initialize` comes back as
/// `-32603 "The data couldn't be read because it isn't in the correct format."` and
/// the client never connects.
///
/// Each offending value is replaced with its JSON text. That keeps every capability
/// key the client declared, which is the part that carries meaning, while fitting the
/// type the SDK expects. Nothing here reads client experimental capabilities today.
///
/// swift-sdk#276 retypes the field and retires this whole file.
///
/// Kept deliberately narrow. RFC 9413 is pointed about what accepting whatever
/// arrives costs a protocol, and the worst version of it is doing so quietly, so this
/// touches one field of one method and logs every value it rewrites.
actor ClientCapabilityNormalizingTransport: Transport {
    static let experimentalKey = "experimental"

    private let wrapped: any Transport
    nonisolated let logger: Logger

    init(wrapping wrapped: any Transport, logger: Logger) {
        self.wrapped = wrapped
        self.logger = logger
    }

    func connect() async throws { try await wrapped.connect() }

    func disconnect() async { await wrapped.disconnect() }

    func send(_ data: Data) async throws { try await wrapped.send(data) }

    func receive() -> AsyncThrowingStream<Data, Swift.Error> {
        let wrapped = self.wrapped
        let logger = self.logger
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    for try await message in await wrapped.receive() {
                        continuation.yield(Self.normalize(message, logger: logger))
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Returns `message` unchanged unless it is an `initialize` request whose
    /// experimental capabilities would fail to decode. Anything unparseable or
    /// unexpected passes through untouched: the SDK owns what is and is not a valid
    /// request, and this is not the place to start rejecting them.
    static func normalize(_ message: Data, logger: Logger) -> Data {
        // Parsing every frame to reach one field of one method would be wasted work
        // on a transport that mostly carries tool calls.
        guard message.range(of: Data(experimentalKey.utf8)) != nil,
            let parsed = try? JSONSerialization.jsonObject(with: message)
        else { return message }

        let rewritten: Any
        switch parsed {
        case let request as [String: Any]:
            guard let normalized = normalizeRequest(request, logger: logger) else { return message }
            rewritten = normalized
        case let batch as [Any]:
            var changed = false
            let normalized = batch.map { entry -> Any in
                guard let request = entry as? [String: Any],
                    let normalized = normalizeRequest(request, logger: logger)
                else { return entry }
                changed = true
                return normalized
            }
            guard changed else { return message }
            rewritten = normalized
        default:
            return message
        }

        guard let data = try? JSONSerialization.data(withJSONObject: rewritten) else {
            return message
        }
        return data
    }

    /// Returns nil when there is nothing to repair, so the caller can keep the
    /// original bytes rather than round-tripping them through JSONSerialization.
    private static func normalizeRequest(
        _ request: [String: Any],
        logger: Logger
    ) -> [String: Any]? {
        guard request["method"] as? String == Initialize.name,
            var params = request["params"] as? [String: Any],
            var capabilities = params["capabilities"] as? [String: Any],
            let experimental = capabilities[experimentalKey] as? [String: Any]
        else { return nil }

        var repaired: [String: String] = [:]
        var rewrittenKeys: [String] = []
        for (key, value) in experimental {
            if let text = value as? String {
                repaired[key] = text
                continue
            }
            rewrittenKeys.append(key)
            repaired[key] = jsonText(value)
        }
        guard !rewrittenKeys.isEmpty else { return nil }

        logger.notice(
            "Rewrote client experimental capabilities the MCP SDK cannot decode as strings",
            metadata: ["keys": .string(rewrittenKeys.sorted().joined(separator: ", "))]
        )

        capabilities[experimentalKey] = repaired
        params["capabilities"] = capabilities
        var request = request
        request["params"] = params
        return request
    }

    private static func jsonText(_ value: Any) -> String {
        guard
            let data = try? JSONSerialization.data(
                withJSONObject: value,
                options: [.fragmentsAllowed, .sortedKeys]
            ),
            let text = String(data: data, encoding: .utf8)
        else { return "" }
        return text
    }
}
