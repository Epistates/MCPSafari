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
            version: "0.1.0",
            title: "Safari MCP Server",
            instructions: """
                Safari browser automation server. Controls Safari via a Web Extension bridge.
                The Safari MCP extension must be enabled in Safari for tools to function.
                Start by calling tabs_context to see open tabs, then use navigate, screenshot,
                and other tools to interact with web pages.
                Use snapshot to get an accessibility tree with element UIDs, then use those UIDs
                with click, type_text, hover, and other interaction tools.
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

    // MARK: - Shared Schema Fragments

    private static let tabIdSchema: Value = .object([
        "type": .string("integer"),
        "description": .string("Tab ID. Defaults to active tab."),
    ])

    private static let uidSchema: Value = .object([
        "type": .string("string"),
        "description": .string("Element UID from a snapshot. Preferred way to target elements."),
    ])

    private static let selectorSchema: Value = .object([
        "type": .string("string"),
        "description": .string("CSS selector to target an element."),
    ])

    private static let textSchema: Value = .object([
        "type": .string("string"),
        "description": .string("Visible text content to find the element."),
    ])

    private static let includeSnapshotSchema: Value = .object([
        "type": .string("boolean"),
        "description": .string("Return an accessibility snapshot after the action. Useful to see the updated page state."),
    ])

    // MARK: - Tool Definitions

    private func buildToolDefinitions() -> [Tool] {
        [
            // ── Tab Management ───────────────────────────────────────

            Tool(
                name: "tabs_context",
                description: "List all open Safari tabs with their IDs, URLs, and titles. Call this first to understand the browser state before taking actions.",
                inputSchema: .object(["type": .string("object"), "properties": .object([:])]),
                annotations: .init(title: "List Tabs", readOnlyHint: true, openWorldHint: false)
            ),
            Tool(
                name: "tabs_create",
                description: "Open a new tab in Safari. Optionally provide a URL to navigate to.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "url": .object(["type": .string("string"), "description": .string("URL to open. If omitted, opens a blank tab.")]),
                    ]),
                ]),
                annotations: .init(title: "Create Tab", readOnlyHint: false, destructiveHint: false)
            ),
            Tool(
                name: "close_tab",
                description: "Close a Safari tab by its ID.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(["tabId": Self.tabIdSchema]),
                    "required": .array([.string("tabId")]),
                ]),
                annotations: .init(title: "Close Tab", readOnlyHint: false, destructiveHint: true)
            ),

            Tool(
                name: "select_tab",
                description: "Select a tab as the default context for future tool calls. Avoids passing tabId on every call. Also brings the tab to the front.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "tabId": Self.tabIdSchema,
                        "bringToFront": .object(["type": .string("boolean"), "description": .string("Whether to focus the tab and its window. Defaults to true.")]),
                    ]),
                    "required": .array([.string("tabId")]),
                ]),
                annotations: .init(title: "Select Tab", readOnlyHint: true)
            ),

            // ── Navigation ───────────────────────────────────────────

            Tool(
                name: "navigate",
                description: "Navigate a tab to a URL, or go back/forward/reload.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "url": .object(["type": .string("string"), "description": .string("URL to navigate to.")]),
                        "tabId": Self.tabIdSchema,
                        "action": .object([
                            "type": .string("string"),
                            "enum": .array([.string("goto"), .string("back"), .string("forward"), .string("reload")]),
                            "description": .string("Navigation action. Defaults to 'goto'."),
                        ]),
                    ]),
                ]),
                annotations: .init(title: "Navigate", readOnlyHint: false, destructiveHint: false)
            ),

            // ── Page Reading ─────────────────────────────────────────

            Tool(
                name: "read_page",
                description: "Get page content as text, HTML, or accessibility snapshot.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "tabId": Self.tabIdSchema,
                        "format": .object([
                            "type": .string("string"),
                            "enum": .array([.string("text"), .string("html"), .string("snapshot")]),
                            "description": .string("Output format. Defaults to 'text'."),
                        ]),
                    ]),
                ]),
                annotations: .init(title: "Read Page", readOnlyHint: true)
            ),
            Tool(
                name: "get_page_text",
                description: "Get the visible text content of a page.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(["tabId": Self.tabIdSchema]),
                ]),
                annotations: .init(title: "Get Page Text", readOnlyHint: true)
            ),
            Tool(
                name: "snapshot",
                description: "Take an accessibility tree snapshot of the page. Returns a structured tree with element UIDs that can be used with click, type_text, hover, drag, and other interaction tools. Always use the latest snapshot — UIDs may change between snapshots.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(["tabId": Self.tabIdSchema]),
                ]),
                annotations: .init(title: "Take Snapshot", readOnlyHint: true)
            ),

            // ── Element Finding ──────────────────────────────────────

            Tool(
                name: "find",
                description: "Find elements on the page by CSS selector, text content, or ARIA role. Returns matching elements with UIDs.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "selector": Self.selectorSchema, "text": Self.textSchema,
                        "role": .object(["type": .string("string"), "description": .string("ARIA role to filter by (e.g., 'button', 'link', 'textbox').")]),
                        "tabId": Self.tabIdSchema,
                    ]),
                ]),
                annotations: .init(title: "Find Elements", readOnlyHint: true)
            ),

            // ── Input / Interaction ──────────────────────────────────

            Tool(
                name: "click",
                description: "Click on an element identified by UID (from snapshot), CSS selector, text content, or coordinates.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "uid": Self.uidSchema, "selector": Self.selectorSchema, "text": Self.textSchema,
                        "x": .object(["type": .string("number"), "description": .string("X coordinate to click at.")]),
                        "y": .object(["type": .string("number"), "description": .string("Y coordinate to click at.")]),
                        "doubleClick": .object(["type": .string("boolean"), "description": .string("Double-click instead of single click.")]),
                        "includeSnapshot": Self.includeSnapshotSchema, "tabId": Self.tabIdSchema,
                    ]),
                ]),
                annotations: .init(title: "Click", readOnlyHint: false, destructiveHint: false)
            ),
            Tool(
                name: "type_text",
                description: "Type text into a focused or specified element (by UID or CSS selector).",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "text": .object(["type": .string("string"), "description": .string("The text to type.")]),
                        "uid": Self.uidSchema, "selector": Self.selectorSchema,
                        "clearFirst": .object(["type": .string("boolean"), "description": .string("Clear existing content before typing.")]),
                        "submitKey": .object(["type": .string("string"), "description": .string("Key to press after typing (e.g., 'Enter', 'Tab').")]),
                        "includeSnapshot": Self.includeSnapshotSchema, "tabId": Self.tabIdSchema,
                    ]),
                    "required": .array([.string("text")]),
                ]),
                annotations: .init(title: "Type Text", readOnlyHint: false, destructiveHint: false)
            ),
            Tool(
                name: "form_input",
                description: "Fill multiple form fields at once. Accepts a map of CSS selectors to values.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "fields": .object([
                            "type": .string("object"),
                            "description": .string("Map of CSS selector → value to fill."),
                            "additionalProperties": .object(["type": .string("string")]),
                        ]),
                        "includeSnapshot": Self.includeSnapshotSchema, "tabId": Self.tabIdSchema,
                    ]),
                    "required": .array([.string("fields")]),
                ]),
                annotations: .init(title: "Fill Form", readOnlyHint: false, destructiveHint: false)
            ),
            Tool(
                name: "select_option",
                description: "Select an option in a <select> dropdown by UID, selector, value, or label.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "uid": Self.uidSchema, "selector": Self.selectorSchema,
                        "value": .object(["type": .string("string"), "description": .string("The option value to select.")]),
                        "label": .object(["type": .string("string"), "description": .string("The visible label text of the option.")]),
                        "includeSnapshot": Self.includeSnapshotSchema, "tabId": Self.tabIdSchema,
                    ]),
                ]),
                annotations: .init(title: "Select Option", readOnlyHint: false, destructiveHint: false)
            ),
            Tool(
                name: "scroll",
                description: "Scroll the page or a specific element.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "direction": .object([
                            "type": .string("string"),
                            "enum": .array([.string("up"), .string("down"), .string("left"), .string("right")]),
                            "description": .string("Scroll direction."),
                        ]),
                        "amount": .object(["type": .string("integer"), "description": .string("Pixels to scroll. Defaults to one viewport height.")]),
                        "uid": Self.uidSchema, "selector": Self.selectorSchema, "includeSnapshot": Self.includeSnapshotSchema, "tabId": Self.tabIdSchema,
                    ]),
                    "required": .array([.string("direction")]),
                ]),
                annotations: .init(title: "Scroll", readOnlyHint: false, destructiveHint: false, idempotentHint: false)
            ),
            Tool(
                name: "press_key",
                description: "Press a key or key combination (e.g., 'Enter', 'Tab', 'Meta+a', 'Control+c').",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "key": .object(["type": .string("string"), "description": .string("Key or combination to press.")]),
                        "includeSnapshot": Self.includeSnapshotSchema, "tabId": Self.tabIdSchema,
                    ]),
                    "required": .array([.string("key")]),
                ]),
                annotations: .init(title: "Press Key", readOnlyHint: false, destructiveHint: false)
            ),
            Tool(
                name: "hover",
                description: "Hover over an element to trigger hover states, tooltips, or menus.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "uid": Self.uidSchema, "selector": Self.selectorSchema, "text": Self.textSchema,
                        "includeSnapshot": Self.includeSnapshotSchema, "tabId": Self.tabIdSchema,
                    ]),
                ]),
                annotations: .init(title: "Hover", readOnlyHint: false, destructiveHint: false)
            ),
            Tool(
                name: "drag",
                description: "Drag an element and drop it onto another element.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "fromUid": .object(["type": .string("string"), "description": .string("UID of the element to drag (from snapshot).")]),
                        "toUid": .object(["type": .string("string"), "description": .string("UID of the element to drop onto (from snapshot).")]),
                        "fromSelector": .object(["type": .string("string"), "description": .string("CSS selector of the element to drag.")]),
                        "toSelector": .object(["type": .string("string"), "description": .string("CSS selector of the element to drop onto.")]),
                        "includeSnapshot": Self.includeSnapshotSchema, "tabId": Self.tabIdSchema,
                    ]),
                ]),
                annotations: .init(title: "Drag & Drop", readOnlyHint: false, destructiveHint: false)
            ),

            // ── Dialogs ──────────────────────────────────────────────

            Tool(
                name: "handle_dialog",
                description: "Accept or dismiss a browser dialog (alert, confirm, prompt). Use when a page triggers a dialog that blocks interaction.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "action": .object([
                            "type": .string("string"),
                            "enum": .array([.string("accept"), .string("dismiss")]),
                            "description": .string("Whether to accept or dismiss the dialog."),
                        ]),
                        "promptText": .object(["type": .string("string"), "description": .string("Text to enter into a prompt dialog before accepting.")]),
                        "tabId": Self.tabIdSchema,
                    ]),
                    "required": .array([.string("action")]),
                ]),
                annotations: .init(title: "Handle Dialog", readOnlyHint: false)
            ),

            // ── Screenshots ──────────────────────────────────────────

            Tool(
                name: "screenshot",
                description: "Capture a screenshot of the visible area of a tab. Returns a PNG image.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(["tabId": Self.tabIdSchema]),
                ]),
                annotations: .init(title: "Screenshot", readOnlyHint: true)
            ),

            // ── JavaScript ───────────────────────────────────────────

            Tool(
                name: "javascript_tool",
                description: "Execute JavaScript code in the context of a page. Returns the result of the expression.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "code": .object(["type": .string("string"), "description": .string("JavaScript code to execute.")]),
                        "tabId": Self.tabIdSchema,
                    ]),
                    "required": .array([.string("code")]),
                ]),
                annotations: .init(title: "Execute JavaScript", readOnlyHint: false, destructiveHint: false, openWorldHint: true)
            ),

            // ── Console ──────────────────────────────────────────────

            Tool(
                name: "read_console",
                description: "Read captured console messages (log, warn, error, info, debug) from the page.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "tabId": Self.tabIdSchema,
                        "level": .object([
                            "type": .string("string"),
                            "enum": .array([.string("all"), .string("log"), .string("warn"), .string("error"), .string("info"), .string("debug")]),
                            "description": .string("Filter by log level. Defaults to 'all'."),
                        ]),
                        "clear": .object(["type": .string("boolean"), "description": .string("Clear the message buffer after reading.")]),
                        "pattern": .object(["type": .string("string"), "description": .string("Regex pattern to filter messages.")]),
                    ]),
                ]),
                annotations: .init(title: "Read Console", readOnlyHint: true, openWorldHint: false)
            ),

            // ── Network ──────────────────────────────────────────────

            Tool(
                name: "read_network",
                description: "Read captured network requests from the page. Shows method, URL, status, and timing.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "tabId": Self.tabIdSchema,
                        "type": .object([
                            "type": .string("string"),
                            "enum": .array([.string("all"), .string("xhr"), .string("fetch"), .string("document"), .string("script"), .string("stylesheet"), .string("image")]),
                            "description": .string("Filter by request type. Defaults to 'all'."),
                        ]),
                        "clear": .object(["type": .string("boolean"), "description": .string("Clear the request buffer after reading.")]),
                    ]),
                ]),
                annotations: .init(title: "Read Network", readOnlyHint: true, openWorldHint: false)
            ),

            // ── Window ───────────────────────────────────────────────

            Tool(
                name: "resize_window",
                description: "Resize the browser window.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "width": .object(["type": .string("integer"), "description": .string("Window width in pixels.")]),
                        "height": .object(["type": .string("integer"), "description": .string("Window height in pixels.")]),
                    ]),
                    "required": .array([.string("width"), .string("height")]),
                ]),
                annotations: .init(title: "Resize Window", readOnlyHint: false, destructiveHint: false, idempotentHint: true)
            ),

            // ── Wait ─────────────────────────────────────────────────

            Tool(
                name: "wait",
                description: "Wait for a specified duration or until a condition is met on the page.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "seconds": .object(["type": .string("number"), "description": .string("Number of seconds to wait.")]),
                        "selector": Self.selectorSchema,
                        "text": Self.textSchema,
                        "timeout": .object(["type": .string("number"), "description": .string("Maximum seconds to wait for selector/text. Defaults to 10.")]),
                        "tabId": Self.tabIdSchema,
                    ]),
                ]),
                annotations: .init(title: "Wait", readOnlyHint: true)
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
            case "get_page_text":   return try await handleGetPageText(args)
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

    private func handleGetPageText(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        let response = try await bridge.send(action: "get_page_text", params: params)
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
