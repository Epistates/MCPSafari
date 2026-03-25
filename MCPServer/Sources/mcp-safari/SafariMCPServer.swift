import Foundation
import Logging
import MCP

/// Core MCP server that registers Safari automation tools and bridges
/// tool calls to the Safari extension via WebSocket.
actor SafariMCPServer {
    private let server: Server
    private let bridge: WebSocketBridge
    private let logger: Logger

    init(port: UInt16 = 8089, logger: Logger) throws {
        self.logger = logger
        self.bridge = try WebSocketBridge(port: port, logger: logger)
        self.server = Server(
            name: "mcp-safari",
            version: "0.2.3",
            instructions: """
                Safari browser automation. Use tabs_context to list tabs, snapshot for element UIDs, \
                then click/type_text/hover by UID. Use includeSnapshot on interactions to see updated state.
                """,
            capabilities: Server.Capabilities(
                logging: .init(),
                tools: .init(listChanged: false)
            )
        )
    }

    func start() async throws {
        await bridge.start()
        await registerToolHandlers()
        let transport = StdioTransport()
        try await server.start(transport: transport)
        logger.info("Safari MCP server started")
        await server.waitUntilCompleted()
    }

    // MARK: - Tool Registration

    private func registerToolHandlers() async {
        let allTools = buildToolDefinitions()

        await server.withMethodHandler(ListTools.self) { _ in
            .init(tools: allTools)
        }

        await server.withMethodHandler(CallTool.self) { [weak self] params -> CallTool.Result in
            guard let self else {
                return CallTool.Result(
                    content: [Tool.Content.text("Server shutting down")],
                    isError: true
                )
            }
            return await self.handleToolCall(params)
        }
    }

    // MARK: - Shared Schema Fragments (terse to minimize token usage)

    private static let tab: Value = .object(["type": .string("integer"), "description": .string("Tab ID (default: active tab)")])
    private static let uid: Value = .object(["type": .string("string"), "description": .string("Element UID from snapshot")])
    private static let sel: Value = .object(["type": .string("string"), "description": .string("CSS selector")])
    private static let txt: Value = .object(["type": .string("string"), "description": .string("Visible text to match")])
    private static let snap: Value = .object(["type": .string("boolean"), "description": .string("Return snapshot after action")])

    // MARK: - Tool Definitions

    private func buildToolDefinitions() -> [Tool] {
        [
            // ── Tabs ─────────────────────────────────────────────────

            Tool(
                name: "tabs_context",
                description: "List open tabs with IDs, URLs, titles.",
                inputSchema: .object(["type": .string("object"), "properties": .object([:])]),
                annotations: .init(readOnlyHint: true, openWorldHint: false)
            ),
            Tool(
                name: "tabs_create",
                description: "Open a new tab.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "url": .object(["type": .string("string"), "description": .string("URL to open")]),
                    ]),
                ])
            ),
            Tool(
                name: "close_tab",
                description: "Close a tab by ID.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(["tabId": Self.tab]),
                    "required": .array([.string("tabId")]),
                ]),
                annotations: .init(readOnlyHint: false, destructiveHint: true)
            ),
            Tool(
                name: "select_tab",
                description: "Pin a tab as default context for future calls.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(["tabId": Self.tab]),
                    "required": .array([.string("tabId")]),
                ])
            ),

            // ── Navigation ───────────────────────────────────────────

            Tool(
                name: "navigate",
                description: "Go to URL or back/forward/reload.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "url": .object(["type": .string("string")]),
                        "action": .object(["type": .string("string"), "enum": .array([.string("goto"), .string("back"), .string("forward"), .string("reload")])]),
                        "tabId": Self.tab,
                    ]),
                ])
            ),

            // ── Page Reading ─────────────────────────────────────────

            Tool(
                name: "snapshot",
                description: "Accessibility tree with element UIDs for interaction tools. UIDs change between snapshots.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(["tabId": Self.tab]),
                ]),
                annotations: .init(readOnlyHint: true)
            ),
            Tool(
                name: "read_page",
                description: "Page content as text, html, or snapshot.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "format": .object(["type": .string("string"), "enum": .array([.string("text"), .string("html"), .string("snapshot")])]),
                        "tabId": Self.tab,
                    ]),
                ]),
                annotations: .init(readOnlyHint: true)
            ),
            Tool(
                name: "find",
                description: "Find elements by selector, text, or ARIA role. Returns UIDs.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "selector": Self.sel, "text": Self.txt,
                        "role": .object(["type": .string("string"), "description": .string("ARIA role (button, link, textbox, etc.)")]),
                        "tabId": Self.tab,
                    ]),
                ]),
                annotations: .init(readOnlyHint: true)
            ),

            // ── Interaction ──────────────────────────────────────────

            Tool(
                name: "click",
                description: "Click element by UID, selector, text, or x/y coordinates.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "uid": Self.uid, "selector": Self.sel, "text": Self.txt,
                        "x": .object(["type": .string("number")]),
                        "y": .object(["type": .string("number")]),
                        "doubleClick": .object(["type": .string("boolean")]),
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ]),
                ])
            ),
            Tool(
                name: "type_text",
                description: "Type into element. Supports clearFirst and submitKey (e.g. Enter).",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "text": .object(["type": .string("string")]),
                        "uid": Self.uid, "selector": Self.sel,
                        "clearFirst": .object(["type": .string("boolean")]),
                        "submitKey": .object(["type": .string("string"), "description": .string("Key after typing (Enter, Tab)")]),
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ]),
                    "required": .array([.string("text")]),
                ])
            ),
            Tool(
                name: "form_input",
                description: "Batch fill form fields. React-compatible.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "fields": .object([
                            "type": .string("object"),
                            "description": .string("CSS selector → value map"),
                            "additionalProperties": .object(["type": .string("string")]),
                        ]),
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ]),
                    "required": .array([.string("fields")]),
                ])
            ),
            Tool(
                name: "select_option",
                description: "Select dropdown option by value or label.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "uid": Self.uid, "selector": Self.sel,
                        "value": .object(["type": .string("string")]),
                        "label": .object(["type": .string("string")]),
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ]),
                ])
            ),
            Tool(
                name: "scroll",
                description: "Scroll page or element.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "direction": .object(["type": .string("string"), "enum": .array([.string("up"), .string("down"), .string("left"), .string("right")])]),
                        "amount": .object(["type": .string("integer"), "description": .string("Pixels (default: viewport height)")]),
                        "uid": Self.uid, "selector": Self.sel, "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ]),
                    "required": .array([.string("direction")]),
                ])
            ),
            Tool(
                name: "press_key",
                description: "Press key combo (Enter, Tab, Meta+a, Control+c).",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "key": .object(["type": .string("string")]),
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ]),
                    "required": .array([.string("key")]),
                ])
            ),
            Tool(
                name: "hover",
                description: "Hover element to trigger tooltips/menus.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "uid": Self.uid, "selector": Self.sel, "text": Self.txt,
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ]),
                ])
            ),
            Tool(
                name: "drag",
                description: "Drag and drop between elements.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "fromUid": .object(["type": .string("string")]),
                        "toUid": .object(["type": .string("string")]),
                        "fromSelector": .object(["type": .string("string")]),
                        "toSelector": .object(["type": .string("string")]),
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ]),
                ])
            ),
            Tool(
                name: "handle_dialog",
                description: "Accept/dismiss alert, confirm, or prompt dialog.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "action": .object(["type": .string("string"), "enum": .array([.string("accept"), .string("dismiss")])]),
                        "promptText": .object(["type": .string("string"), "description": .string("Text for prompt dialog")]),
                        "tabId": Self.tab,
                    ]),
                    "required": .array([.string("action")]),
                ])
            ),

            // ── Capture ──────────────────────────────────────────────

            Tool(
                name: "screenshot",
                description: "Capture visible tab as PNG.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(["tabId": Self.tab]),
                ]),
                annotations: .init(readOnlyHint: true)
            ),
            Tool(
                name: "javascript_tool",
                description: "Execute JS in page context. Returns result.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "code": .object(["type": .string("string")]),
                        "tabId": Self.tab,
                    ]),
                    "required": .array([.string("code")]),
                ])
            ),
            Tool(
                name: "read_console",
                description: "Read captured console messages.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "level": .object(["type": .string("string"), "enum": .array([.string("all"), .string("log"), .string("warn"), .string("error"), .string("info"), .string("debug")])]),
                        "clear": .object(["type": .string("boolean")]),
                        "pattern": .object(["type": .string("string"), "description": .string("Regex filter")]),
                        "tabId": Self.tab,
                    ]),
                ]),
                annotations: .init(readOnlyHint: true)
            ),
            Tool(
                name: "read_network",
                description: "Read captured XHR/fetch requests.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "type": .object(["type": .string("string"), "enum": .array([.string("all"), .string("xhr"), .string("fetch")])]),
                        "clear": .object(["type": .string("boolean")]),
                        "tabId": Self.tab,
                    ]),
                ]),
                annotations: .init(readOnlyHint: true)
            ),

            // ── Utility ──────────────────────────────────────────────

            Tool(
                name: "resize_window",
                description: "Resize browser window.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "width": .object(["type": .string("integer")]),
                        "height": .object(["type": .string("integer")]),
                    ]),
                    "required": .array([.string("width"), .string("height")]),
                ])
            ),
            Tool(
                name: "wait",
                description: "Wait for duration, selector, or text to appear.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "seconds": .object(["type": .string("number")]),
                        "selector": Self.sel,
                        "text": Self.txt,
                        "timeout": .object(["type": .string("number"), "description": .string("Max seconds (default: 10)")]),
                        "tabId": Self.tab,
                    ]),
                ]),
                annotations: .init(readOnlyHint: true)
            ),
        ]
    }

    // MARK: - Tool Dispatch

    private func handleToolCall(_ params: CallTool.Parameters) async -> CallTool.Result {
        let args = params.arguments ?? [:]

        do {
            switch params.name {
            case "tabs_context":    return try await handleTabsContext()
            case "tabs_create":     return try await handleTabsCreate(args)
            case "close_tab":       return try await handleCloseTab(args)
            case "select_tab":      return try await handleSelectTab(args)
            case "navigate":        return try await handleNavigate(args)
            case "read_page":       return try await handleReadPage(args)
            case "snapshot":        return try await handleSnapshot(args)
            case "find":            return try await handleFind(args)
            case "click":           return try await handleInteraction("click", args)
            case "type_text":       return try await handleInteraction("type_text", args)
            case "form_input":      return try await handleFormInput(args)
            case "select_option":   return try await handleInteraction("select_option", args)
            case "scroll":          return try await handleInteraction("scroll", args)
            case "press_key":       return try await handleInteraction("press_key", args)
            case "hover":           return try await handleInteraction("hover", args)
            case "drag":            return try await handleInteraction("drag", args)
            case "handle_dialog":   return try await handleInteraction("handle_dialog", args)
            case "screenshot":      return try await handleScreenshot(args)
            case "javascript_tool": return try await handleJavaScript(args)
            case "read_console":    return try await handleReadConsole(args)
            case "read_network":    return try await handleReadNetwork(args)
            case "resize_window":   return try await handleResizeWindow(args)
            case "wait":            return try await handleWait(args)
            default:
                return CallTool.Result(
                    content: [Tool.Content.text("Unknown tool: \(params.name)")],
                    isError: true
                )
            }
        } catch {
            return CallTool.Result(
                content: [Tool.Content.text("\(error)")],
                isError: true
            )
        }
    }

    // MARK: - Tool Handlers

    private func handleTabsContext() async throws -> CallTool.Result {
        let response = try await bridge.send(action: "tabs_query")
        return textResult(response)
    }

    private func handleTabsCreate(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let url = args["url"]?.stringValue {
            guard let parsed = URL(string: url),
                  let scheme = parsed.scheme?.lowercased(),
                  Self.allowedURLSchemes.contains(scheme)
            else {
                return CallTool.Result(
                    content: [Tool.Content.text("Invalid URL or disallowed scheme. Only http, https, about, and file are allowed.")],
                    isError: true
                )
            }
            params["url"] = AnyCodable(url)
        }
        let response = try await bridge.send(action: "tabs_create", params: params)
        return textResult(response)
    }

    private func handleCloseTab(_ args: [String: Value]) async throws -> CallTool.Result {
        let tabId = args["tabId"]?.intValue ?? 0
        let response = try await bridge.send(action: "tabs_close", params: ["tabId": AnyCodable(tabId)])
        return textResult(response)
    }

    private func handleSelectTab(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        if let bringToFront = args["bringToFront"]?.boolValue { params["bringToFront"] = AnyCodable(bringToFront) }
        let response = try await bridge.send(action: "select_tab", params: params)
        return textResult(response)
    }

    private static let allowedURLSchemes: Set<String> = ["http", "https", "about", "file"]
    private static let allowedNavActions: Set<String> = ["goto", "back", "forward", "reload"]

    private func handleNavigate(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let url = args["url"]?.stringValue {
            guard let parsed = URL(string: url),
                  let scheme = parsed.scheme?.lowercased(),
                  Self.allowedURLSchemes.contains(scheme)
            else {
                return CallTool.Result(
                    content: [Tool.Content.text("Invalid URL or disallowed scheme. Only http, https, about, and file are allowed.")],
                    isError: true
                )
            }
            params["url"] = AnyCodable(url)
        }
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        if let action = args["action"]?.stringValue {
            guard Self.allowedNavActions.contains(action) else {
                return CallTool.Result(
                    content: [Tool.Content.text("Invalid navigation action: \(action). Use goto, back, forward, or reload.")],
                    isError: true
                )
            }
            params["action"] = AnyCodable(action)
        }
        let response = try await bridge.send(action: "navigate", params: params)
        return textResult(response)
    }

    private func handleReadPage(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        if let format = args["format"]?.stringValue { params["format"] = AnyCodable(format) }
        let response = try await bridge.send(action: "read_page", params: params)
        return textResult(response)
    }

    private func handleSnapshot(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        let response = try await bridge.send(action: "snapshot", params: params)
        return textResult(response)
    }

    private func handleFind(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let selector = args["selector"]?.stringValue { params["selector"] = AnyCodable(selector) }
        if let text = args["text"]?.stringValue { params["text"] = AnyCodable(text) }
        if let role = args["role"]?.stringValue { params["role"] = AnyCodable(role) }
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        let response = try await bridge.send(action: "find", params: params)
        return textResult(response)
    }

    /// Unified handler for interaction tools: click, type_text, hover, scroll, press_key, select_option, drag.
    /// Forwards all params to the extension and optionally appends a snapshot.
    private func handleInteraction(_ action: String, _ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        let wantSnapshot = args["includeSnapshot"]?.boolValue == true

        // Forward all value args (except includeSnapshot which is handled here)
        for (key, value) in args {
            if key == "includeSnapshot" || key == "tabId" { continue }
            if let s = value.stringValue { params[key] = AnyCodable(s) }
            else if let i = value.intValue { params[key] = AnyCodable(i) }
            else if let d = value.doubleValue { params[key] = AnyCodable(d) }
            else if let b = value.boolValue { params[key] = AnyCodable(b) }
        }
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }

        let response = try await bridge.send(action: action, params: params)

        if wantSnapshot && response.success {
            // Take a follow-up snapshot
            var snapParams: [String: AnyCodable] = [:]
            if let tabId = args["tabId"]?.intValue { snapParams["tabId"] = AnyCodable(tabId) }
            let snapResponse = try await bridge.send(action: "snapshot", params: snapParams)
            let actionText = response.data?.stringValue ?? "\(response.data ?? AnyCodable("OK"))"
            let snapText = snapResponse.data?.stringValue ?? "\(snapResponse.data ?? AnyCodable(""))"
            return CallTool.Result(content: [
                Tool.Content.text(actionText),
                Tool.Content.text("--- Page Snapshot ---\n\(snapText)"),
            ])
        }

        return textResult(response)
    }

    private func handleFormInput(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]

        // The fields argument may arrive as a Value.object or as a JSON string
        // (depending on how the MCP client serializes nested objects)
        var fieldDict: [String: String] = [:]
        if let fields = args["fields"]?.objectValue {
            for (key, val) in fields {
                if let s = val.stringValue {
                    fieldDict[key] = s
                } else if let i = val.intValue {
                    fieldDict[key] = String(i)
                } else if let d = val.doubleValue {
                    fieldDict[key] = String(d)
                } else if let b = val.boolValue {
                    fieldDict[key] = String(b)
                } else {
                    fieldDict[key] = "\(val)"
                }
            }
        } else if let fieldsStr = args["fields"]?.stringValue,
                  let data = fieldsStr.data(using: .utf8),
                  let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: String] {
            fieldDict = parsed
        }

        if !fieldDict.isEmpty {
            params["fields"] = AnyCodable(fieldDict)
        }
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        let response = try await bridge.send(action: "form_input", params: params)

        if args["includeSnapshot"]?.boolValue == true, response.success {
            var snapParams: [String: AnyCodable] = [:]
            if let tabId = args["tabId"]?.intValue { snapParams["tabId"] = AnyCodable(tabId) }
            let snapResponse = try await bridge.send(action: "snapshot", params: snapParams)
            let actionText = response.data?.stringValue ?? "OK"
            let snapText = snapResponse.data?.stringValue ?? ""
            return CallTool.Result(content: [
                Tool.Content.text(actionText),
                Tool.Content.text("--- Page Snapshot ---\n\(snapText)"),
            ])
        }

        return textResult(response)
    }

    private func handleScreenshot(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        let response = try await bridge.send(action: "screenshot", params: params)

        if response.success, let imageData = response.data?.stringValue {
            return CallTool.Result(content: [
                Tool.Content.image(data: imageData, mimeType: "image/png", metadata: nil),
            ])
        }
        return textResult(response)
    }

    private func handleJavaScript(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let code = args["code"]?.stringValue { params["code"] = AnyCodable(code) }
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        let response = try await bridge.send(action: "javascript_tool", params: params)
        return textResult(response)
    }

    private func handleReadConsole(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        if let level = args["level"]?.stringValue { params["level"] = AnyCodable(level) }
        if let clear = args["clear"]?.boolValue { params["clear"] = AnyCodable(clear) }
        if let pattern = args["pattern"]?.stringValue {
            guard pattern.count <= 200 else {
                return CallTool.Result(
                    content: [Tool.Content.text("Pattern too long (max 200 characters)")],
                    isError: true
                )
            }
            // Validate it's a valid regex
            guard (try? NSRegularExpression(pattern: pattern)) != nil else {
                return CallTool.Result(
                    content: [Tool.Content.text("Invalid regex pattern: \(pattern)")],
                    isError: true
                )
            }
            params["pattern"] = AnyCodable(pattern)
        }
        let response = try await bridge.send(action: "read_console", params: params)
        return textResult(response)
    }

    private func handleReadNetwork(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        if let type = args["type"]?.stringValue { params["type"] = AnyCodable(type) }
        if let clear = args["clear"]?.boolValue { params["clear"] = AnyCodable(clear) }
        let response = try await bridge.send(action: "read_network", params: params)
        return textResult(response)
    }

    private func handleResizeWindow(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let width = args["width"]?.intValue { params["width"] = AnyCodable(width) }
        if let height = args["height"]?.intValue { params["height"] = AnyCodable(height) }
        let response = try await bridge.send(action: "resize_window", params: params)
        return textResult(response)
    }

    private static let maxWaitSeconds: Double = 300 // 5-minute cap

    private func handleWait(_ args: [String: Value]) async throws -> CallTool.Result {
        if let seconds = args["seconds"]?.doubleValue, args["selector"] == nil, args["text"] == nil {
            let capped = min(seconds, Self.maxWaitSeconds)
            try await Task.sleep(for: .seconds(capped))
            return CallTool.Result(content: [Tool.Content.text("Waited \(capped) seconds")])
        }

        var params: [String: AnyCodable] = [:]
        if let selector = args["selector"]?.stringValue { params["selector"] = AnyCodable(selector) }
        if let text = args["text"]?.stringValue { params["text"] = AnyCodable(text) }
        let userTimeout = min(args["timeout"]?.doubleValue ?? 10, Self.maxWaitSeconds)
        params["timeout"] = AnyCodable(userTimeout)
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        // Extend bridge timeout to exceed the wait timeout so it doesn't race
        let response = try await bridge.send(action: "wait", params: params, timeout: userTimeout + 5)
        return textResult(response)
    }

    // MARK: - Helpers

    private func textResult(_ response: BridgeResponse) -> CallTool.Result {
        let text: String
        if let data = response.data {
            text = "\(data)"
        } else if let error = response.error {
            text = error
        } else {
            text = response.success ? "OK" : "Failed"
        }

        return CallTool.Result(
            content: [Tool.Content.text(text)],
            isError: !response.success
        )
    }
}
