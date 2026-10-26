import MCP
import Testing
@testable import MCPSafari

/// Each of these is a call the server used to act on with an argument silently
/// dropped. The point of every case is that it is refused before anything is sent.
struct ToolParametersTests {
    private func refusal(_ tool: String, _ args: [String: Value]) -> String? {
        do {
            try SafariMCPServer.preflight(tool: tool, arguments: args)
            return nil
        } catch let error as SafariMCPServer.ToolInputError {
            return error.description
        } catch {
            return "unexpected \(error)"
        }
    }

    @Test func selectTabDoesNotActivateOnAStringBringToFront() {
        // "false" used to read as absent, and an absent bringToFront activates.
        #expect(refusal("select_tab", ["tabId": "p0t1", "bringToFront": "false"]) == "bringToFront must be a boolean")
        #expect(refusal("select_tab", ["tabId": "p0t1", "bringToFront": false]) == nil)
    }

    @Test func readConsoleDoesNotClearOnAWrongTypedPattern() {
        #expect(refusal("read_console", ["pattern": 5, "clear": true]) == "pattern must be a string")
        #expect(refusal("read_console", ["clear": "yes"]) == "clear must be a boolean")
        #expect(refusal("read_console", ["level": 3]) == "level must be a string")
        #expect(refusal("read_console", ["level": "loud"])?.hasPrefix("Invalid console level: loud") == true)
    }

    // The docs promise a rejected filter never silently returns unfiltered data.
    @Test func readNetworkNeverReturnsUnfilteredDataForABadFilter() {
        #expect(refusal("read_network", ["status": "500"]) == "status must be an integer")
        #expect(refusal("read_network", ["status": 500.5]) == "status must be an integer")
        #expect(refusal("read_network", ["status": 600])?.hasPrefix("Invalid status: 600") == true)
        #expect(refusal("read_network", ["status": 500.0]) == nil)
        #expect(refusal("read_network", ["urlPattern": 7]) == "urlPattern must be a string")
        #expect(refusal("read_network", ["maxResults": "5"]) == "maxResults must be an integer")
        #expect(refusal("read_network", ["maxResults": 0]) == "Invalid maxResults: 0. Use a positive integer.")
        #expect(refusal("read_network", ["type": ["xhr"]]) == "type must be a string")
        #expect(refusal("read_network", ["clear": 1]) == "clear must be a boolean")
    }

    @Test func resizeWindowRequiresBothDimensionsAsPositiveBoundedIntegers() throws {
        #expect(refusal("resize_window", ["height": 600])?.hasPrefix("width is required") == true)
        #expect(refusal("resize_window", ["width": 800])?.hasPrefix("height is required") == true)
        #expect(refusal("resize_window", [:])?.hasPrefix("width is required") == true)
        #expect(refusal("resize_window", ["width": "800", "height": 600]) == "width must be an integer")
        #expect(refusal("resize_window", ["width": 0, "height": 600])?.hasPrefix("Invalid width: 0") == true)
        #expect(refusal("resize_window", ["width": 800, "height": -5])?.hasPrefix("Invalid height: -5") == true)
        #expect(refusal("resize_window", ["width": 800, "height": 10_001])?.hasPrefix("Invalid height: 10001") == true)
        #expect(refusal("resize_window", ["width": 10_000, "height": 1]) == nil)

        // 800.0 used to send nothing for width.
        let params = try SafariMCPServer.resizeWindowParams(["width": 800.0, "height": 600])
        #expect(params["width"]?.intValue == 800)
        #expect(params["height"]?.intValue == 600)
    }

    @Test func pageReadingRefusesWrongTypes() {
        #expect(refusal("read_page", ["format": 1]) == "format must be a string")
        #expect(refusal("read_page", ["maxChars": "100"]) == "maxChars must be an integer")
        #expect(refusal("read_page", ["maxNodes": 0]) == "Invalid maxNodes: 0. Use a positive integer.")
        #expect(refusal("snapshot", ["maxNodes": true]) == "maxNodes must be an integer")
        #expect(refusal("find", ["selector": 1]) == "selector must be a string")
        #expect(refusal("find", ["role": ["button"]]) == "role must be a string")
        #expect(refusal("javascript_tool", ["code": 42]) == "code must be a string")
    }

    // A caller cannot ask for unbounded output; asking for more gets the maximum.
    @Test func outputSizeRequestsAreClampedToTheDocumentedMaxima() throws {
        let page = try SafariMCPServer.readPageParams(["maxChars": 2_000_000_000, "maxNodes": 1_000_000])
        #expect(page["maxChars"]?.intValue == 1_000_000)
        #expect(page["maxNodes"]?.intValue == 10_000)
        #expect(try SafariMCPServer.snapshotParams(["maxNodes": .int(Int.max)])["maxNodes"]?.intValue == 10_000)
        #expect(try SafariMCPServer.readNetworkParams(["maxResults": 50_000])["maxResults"]?.intValue == 1_000)

        // At the maximum and below it nothing changes.
        let exact = try SafariMCPServer.readPageParams(["maxChars": 1_000_000, "maxNodes": 7])
        #expect(exact["maxChars"]?.intValue == 1_000_000)
        #expect(exact["maxNodes"]?.intValue == 7)
        #expect(try SafariMCPServer.readNetworkParams(["maxResults": 1_000])["maxResults"]?.intValue == 1_000)
        #expect(try SafariMCPServer.readNetworkParams(["maxResults": 1])["maxResults"]?.intValue == 1)

        // Clamping is for large values; zero and negatives are still wrong.
        #expect(refusal("read_page", ["maxChars": 0]) == "Invalid maxChars: 0. Use a positive integer.")
        #expect(refusal("read_network", ["maxResults": -1]) == "Invalid maxResults: -1. Use a positive integer.")
    }

