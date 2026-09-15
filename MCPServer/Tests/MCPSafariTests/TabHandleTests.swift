import MCP
import Testing
@testable import MCPSafari

/// Handles are the whole contract for reaching a tab in a particular Safari
/// profile, so the parse has to reject anything it cannot round-trip rather than
/// guess at a profile and act on the wrong browser window.
struct TabHandleTests {

    @Test func parsesTheCanonicalForm() throws {
        #expect(TabHandle.parse("p0t5") == TabHandle(profileIndex: 0, tabID: 5))
        #expect(TabHandle.parse("p12t3456") == TabHandle(profileIndex: 12, tabID: 3456))
    }

    @Test func formatsBackToWhatItParsed() {
        for text in ["p0t5", "p1t42", "p10t100"] {
            #expect(TabHandle.parse(text)?.description == text)
        }
    }

    @Test func rejectsAnythingThatIsNotAHandle() {
        for text in [
            "",           // empty
            "5",          // the integer form this replaced
            "t5",         // no profile
            "p0",         // no tab
            "p0t",        // no tab number
            "pt5",        // no profile number
            "f0e42",      // an element UID, which is a different namespace
            "p0t5t3",     // trailing junk
            "p-1t5",      // signed
            "p 0t5",      // spaced
            "P0T5",       // the wrong case
            "p٠t٥",       // non-ASCII digits, which Int() would refuse anyway
        ] {
            #expect(TabHandle.parse(text) == nil, "\(text) should not parse")
        }
    }

    @Test func readsTheArgumentAndExplainsWhatWentWrong() throws {
        #expect(try TabHandle.resolve(nil) == nil)
        #expect(try TabHandle.resolve(.null) == nil)
        #expect(try TabHandle.resolve(.string("p2t7")) == TabHandle(profileIndex: 2, tabID: 7))

        // The integer form is refused rather than read as "tab 42 of whichever
        // profile", which is exactly the ambiguity handles exist to remove.
        #expect(throws: TabHandleError.self) { try TabHandle.resolve(.int(42)) }
        #expect(throws: TabHandleError.self) { try TabHandle.resolve(.string("42")) }
        #expect(throws: TabHandleError.self) { try TabHandle.resolve(.bool(true)) }

        let message = (try? errorFor(.int(42))) ?? ""
        #expect(message.contains("p0t5"))
        #expect(message.contains("tabs_context"))
    }

    private func errorFor(_ value: Value) throws -> String {
        do {
            _ = try TabHandle.resolve(value)
            return ""
        } catch let error as TabHandleError {
            return error.description
        }
    }
}
