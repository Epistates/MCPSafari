import Foundation
import MCP

// MARK: - Result Formatting

/// How a tool call turns into a `CallTool.Result`, on both the success and
/// the failure path.
///
/// Every result carries its answer twice: prose in `content` for the model to
/// read, and `structuredContent` for anything that has to branch on it. The
/// rules for deciding which payload shape is legal are fiddly and protocol
/// version dependent, so they live together here rather than next to any one
/// handler. None of it reads actor state.
extension SafariMCPServer {
    // Most of this is internal rather than private because the tool handlers in
    // the main file shape their results through it. `isStructured` and
    // `PayloadDecoding` are only used here, so they stay private.
    static func numberValue(_ value: Value?) -> Double? {
        if let double = value?.doubleValue { return double }
        if let int = value?.intValue { return Double(int) }
        return nil
    }

    /// Internal rather than private: the capture and native-input helpers live in
    /// their own files and raise this too.
    struct ToolInputError: Error, CustomStringConvertible {
        let description: String

        init(_ description: String) {
            self.description = description
        }
    }

    /// Returns the same answer twice: prose in `content` for the model to read,
    /// and `structuredContent` for anything that has to branch on it.
    ///
    /// Failures have carried structured detail since tool error codes shipped, so
    /// until now a caller got machine-readable data only when something went
    /// wrong. `key` names the payload because the protocol revision this server
    /// negotiates (2025-11-25, the ceiling in swift-sdk 0.12.1) requires
    /// `structuredContent` to be a JSON object. Bare arrays became legal in
    /// 2026-07-28, which the SDK cannot speak yet.
    ///
    /// Output schemas remain optional until the result contracts stabilize; once
    /// declared, every structured result must conform to its schema.
    func textResult(
        _ response: BridgeResponse,
        as key: String,
        decoding: PayloadDecoding = .containers
    ) -> CallTool.Result {
        guard response.success else {
            return Self.failureResult(response.toolFailure)
        }
        return CallTool.Result(
            content: [Self.textContent(responseText(response))],
            structuredContent: .object([key: Self.structuredPayload(response.data, decoding: decoding)]),
            isError: false
        )
    }

    /// background.js stringifies anything that is not already a string, so a
    /// listing reaches the server as JSON text. Parsing it back means the
    /// structured half is data rather than a string that happens to contain data,
    /// which is the only reason a caller would read it instead of `content`.
    ///
    /// Text that is not JSON stays text. `read_page` with `format: "text"` returns
    /// prose, and prose that happens to start with a digit is not a number.
    enum PayloadDecoding {
        case text       // read_page text/html must remain strings, even "{}" or "[]".
        case json       // javascript_tool explicitly JSON-encodes primitives too.
        case containers // Legacy actions mix JSON objects/arrays with prose.
    }

    static func structuredPayload(_ data: AnyCodable?, decoding: PayloadDecoding = .containers) -> Value {
        guard let data else { return .null }
        guard let text = data.stringValue else {
            return (try? Value(data)) ?? .null
        }
        guard decoding != .text,
              let parsed = try? JSONDecoder().decode(Value.self, from: Data(text.utf8)),
              decoding == .json || Self.isStructured(parsed)
        else { return .string(text) }
        return parsed
    }

    /// Legacy action replies mix JSON containers with confirmation prose. A bare
    /// `true`, `null`, or number decodes fine from ordinary page text and would
    /// silently retype it.
    private static func isStructured(_ value: Value) -> Bool {
        switch value {
        case .object, .array: true
        default: false
        }
    }

    func toolFailure(for error: any Error) -> ToolFailure {
        if let bridgeError = error as? WebSocketBridge.BridgeError {
            return bridgeError.toolFailure
        }
        if let nativeInputError = error as? NativeInputError {
            return nativeInputError.failure
        }
        if let inputError = error as? ToolInputError {
            return ToolFailure(
                code: "invalid_input",
                message: inputError.description,
                retryable: false,
                recoveryAction: "fix_input"
            )
        }
        if let handleError = error as? TabHandleError {
            return ToolFailure(
                code: "invalid_input",
                message: handleError.description,
                retryable: false,
                recoveryAction: "fix_input"
            )
        }
        return ToolFailure(
            code: "internal_error",
            message: "\(error)",
            retryable: false,
            recoveryAction: "inspect_error"
        )
    }

    static func failureResult(
        _ failure: ToolFailure,
        content: [Tool.Content]? = nil,
        details: [String: Value] = [:]
    ) -> CallTool.Result {
        var structuredContent = details
        structuredContent["code"] = .string(failure.code)
        structuredContent["message"] = .string(failure.message)
        structuredContent["retryable"] = .bool(failure.retryable)
        structuredContent["recoveryAction"] = .string(failure.recoveryAction)
        return CallTool.Result(
            content: content ?? [Self.textContent(failure.message)],
            structuredContent: .object(structuredContent),
            isError: true
        )
    }

    static func runStepsDetails(
        results: [Value],
        completedSteps: Int,
        failedStep: Int? = nil
    ) -> [String: Value] {
        [
            "results": .array(results),
            "completedSteps": .int(completedSteps),
            "failedStep": failedStep.map(Value.int) ?? .null,
        ]
    }

    static func toolFailure(from result: CallTool.Result, step: Int, tool: String) -> ToolFailure {
        let details = result.structuredContent?.objectValue
        return ToolFailure(
            code: details?["code"]?.stringValue ?? "step_failed",
            message: details?["message"]?.stringValue ?? "Step \(step) (\(tool)) failed",
            retryable: details?["retryable"]?.boolValue ?? false,
            recoveryAction: details?["recoveryAction"]?.stringValue ?? "inspect_batch_result"
        )
    }

    func responseText(_ response: BridgeResponse) -> String {
        if let data = response.data {
            return "\(data)"
        } else if let error = response.error {
            return error
        } else {
            return response.success ? "OK" : "Failed"
        }
    }
}
