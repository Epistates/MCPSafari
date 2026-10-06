import Foundation
import MCP

// MARK: - run_steps Input

/// One validated step in a `run_steps` batch.
struct RunStep: Equatable, Sendable {
    let tool: String
    let arguments: [String: Value]
}

/// Validates a whole `run_steps` batch before any of it runs.
///
/// Everything here is checked up front deliberately: a batch that fails halfway
/// has already acted on the page, and those actions cannot be taken back. So a
/// bad tool name, a reserved key, or an unparseable tab handle in step 7 has to
/// be a refusal before step 1 is sent.
struct RunStepsPlan: Equatable, Sendable {
    static let allowedTools: Set<String> = [
        "navigate", "click", "type_text", "form_input", "select_option",
        "press_key", "hover", "scroll", "drag", "wait",
        "upload_file", "drop_file",
    ]
    static let maxSteps = 10
    static let maxTimeout = 60.0

    let steps: [RunStep]
    let timeout: Double

    init(arguments: [String: Value]) throws {
        guard arguments["_batchDeadline"] == nil else {
            throw RunStepsInputError("_batchDeadline is reserved for internal use")
        }
        guard let values = arguments["steps"]?.arrayValue, !values.isEmpty else {
            throw RunStepsInputError("steps must contain at least one step")
        }
        guard values.count <= Self.maxSteps else {
            throw RunStepsInputError("steps cannot contain more than \(Self.maxSteps) steps")
        }

        let batchTabId = arguments["tabId"]
        _ = try Self.tabHandle(batchTabId)

        steps = try values.enumerated().map { index, value in
            guard let object = value.objectValue else {
                throw RunStepsInputError("steps[\(index)] must be an object")
            }
            guard let tool = object["tool"]?.stringValue, !tool.isEmpty else {
                throw RunStepsInputError("steps[\(index)].tool must be a non-empty string")
            }
            guard Self.allowedTools.contains(tool) else {
                throw RunStepsInputError("steps[\(index)].tool does not support \(tool)")
            }

            let suppliedArguments = object["arguments"]
            if let suppliedArguments, suppliedArguments.objectValue == nil {
                throw RunStepsInputError("steps[\(index)].arguments must be an object")
            }
            var stepArguments = suppliedArguments?.objectValue ?? [:]
            guard stepArguments["_batchDeadline"] == nil else {
                throw RunStepsInputError("steps[\(index)].arguments._batchDeadline is reserved for internal use")
            }
            for key in ["trace", "traceDuration", "eventTypes", "includeSnapshot"] where stepArguments[key] != nil {
                throw RunStepsInputError("steps[\(index)].arguments.\(key) must be set on run_steps instead")
            }
            do {
                _ = try Self.tabHandle(stepArguments["tabId"])
            } catch let error as RunStepsInputError {
                throw RunStepsInputError("steps[\(index)].arguments.\(error.description)")
            }
            if stepArguments["tabId"] == nil, let batchTabId {
                stepArguments["tabId"] = batchTabId
            }
            return RunStep(tool: tool, arguments: stepArguments)
        }

        if let timeoutValue = arguments["timeout"], SafariMCPServer.numberValue(timeoutValue) == nil {
            throw RunStepsInputError("timeout must be a number")
        }
        timeout = max(0.1, min(SafariMCPServer.numberValue(arguments["timeout"]) ?? 60, Self.maxTimeout))
    }

    /// Rejects a bad tab handle up front, so a batch fails on its arguments rather
    /// than partway through after some steps have already run.
    private static func tabHandle(_ value: Value?) throws -> TabHandle? {
        do {
            return try TabHandle.resolve(value)
        } catch let error as TabHandleError {
            throw RunStepsInputError(error.description)
        }
    }
}

struct RunStepsInputError: Error, CustomStringConvertible, Equatable {
    let description: String

    init(_ description: String) {
        self.description = description
    }
}
