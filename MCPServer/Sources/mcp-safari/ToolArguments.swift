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

    // MARK: Declared arguments

    /// What a tool's schema says it takes. The schema the server advertises is the
    /// one its calls are held to: a caller who reads `tools/list` and follows it
    /// is accepted, and one who adds an argument it does not list, or gives one
    /// the wrong type, is told which and nothing is sent.
    private struct DeclaredArguments: Sendable {
        let properties: [String: Value]
        let required: [String]
    }

    private nonisolated static let declaredArguments: [String: DeclaredArguments] = {
        var declared: [String: DeclaredArguments] = [:]
        for tool in toolDefinitions {
            let schema = tool.inputSchema.objectValue
            declared[tool.name] = DeclaredArguments(
                properties: schema?["properties"]?.objectValue ?? [:],
                required: (schema?["required"]?.arrayValue ?? []).compactMap(\.stringValue)
            )
        }
        return declared
    }()

    /// Whether `tool` is one the server advertises.
    nonisolated static func declaresTool(_ tool: String) -> Bool {
        declaredArguments[tool] != nil
    }

    /// Whether `tool` takes `argument`, by its schema.
    nonisolated static func declaresArgument(_ argument: String, for tool: String) -> Bool {
        declaredArguments[tool]?.properties[argument] != nil
    }

    /// Refuses an argument the tool does not declare, a declared one of the wrong
    /// type or outside its enum, and a required one that is missing. Typos such
    /// as `waitForSelctor` used to be ignored, and `click {native: true}` ran a
    /// synthetic click, so the call did something other than what was asked.
    ///
    /// Runs after the tool's own validators, which know more and say so. What
    /// reaches this is whatever they leave unchecked, so every declared argument
    /// is covered by one or the other, and a wrong type never reaches the
    /// extension, where `"false"` is truthy.
    nonisolated static func validateAgainstSchema(tool: String, arguments args: [String: Value]) throws {
        guard let declared = declaredArguments[tool] else { return }

        let unknown = args.keys.filter { declared.properties[$0] == nil }.sorted()
        if !unknown.isEmpty {
            let names = unknown.map { "\"\($0)\"" }.joined(separator: ", ")
            let allowed = declared.properties.keys.sorted().joined(separator: ", ")
            throw ToolInputError(
                "\(tool) does not take \(unknown.count == 1 ? "the argument" : "the arguments") \(names). "
                + (allowed.isEmpty ? "It takes no arguments." : "Its arguments are: \(allowed).")
            )
        }

        for key in declared.required where args[key] == nil || args[key] == .null {
            throw ToolInputError("\(key) is required")
        }

        for (key, value) in args.sorted(by: { $0.key < $1.key }) where value != .null {
            guard let schema = declared.properties[key]?.objectValue else { continue }
            guard schemaAccepts(value, schema) else {
                throw ToolInputError("\(key) must be \(schemaDescription(schema))")
            }
            if let allowed = schema["enum"]?.arrayValue?.compactMap(\.stringValue),
               let string = value.stringValue, !allowed.contains(string) {
                throw ToolInputError("Invalid \(key): \(string). Use \(allowed.joined(separator: ", ")).")
            }
        }
    }

    /// Whether `value` has the JSON type the schema names. Types the server
    /// reads strictly match here as they do in the `optional...` readers above:
    /// an integer may arrive as a whole-valued double, and a number must be finite.
    private nonisolated static func schemaAccepts(_ value: Value, _ schema: [String: Value]) -> Bool {
        schemaTypes(schema).contains { type in
            switch type {
            case "string": return value.stringValue != nil
            case "boolean": return value.boolValue != nil
            case "integer":
                if value.intValue != nil { return true }
                if let double = value.doubleValue, double.isFinite, double == double.rounded() { return true }
                return false
            case "number": return numberValue(value)?.isFinite == true
            case "array":
                guard let items = value.arrayValue else { return false }
                guard let itemSchema = schema["items"]?.objectValue else { return true }
                return items.allSatisfy { schemaAccepts($0, itemSchema) }
            case "object":
                guard let object = value.objectValue else { return false }
                guard let valueSchema = schema["additionalProperties"]?.objectValue else { return true }
                return object.values.allSatisfy { schemaAccepts($0, valueSchema) }
            default: return true
            }
        }
    }

    private nonisolated static func schemaTypes(_ schema: [String: Value]) -> [String] {
        if let type = schema["type"]?.stringValue { return [type] }
        return (schema["type"]?.arrayValue ?? []).compactMap(\.stringValue)
    }

    private nonisolated static func schemaDescription(_ schema: [String: Value]) -> String {
        let descriptions = schemaTypes(schema).map { type -> String in
            switch type {
            case "string": "a string"
            case "boolean": "a boolean"
            case "integer": "an integer"
            case "number": "a number"
            case "array":
                schema["items"]?.objectValue?["type"]?.stringValue == "string" ? "an array of strings" : "an array"
            case "object": "an object"
            default: "valid"
            }
        }
        return descriptions.isEmpty ? "valid" : descriptions.joined(separator: " or ")
    }
}
