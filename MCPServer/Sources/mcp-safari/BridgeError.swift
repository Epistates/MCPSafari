import Foundation

// MARK: - Bridge Errors

/// Every way a bridge call can fail, and the message each one reports.
///
/// These strings reach the MCP client, so they say what happened and what to
/// do about it rather than naming the internal state that produced them.
extension WebSocketBridge {
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
}
