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
    let errorCode: String?
    let retryable: Bool?
    let recoveryAction: String?
    /// The tab the extension resolved for this request, as its own tab id, on
    /// success and failure alike. Null for requests that name no tab to resolve
    /// (listing, creating, closing, selecting) and absent from an older extension.
    var resolvedTabId: Int?
    /// The profile the request was routed to. Not on the wire: the server sets
    /// it, because the tab id above only means something together with it.
    var profileIndex: Int?

    private enum CodingKeys: String, CodingKey {
        case id, success, data, error, errorCode, retryable, recoveryAction, resolvedTabId
    }

    var toolFailure: ToolFailure {
        ToolFailure(
            code: errorCode ?? "extension_error",
            message: error ?? "Safari extension failed",
            retryable: retryable ?? false,
            recoveryAction: recoveryAction ?? "inspect_error"
        )
    }
}

extension BridgeResponse {
    /// The request id of a reply that would not decode, read straight from its text.
    ///
    /// The cases that matter are ones a JSON parser refuses as a whole, such as a
    /// string holding a lone surrogate escape, so no parser can be asked for the id.
    /// The extension writes `id` first, and the ids this server hands out are UUIDs,
    /// so a short scan of the start of the frame finds it. The caller still has to
    /// match the result against a request it is waiting on, which is what makes a
    /// wrong guess harmless.
    static func recoverID(from data: Data) -> String? {
        let head = Array(data.prefix(512))
        guard let key = head.firstRange(of: Array(#""id":""#.utf8)) else { return nil }
        let id = head[key.upperBound...].prefix { $0 != UInt8(ascii: "\"") }
        guard !id.isEmpty, id.count <= 64, id.count < head.count - key.upperBound,
              id.allSatisfy({ $0 == UInt8(ascii: "-") || $0 == UInt8(ascii: "_") || isASCIIAlphanumeric($0) })
        else { return nil }
        return String(decoding: id, as: UTF8.self)
    }

    private static func isASCIIAlphanumeric(_ byte: UInt8) -> Bool {
        (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
            || (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte)
            || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte)
    }
}

struct ToolFailure: Codable, Equatable, Sendable {
    let code: String
    let message: String
    let retryable: Bool
    let recoveryAction: String
}

// MARK: - AnyCodable

/// Type-erased Codable wrapper for arbitrary JSON values in bridge messages.
struct AnyCodable: Codable, Sendable, CustomStringConvertible {
    let value: any Sendable

    init(_ value: any Sendable) {
        self.value = value
    }

    init(from decoder: any Decoder) throws {
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

    func encode(to encoder: any Encoder) throws {
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
