import MCP
import Testing
@testable import MCPSafari

/// `navigate` and `tabs_create` share one URL check, and `read_console` and
/// `read_network` share one pattern check. These pin what each one accepts.
struct ToolValidatorsTests {
    private func url(_ candidate: String) -> String? {
        try? SafariMCPServer.validatedNavigationURL(candidate)
    }

    // MARK: - URLs

    @Test(arguments: [
        "javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "\tjavascript:alert(1)",
        "\n javascript:alert(1)", "jav\tascript:alert(1)", "java\nscript:alert(1)", "javascript\r:alert(1)",
        "data:text/html,<script>1</script>", "vbscript:msgbox(1)", "blob:https://example.com/1",
        "view-source:https://example.com", "ftp://example.com/file", "//example.com/path",
        "example.com", "/relative/path", "", "   ", ":no-scheme", "1http://example.com",
        "http\u{FF1A}//example.com", "ｈttps://example.com",
    ])
    func refusesAnythingButTheFourSchemes(_ candidate: String) {
        #expect(url(candidate) == nil, "\(candidate.debugDescription) was accepted")
    }

    @Test func refusalSaysWhichSchemesAreAllowed() {
        var message: String?
        do { _ = try SafariMCPServer.validatedNavigationURL("javascript:alert(1)") }
        catch let error as SafariMCPServer.ToolInputError { message = error.description }
        catch {}
        #expect(message == "Invalid URL or disallowed scheme. Only http, https, about, and file are allowed.")
    }

    @Test(arguments: [
        "http://example.com", "https://example.com/a?b=c#d", "about:blank", "file:///tmp/page.html",
        "HTTP://EXAMPLE.COM/Path", "HtTpS://example.com", "about:blank#frag",
    ])
    func acceptsTheFourSchemesInAnyCase(_ candidate: String) {
        #expect(url(candidate) == candidate)
    }

    // The checked string is the one sent, so what Safari parses is what was judged.
    @Test func sendsTheStringTheBrowserWillParse() {
        #expect(url("  https://example.com/a  ") == "https://example.com/a")
        #expect(url("ht\ttps://exa\nmple.com") == "https://example.com")
        #expect(url("https://example.com/a b") != nil)
    }

    // MARK: - Filter patterns

    private func pattern(_ candidate: String) -> String? {
        do {
            return try SafariMCPServer.validatedFilterPattern(candidate, name: "pattern")
        } catch {
            return nil
        }
    }

    @Test(arguments: [
        "error", "error|warning", "^https://example\\.com/", "a.b", "[a-z]", "[^0-9]", "\\d", "\\.", "\\\\",
        "^$", "a\\+b", "\\(x\\)", "\\{\\}", "foo|bar|baz",
    ])
    func acceptsTheBoundedSubset(_ candidate: String) {
        #expect(pattern(candidate) == candidate)
    }

    @Test(arguments: [
        "(a+)+$", "(error)", "a*", "a+", "a?", "a{2}", "a|(b)", "(?:x)", "(?=x)", "[(]", "[a+]",
        "(a)\\1", "\\1", "\\9", "\\k<name>", "\\\\1", "\\\\k",
    ])
    func refusesRepetitionGroupsAndBackreferences(_ candidate: String) {
        #expect(pattern(candidate) == nil, "\(candidate) was accepted")
    }

    @Test(arguments: ["[", "[a-", "\\", "*", "[z-a]", ""])
    func refusesInvalidPatterns(_ candidate: String) {
        #expect(pattern(candidate) == nil, "\(candidate.debugDescription) was accepted")
    }

    @Test func theLengthLimitIsTwoHundredUTF16CodeUnits() {
        #expect(pattern(String(repeating: "a", count: 200)) != nil)
        #expect(pattern(String(repeating: "a", count: 201)) == nil)
        // An astral character is one Character and two code units, which is what
        // the page-world filter counts. 101 of them are 202 units.
        #expect(pattern(String(repeating: "\u{1F600}", count: 100)) != nil)
        #expect(pattern(String(repeating: "\u{1F600}", count: 101)) == nil)
    }

    @Test func aBackslashBeforeALineTerminatorDoesNotHideAQuantifier() {
        // The page-world check drops a backslash and the character after it
        // with `/\\./g`, and `.` does not match a newline, so `\<newline>*` keeps
        // its `*` there. The server must reject what the page would.
        #expect(pattern("\\\n*") == nil)
        #expect(pattern("\\\r+") == nil)
        #expect(pattern("\\\u{2028}?") == nil)
    }

    @Test func refusalsNameTheFilterAndTheRule() {
        func message(_ candidate: String) -> String? {
            do { _ = try SafariMCPServer.validatedFilterPattern(candidate, name: "urlPattern"); return nil }
            catch let error as SafariMCPServer.ToolInputError { return error.description }
            catch { return nil }
        }
        #expect(message(String(repeating: "a", count: 201)) == "urlPattern is too long: 201 UTF-16 code units, max 200")
        #expect(message("(a+)+$")?.hasPrefix("Unsupported urlPattern: use literals") == true)
        #expect(message("[")?.hasPrefix("Invalid regex urlPattern") == true)
    }

    @Test func bothDebuggingToolsApplyTheSameRule() {
        for tool in ["read_console", "read_network"] {
            let key = tool == "read_console" ? "pattern" : "urlPattern"
            #expect(throwsInputError { try SafariMCPServer.preflight(tool: tool, arguments: [key: "(a+)+$"]) })
            #expect(!throwsInputError { try SafariMCPServer.preflight(tool: tool, arguments: [key: "error|warn"]) })
        }
    }

    private func throwsInputError(_ body: () throws -> Void) -> Bool {
        do { try body(); return false } catch is SafariMCPServer.ToolInputError { return true } catch { return false }
    }

    // MARK: - Wait caps

    @Test func waitDurationsAreCappedAtFiveMinutes() throws {
        #expect(try SafariMCPServer.waitRequest(["seconds": 5]) == .duration(seconds: 5))
        #expect(try SafariMCPServer.waitRequest(["seconds": 300]) == .duration(seconds: 300))
        #expect(try SafariMCPServer.waitRequest(["seconds": 301]) == .duration(seconds: 300))
        #expect(try SafariMCPServer.waitRequest(["seconds": 1e9]) == .duration(seconds: 300))
        #expect(try SafariMCPServer.waitRequest(["seconds": -5]) == .duration(seconds: 0))
        #expect(try SafariMCPServer.waitRequest(["seconds": 0]) == .duration(seconds: 0))
    }

    @Test func waitConditionTimeoutsAreCappedAndFloored() throws {
        func timeout(_ args: [String: Value]) throws -> Double? {
            guard case .condition(_, _, let timeout) = try SafariMCPServer.waitRequest(args) else { return nil }
            return timeout
        }
        #expect(try timeout(["selector": "#a"]) == 10)
        #expect(try timeout(["selector": "#a", "timeout": 301]) == 300)
        #expect(try timeout(["selector": "#a", "timeout": 1e9]) == 300)
        #expect(try timeout(["selector": "#a", "timeout": -5]) == 0.1)
        #expect(try timeout(["text": "done", "timeout": 2.5]) == 2.5)
        #expect(try timeout(["seconds": 5, "selector": "#a"]) == 10, "a selector makes it a condition wait")
    }
}
