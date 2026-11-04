import Foundation
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
        valid.merge(requiredArguments(for: tool)) { _, required in required }
        #expect(refusal(tool, valid) == nil)
    }

    /// The least a tool needs to be a valid call, with a real file where it
    /// names one.
    private func requiredArguments(for tool: String) -> [String: Value] {
        switch tool {
        case "type_text": ["text": "x"]
        case "press_key": ["key": "Enter"]
        case "scroll": ["direction": "down"]
        case "form_input": ["fields": ["#a": "b"]]
        case "handle_dialog": ["action": "accept"]
        case "upload_file", "drop_file": ["filePath": .string(Self.existingFile)]
        default: [:]
        }
    }

    private static let existingFile: String = {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("preflight-\(UUID().uuidString).txt")
        try? "x".write(to: url, atomically: true, encoding: .utf8)
        return url.path
    }()

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

    @Test func aWellFormedCallPassesThrough() {
        #expect(refusal("status", [:]) == nil)
        #expect(refusal("click", ["selector": "#a"]) == nil)
    }

    // MARK: - Unknown argument names

    // `click {native: true}` ran a synthetic click, and `waitForSelctor` did nothing
    // at all. Both are the caller being told nothing, so both are refused.
    @Test func anArgumentTheToolDoesNotDeclareIsRefusedWithTheOnesItDoes() {
        let click = refusal("click", ["selector": "#a", "native": true])
        #expect(click?.hasPrefix("click does not take the argument \"native\". Its arguments are: ") == true)
        #expect(click?.contains("doubleClick") == true)
        #expect(click?.contains("waitForSelector") == true)

        let typo = refusal("click", ["selector": "#a", "waitForSelctor": "#b"])
        #expect(typo?.hasPrefix("click does not take the argument \"waitForSelctor\"") == true)

        #expect(refusal("status", ["anything": 1]) == "status does not take the argument \"anything\". It takes no arguments.")
        #expect(refusal("tabs_context", ["tabId": "p0t1"])?.hasPrefix("tabs_context does not take") == true)
        #expect(refusal("click", ["b": 1, "a": 2, "selector": "#a"])?.hasPrefix("click does not take the arguments \"a\", \"b\". ") == true)
    }

    @Test func theInternalBatchDeadlineIsNoArgumentAClientMayGive() {
        #expect(refusal("click", ["selector": "#a", "_batchDeadline": 0])?.hasPrefix("click does not take the argument \"_batchDeadline\"") == true)
        #expect(refusal("run_steps", ["steps": [["tool": "wait"]], "_batchDeadline": 0]) != nil)
    }

    @Test func everyDeclaredArgumentIsAccepted() throws {
        for tool in SafariMCPServer.toolDefinitions {
            let properties = tool.inputSchema.objectValue?["properties"]?.objectValue ?? [:]
            for name in properties.keys {
                #expect(
                    refusal(tool.name, [name: sampleValue(for: properties[name])])?.contains("does not take") != true,
                    "\(tool.name) refuses its own argument \(name)"
                )
            }
        }
    }

    private func sampleValue(for schema: Value?) -> Value {
        let type = schema?.objectValue?["type"]?.stringValue ?? schema?.objectValue?["type"]?.arrayValue?.first?.stringValue
        switch type {
        case "boolean": return true
        case "integer": return 1
        case "number": return 1
        case "array": return []
        case "object": return [:]
        default: return schema?.objectValue?["enum"]?.arrayValue?.first ?? "x"
        }
    }

    // MARK: - Wrong types

    // `"false"` is truthy once it reaches the extension: force skipped the
    // reachability check, doubleClick double-clicked, and clearFirst wiped the field.
    @Test(arguments: [
        ("click", "force"), ("click", "doubleClick"), ("hover", "force"), ("drag", "force"),
        ("type_text", "clearFirst"), ("type_text", "native"), ("press_key", "native"),
        ("hover", "native"), ("drag", "native"), ("click", "includeSnapshot"), ("click", "trace"),
    ])
    func aStringWhereABooleanIsDeclaredIsRefused(_ tool: String, _ name: String) {
        var args = requiredArguments(for: tool)
        args[name] = "false"
        #expect(refusal(tool, args) == "\(name) must be a boolean")
    }

    @Test func everyInteractionArgumentIsTypeCheckedBeforeAnythingIsSent() {
        #expect(refusal("click", ["x": "10", "y": 20]) == "x must be a number")
        #expect(refusal("click", ["x": 10, "y": [20]]) == "y must be a number")
        #expect(refusal("hover", ["x": 10]) == "x and y must be given together: a viewport point needs both")
        #expect(refusal("click", ["y": 10]) == "x and y must be given together: a viewport point needs both")
        #expect(refusal("click", ["x": 10, "y": 20]) == nil)
        #expect(refusal("scroll", ["direction": "down", "amount": "50"]) == "amount must be an integer")
        #expect(refusal("scroll", ["direction": "down", "amount": 50.5]) == "amount must be an integer")
        #expect(refusal("scroll", ["direction": "down", "amount": 50.0]) == nil)
        #expect(refusal("scroll", ["direction": "sideways"]) == "Invalid direction: sideways. Use up, down, left, right.")
        #expect(refusal("scroll", [:]) == "direction is required")
        #expect(refusal("click", ["uid": 5]) == "uid must be a string")
        #expect(refusal("click", ["selector": ["#a"]]) == "selector must be a string")
        #expect(refusal("click", ["text": true]) == "text must be a string")
        #expect(refusal("select_option", ["selector": "s", "value": 1]) == "value must be a string")
        #expect(refusal("drag", ["fromUid": 1, "toUid": "e2"]) == "fromUid must be a string")
        #expect(refusal("type_text", ["text": 5]) == "text must be a string")
        #expect(refusal("type_text", [:]) == "text is required")
        #expect(refusal("type_text", ["text": "x", "submitKey": 13]) == "submitKey must be a string")
        #expect(refusal("press_key", ["key": 13]) == "key must be a string")
        #expect(refusal("press_key", [:]) == "key is required")
        #expect(refusal("javascript_tool", ["code": 1]) == "code must be a string")
        #expect(refusal("javascript_tool", [:]) == "code is required")
        #expect(refusal("find", ["role": 1]) == "role must be a string")
        #expect(refusal("handle_dialog", ["action": "maybe"]) == "Invalid action: maybe. Use accept, dismiss.")
        #expect(refusal("handle_dialog", ["action": true]) == "action must be a string")
        #expect(refusal("handle_dialog", ["action": "accept", "promptText": 4]) == "promptText must be a string")
        #expect(refusal("handle_dialog", [:]) == "action is required")
        #expect(refusal("run_steps", ["steps": "wait"]) == "steps must be an array")
        #expect(refusal("run_steps", ["steps": [["tool": "wait"]], "timeout": "5"]) == "timeout must be a number")
        #expect(refusal("wait", ["seconds": 1, "tabId": 5])?.hasPrefix("tabId must be a tab handle") == true)
    }

    @Test func tabIdIsReadAsAHandleOnEveryToolThatTakesOne() {
        for tool in SafariMCPServer.toolDefinitions where SafariMCPServer.declaresArgument("tabId", for: tool.name) {
            var args = requiredArguments(for: tool.name)
            args["tabId"] = "42"
            if tool.name == "resize_window" { args["width"] = 1; args["height"] = 1 }
            #expect(refusal(tool.name, args)?.hasPrefix("tabId \"42\" is not a tab handle") == true, "\(tool.name)")
        }
        // Naming the profile to open a tab in, and the window to resize, are declared.
        #expect(refusal("tabs_create", ["tabId": "p1t3"]) == nil)
        #expect(refusal("resize_window", ["width": 800, "height": 600, "tabId": "p1t3"]) == nil)
    }

    @Test func closeAndSelectTabNeedAHandle() {
        #expect(refusal("close_tab", [:]) == "close_tab requires tabId, a handle from tabs_context such as p0t5")
        #expect(refusal("select_tab", [:]) == "select_tab requires tabId, a handle from tabs_context such as p0t5")
        #expect(refusal("close_tab", ["tabId": "p0t5"]) == nil)
    }

    // MARK: - form_input

    @Test func formInputFieldsAreCheckedBeforeTheyAreSent() throws {
        #expect(refusal("form_input", [:]) == "fields must contain at least one CSS selector and value")
        #expect(refusal("form_input", ["fields": [:]]) == "fields must contain at least one CSS selector and value")
        #expect(refusal("form_input", ["fields": 5]) == "fields must be an object mapping CSS selectors to values")
        #expect(refusal("form_input", ["fields": "not json"]) == "fields must be an object mapping CSS selectors to values")
        #expect(refusal("form_input", ["fields": ["#a": [1]]]) == "fields[\"#a\"] must be a string, number or boolean")
        #expect(refusal("form_input", ["fields": ["#a": .null]]) == "fields[\"#a\"] must be a string, number or boolean")
        #expect(refusal("form_input", ["fields": ["#a": "x"]]) == nil)

        // Numbers and booleans are entered as their text, and JSON text is read as the object.
        let fields = try SafariMCPServer.formInputFields(["fields": ["#a": "x", "#b": 3, "#c": true, "#d": 1.5]])
        #expect(fields == ["#a": "x", "#b": "3", "#c": "true", "#d": "1.5"])
        let json = ##"{"#a":"x","#b":true}"##
        #expect(try SafariMCPServer.formInputFields(["fields": .string(json)]) == ["#a": "x", "#b": "true"])
    }

    // MARK: - Files

    @Test func aFileThatCannotBeAttachedIsRefusedBeforeTheCall() throws {
        #expect(refusal("upload_file", ["selector": "i", "filePath": "/nonexistent/a.png"]) == "Cannot open file: /nonexistent/a.png")
        #expect(refusal("drop_file", ["selector": "i", "filePaths": [.string(Self.existingFile), "/nonexistent/b.png"]]) == "Cannot open file: /nonexistent/b.png")
        #expect(refusal("upload_file", ["selector": "i", "filePath": "/tmp"])?.hasSuffix("is not a readable regular file") == true)
        #expect(refusal("upload_file", ["selector": "i", "filePath": .string(Self.existingFile)]) == nil)

        let tokenPath = WebSocketBridge.tokenDirectoryURL.appendingPathComponent("8089").path
        // Whether or not a token file exists there, nothing under the root may be named.
        let message = refusal("upload_file", ["selector": "i", "filePath": .string(tokenPath)])
        #expect(message != nil)
    }
}
