import Foundation
import MCP
import Testing

@testable import MCPSafari

/// Tool results carry the answer twice, as prose and as data. Until now only
/// failures carried the data half, so a caller got something parseable only when
/// something went wrong.
struct StructuredOutputTests {

    @Test func aJsonListingBecomesDataRatherThanAStringOfData() throws {
        let listing = #"[{"uid":"f0e6","tag":"h1"},{"uid":"f3e2","tag":"input"}]"#

        let payload = SafariMCPServer.structuredPayload(AnyCodable(listing))

        // The point of the structured half: an array a caller can index, not a
        // string they have to parse a second time.
        let matches = try #require(payload.arrayValue)
        #expect(matches.count == 2)
        #expect(matches[1].objectValue?["uid"]?.stringValue == "f3e2")
    }

    @Test func aJsonObjectSurvivesWithItsNesting() throws {
        let tree = #"{"uid":"f0e1","tag":"body","children":[{"uid":"f0e6","tag":"h1"}]}"#

        let payload = SafariMCPServer.structuredPayload(AnyCodable(tree))

        let root = try #require(payload.objectValue)
        #expect(root["tag"]?.stringValue == "body")
        #expect(root["children"]?.arrayValue?.first?.objectValue?["uid"]?.stringValue == "f0e6")
    }

    /// `read_page` with `format: "text"` returns whatever the page says, and a
    /// page is free to say something that parses as JSON.
    @Test func pageTextStaysText() {
        for prose in ["Example Domain", "  ", "Hello, world"] {
            #expect(SafariMCPServer.structuredPayload(AnyCodable(prose)) == .string(prose))
        }
    }

    /// The sharp case. `true`, `null` and `42` are all valid JSON documents, so a
    /// parser alone would turn a page that says "42" into the number 42 and a
    /// page that says "null" into an absent value.
    @Test func proseThatHappensToParseAsJsonIsNotRetyped() {
        for ambiguous in ["42", "true", "false", "null", "3.14", #""quoted""#] {
            let payload = SafariMCPServer.structuredPayload(AnyCodable(ambiguous))
            #expect(payload == .string(ambiguous), "\(ambiguous) should have stayed text")
        }
    }

    @Test func anAbsentPayloadIsNull() {
        #expect(SafariMCPServer.structuredPayload(nil) == .null)
    }

    /// Malformed JSON is page text too, not an error worth failing the call over.
    @Test func unparseableTextStaysText() {
        let broken = #"{"uid":"f0e1","#
        #expect(SafariMCPServer.structuredPayload(AnyCodable(broken)) == .string(broken))
    }

    /// The extension stringifies before sending, so a non-string payload is the
    /// uncommon path rather than the impossible one.
    @Test func aPayloadThatArrivedUnstringifiedIsStillCarried() {
        #expect(SafariMCPServer.structuredPayload(AnyCodable(7)) == .int(7))
        #expect(SafariMCPServer.structuredPayload(AnyCodable(true)) == .bool(true))
    }
    @Test func textFormatNeverSniffsJsonContainersOrPrimitives() {
        for text in ["{}", "[]", #"{"a":1}"#, "42", "true", "null", #""quoted""#] {
            #expect(SafariMCPServer.structuredPayload(AnyCodable(text), decoding: .text) == .string(text))
        }
    }

    @Test func explicitJsonResultsPreservePrimitiveTypes() {
        #expect(SafariMCPServer.structuredPayload(AnyCodable("42"), decoding: .json) == .int(42))
        #expect(SafariMCPServer.structuredPayload(AnyCodable("true"), decoding: .json) == .bool(true))
        #expect(SafariMCPServer.structuredPayload(AnyCodable("null"), decoding: .json) == .null)
        #expect(SafariMCPServer.structuredPayload(AnyCodable(#""hello""#), decoding: .json) == .string("hello"))
    }

}
