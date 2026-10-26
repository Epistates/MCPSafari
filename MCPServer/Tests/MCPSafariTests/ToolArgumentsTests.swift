import MCP
import Testing
@testable import MCPSafari

/// A wrong-typed optional argument used to read as an absent one, so the call
/// ran with a default the caller never asked for.
struct ToolArgumentsTests {
    private func message(_ body: () throws -> Void) -> String? {
        do {
            try body()
            return nil
        } catch let error as SafariMCPServer.ToolInputError {
            return error.description
        } catch {
            return "unexpected \(error)"
        }
    }

    @Test func absentAndNullKeysAreNil() throws {
        let args: [String: Value] = ["nothing": .null]
        #expect(try SafariMCPServer.optionalString("missing", in: args) == nil)
        #expect(try SafariMCPServer.optionalString("nothing", in: args) == nil)
        #expect(try SafariMCPServer.optionalBool("nothing", in: args) == nil)
        #expect(try SafariMCPServer.optionalInt("nothing", in: args) == nil)
        #expect(try SafariMCPServer.optionalNumber("nothing", in: args) == nil)
    }

    @Test func rightTypesComeThrough() throws {
        let args: [String: Value] = ["s": "text", "b": false, "i": 7, "d": 2.5]
        #expect(try SafariMCPServer.optionalString("s", in: args) == "text")
        #expect(try SafariMCPServer.optionalBool("b", in: args) == false)
        #expect(try SafariMCPServer.optionalInt("i", in: args) == 7)
        #expect(try SafariMCPServer.optionalNumber("d", in: args) == 2.5)
        #expect(try SafariMCPServer.optionalNumber("i", in: args) == 7)
    }

    @Test func aPresentKeyOfTheWrongTypeIsRefusedNamingTheKey() {
        let args: [String: Value] = ["s": 5, "b": "false", "i": "800", "n": "1.5", "frac": 800.5, "flag": true]
        #expect(message { _ = try SafariMCPServer.optionalString("s", in: args) } == "s must be a string")
        #expect(message { _ = try SafariMCPServer.optionalBool("b", in: args) } == "b must be a boolean")
        #expect(message { _ = try SafariMCPServer.optionalBool("s", in: args) } == "s must be a boolean")
        #expect(message { _ = try SafariMCPServer.optionalInt("i", in: args) } == "i must be an integer")
        #expect(message { _ = try SafariMCPServer.optionalInt("frac", in: args) } == "frac must be an integer")
        #expect(message { _ = try SafariMCPServer.optionalInt("flag", in: args) } == "flag must be an integer")
        #expect(message { _ = try SafariMCPServer.optionalNumber("n", in: args) } == "n must be a number")
    }

    // Some clients serialize every number as a double, so 800 arrives as 800.0.
    @Test func aWholeValuedDoubleIsAnInteger() throws {
        let args: [String: Value] = ["width": 800.0, "huge": 1e30, "negative": -3.0]
        #expect(try SafariMCPServer.optionalInt("width", in: args) == 800)
        #expect(try SafariMCPServer.optionalInt("negative", in: args) == -3)
        #expect(message { _ = try SafariMCPServer.optionalInt("huge", in: args) } == "huge must be an integer")
    }

    @Test func positiveIntegersRefuseZeroAndNegatives() throws {
        #expect(try SafariMCPServer.optionalPositiveInt("n", in: ["n": 3]) == 3)
        #expect(message { _ = try SafariMCPServer.optionalPositiveInt("n", in: ["n": 0]) } == "Invalid n: 0. Use a positive integer.")
        #expect(message { _ = try SafariMCPServer.optionalPositiveInt("n", in: ["n": -1]) } == "Invalid n: -1. Use a positive integer.")
    }
}