    @Test func navigationRefusesWrongTypes() {
        #expect(refusal("navigate", ["url": 5]) == "url must be a string")
        #expect(refusal("navigate", ["action": true]) == "action must be a string")
        #expect(refusal("navigate", ["action": "sideways"])?.hasPrefix("Invalid navigation action: sideways") == true)
        #expect(refusal("tabs_create", ["url": ["https://example.com"]]) == "url must be a string")
        #expect(refusal("navigate", ["url": "https://example.com", "action": "goto"]) == nil)
    }

    @Test func waitRefusesWrongTypesRatherThanFallingBackToTheDefaults() {
        #expect(refusal("wait", ["seconds": "5"]) == "seconds must be a number")
        #expect(refusal("wait", ["timeout": "5", "selector": "#a"]) == "timeout must be a number")
        #expect(refusal("wait", ["selector": 5]) == "selector must be a string")
        #expect(refusal("wait", ["text": false]) == "text must be a string")
    }

    // A caller who fixes the bad argument and retries would otherwise act twice.
    @Test(arguments: SafariMCPServer.actionTools.sorted())
    func everyActionToolChecksItsWaitOptionsBeforeActing(_ tool: String) {
        #expect(refusal(tool, ["waitForSelector": 5]) == "waitForSelector must be a string")
        #expect(refusal(tool, ["waitForSelector": ""]) == "waitForSelector must not be empty")
        #expect(refusal(tool, ["waitForText": false]) == "waitForText must be a string")
        #expect(refusal(tool, ["waitForText": ""]) == "waitForText must not be empty")
        #expect(refusal(tool, ["waitForSelector": "#done", "waitTimeout": "5"]) == "waitTimeout must be a number")
        // Wrong even when no wait was asked for: it would be dropped silently.
        #expect(refusal(tool, ["waitTimeout": "5"]) == "waitTimeout must be a number")
        #expect(refusal(tool, ["includeSnapshot": "true"]) == "includeSnapshot must be a boolean")
        var valid: [String: Value] = ["waitForSelector": "#done", "waitForText": "Done", "waitTimeout": 5]
        if tool == "upload_file" || tool == "drop_file" { valid["filePath"] = "/tmp/a.png" }
        #expect(refusal(tool, valid) == nil)
    }

    @Test func traceOptionsAreCheckedBeforeStartTraceCanBeSent() {
        #expect(refusal("click", ["trace": "yes"]) == "trace must be a boolean")
        #expect(refusal("click", ["trace": true, "traceDuration": "long"]) == "traceDuration must be a number")
        #expect(refusal("click", ["trace": true, "eventTypes": "dom.mutation"]) == "eventTypes must be an array of non-empty strings")
        #expect(refusal("click", ["trace": true, "eventTypes": [""]]) == "eventTypes must be an array of non-empty strings")
        #expect(refusal("run_steps", ["trace": true, "traceDuration": [1]]) == "traceDuration must be a number")
        #expect(refusal("run_steps", ["includeSnapshot": 1]) == "includeSnapshot must be a boolean")
        #expect(refusal("click", ["trace": true, "traceDuration": 5, "eventTypes": ["dom.mutation"]]) == nil)
    }

    @Test func theWaitAndTraceCapsHold() throws {
        let wait = try #require(try SafariMCPServer.postActionWait(["waitForText": "x", "waitTimeout": 1e9]))
        #expect(wait.timeout == 300)
        #expect(try SafariMCPServer.postActionWait(["waitForText": "x", "waitTimeout": 301])?.timeout == 300)
        #expect(try SafariMCPServer.postActionWait(["waitForText": "x", "waitTimeout": -1])?.timeout == 0.1)
        #expect(try SafariMCPServer.postActionWait(["waitForText": "x"])?.timeout == 10)
        #expect(try SafariMCPServer.postActionWait([:]) == nil)

        #expect(try SafariMCPServer.traceOptions(["trace": true, "traceDuration": 999])?.duration == 30)
        #expect(try SafariMCPServer.traceOptions(["trace": true, "traceDuration": -3])?.duration == 0)
        #expect(try SafariMCPServer.traceOptions(["trace": true])?.duration == 2)
        #expect(try SafariMCPServer.traceOptions(["trace": false, "traceDuration": 5]) == nil)
        #expect(try SafariMCPServer.traceOptions([:]) == nil)
    }

    @Test func toolsWithNothingToCheckPassThrough() {
        #expect(refusal("status", ["anything": 1]) == nil)
        #expect(refusal("click", ["selector": "#a"]) == nil)
    }
}
