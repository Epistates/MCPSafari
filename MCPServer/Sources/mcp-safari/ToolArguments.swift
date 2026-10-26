import Foundation
import MCP

// MARK: - Tool Arguments

/// Reading optional arguments without losing a wrong one.
///
/// `args["x"]?.stringValue` cannot tell a missing key from one of the wrong
/// type: both are nil. So `select_tab {bringToFront: "false"}` brought the tab
/// to the front, `read_console {pattern: 5, clear: true}` cleared everything
/// without filtering, and `read_network {status: "500"}` returned unfiltered
/// data, which the docs promise a rejected filter never does. These return nil
/// only when the key is absent (or an explicit null) and throw when it is there
/// with the wrong type, so a typo is reported before anything acts on it.
extension SafariMCPServer {
    nonisolated static func optionalString(_ key: String, in args: [String: Value]) throws -> String? {
        guard let value = present(key, in: args) else { return nil }
        guard let string = value.stringValue else { throw ToolInputError("\(key) must be a string") }
        return string
    }

    nonisolated static func optionalBool(_ key: String, in args: [String: Value]) throws -> Bool? {
        guard let value = present(key, in: args) else { return nil }
        guard let bool = value.boolValue else { throw ToolInputError("\(key) must be a boolean") }
        return bool
    }

    /// Accepts a whole-valued double such as `800.0`, which is how some clients
    /// serialize every number, and rejects `800.5` rather than rounding it.
    nonisolated static func optionalInt(_ key: String, in args: [String: Value]) throws -> Int? {
        guard let value = present(key, in: args) else { return nil }
        if let int = value.intValue { return int }
        if let double = value.doubleValue, double.isFinite, double == double.rounded(),
           let int = Int(exactly: double) {
            return int
        }
        throw ToolInputError("\(key) must be an integer")
    }

    nonisolated static func optionalNumber(_ key: String, in args: [String: Value]) throws -> Double? {
        guard let value = present(key, in: args) else { return nil }
        guard let number = numberValue(value), number.isFinite else { throw ToolInputError("\(key) must be a number") }
        return number
    }

    /// A positive integer, for the counts and caps that are meaningless at zero.
    /// A value above `maximum` is brought down to it rather than refused: the
    /// caller asked for "as much as you will give", and the documented ceiling
    /// is what that means.
    nonisolated static func optionalPositiveInt(
        _ key: String,
        in args: [String: Value],
        maximum: Int = .max
    ) throws -> Int? {
        guard let int = try optionalInt(key, in: args) else { return nil }
        guard int > 0 else { throw ToolInputError("Invalid \(key): \(int). Use a positive integer.") }
        return min(int, maximum)
    }

    private nonisolated static func present(_ key: String, in args: [String: Value]) -> Value? {
        guard let value = args[key], value != .null else { return nil }
        return value
    }
}
