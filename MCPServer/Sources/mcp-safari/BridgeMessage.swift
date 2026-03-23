import Foundation

// MARK: - Wire Protocol

/// Request sent from MCP server to the Safari extension over WebSocket.
struct BridgeRequest: Codable, Sendable {
    let id: String
    let action: String
    let params: [String: AnyCodable]

    init(action: String, params: [String: AnyCodable] = [:]) {
        self.id = UUID().uuidString
        self.action = action
        self.params = params
    }
}

/// Response sent from the Safari extension back to the MCP server over WebSocket.
struct BridgeResponse: Codable, Sendable {
    let id: String
    let success: Bool
    let data: AnyCodable?
    let error: String?
}

// MARK: - AnyCodable

/// Type-erased Codable wrapper for arbitrary JSON values in bridge messages.
struct AnyCodable: Codable, Sendable, CustomStringConvertible {
    let value: any Sendable

    init(_ value: any Sendable) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self.value = NSNull()
        } else if let bool = try? container.decode(Bool.self) {
            self.value = bool
        } else if let int = try? container.decode(Int.self) {
            self.value = int
        } else if let double = try? container.decode(Double.self) {
            self.value = double
        } else if let string = try? container.decode(String.self) {
            self.value = string
        } else if let array = try? container.decode([AnyCodable].self) {
            self.value = array
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            self.value = dict
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        switch value {
        case is NSNull:
            try container.encodeNil()
        case let bool as Bool:
            try container.encode(bool)
        case let int as Int:
            try container.encode(int)
        case let double as Double:
            try container.encode(double)
        case let string as String:
            try container.encode(string)
        case let dict as [String: AnyCodable]:
            try container.encode(dict)
        // Concrete dictionary types before the existential catch-all
        case let dict as [String: String]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        case let dict as [String: Int]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        case let dict as [String: any Sendable]:
            try container.encode(dict.mapValues { AnyCodable($0) })
        case let array as [AnyCodable]:
            try container.encode(array)
        case let array as [any Sendable]:
            try container.encode(array.map { AnyCodable($0) })
        default:
            throw EncodingError.invalidValue(
                value,
                EncodingError.Context(
                    codingPath: encoder.codingPath,
                    debugDescription: "Unsupported type: \(type(of: value))"
                )
            )
        }
    }

    var description: String {
        "\(value)"
    }

    // MARK: - Convenience accessors

    var stringValue: String? { value as? String }
    var intValue: Int? { value as? Int }
    var doubleValue: Double? { value as? Double }
    var boolValue: Bool? { value as? Bool }
    var arrayValue: [AnyCodable]? { value as? [AnyCodable] }
    var objectValue: [String: AnyCodable]? { value as? [String: AnyCodable] }
}

// MARK: - ExpressibleBy Literals

extension AnyCodable: ExpressibleByStringLiteral {
    init(stringLiteral value: String) { self.init(value) }
}

extension AnyCodable: ExpressibleByIntegerLiteral {
    init(integerLiteral value: Int) { self.init(value) }
}

extension AnyCodable: ExpressibleByFloatLiteral {
    init(floatLiteral value: Double) { self.init(value) }
}

extension AnyCodable: ExpressibleByBooleanLiteral {
    init(booleanLiteral value: Bool) { self.init(value) }
}

extension AnyCodable: ExpressibleByNilLiteral {
    init(nilLiteral: ()) { self.init(NSNull()) }
}
