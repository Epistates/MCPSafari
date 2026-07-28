import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import Logging
import MCP

struct RunStep: Equatable, Sendable {
    let tool: String
    let arguments: [String: Value]
}

struct RunStepsPlan: Equatable, Sendable {
    static let allowedTools: Set<String> = [
        "navigate", "click", "type_text", "form_input", "select_option",
        "press_key", "hover", "scroll", "drag", "wait",
    ]
    static let maxSteps = 10
    static let maxTimeout = 60.0

    let steps: [RunStep]
    let timeout: Double

    init(arguments: [String: Value]) throws {
        guard arguments["_batchDeadline"] == nil else {
            throw RunStepsInputError("_batchDeadline is reserved for internal use")
        }
        guard let values = arguments["steps"]?.arrayValue, !values.isEmpty else {
            throw RunStepsInputError("steps must contain at least one step")
        }
        guard values.count <= Self.maxSteps else {
            throw RunStepsInputError("steps cannot contain more than \(Self.maxSteps) steps")
        }

        let batchTabId = arguments["tabId"]
        if let batchTabId, batchTabId.intValue == nil {
            throw RunStepsInputError("tabId must be an integer")
        }

        steps = try values.enumerated().map { index, value in
            guard let object = value.objectValue else {
                throw RunStepsInputError("steps[\(index)] must be an object")
            }
            guard let tool = object["tool"]?.stringValue, !tool.isEmpty else {
                throw RunStepsInputError("steps[\(index)].tool must be a non-empty string")
            }
            guard Self.allowedTools.contains(tool) else {
                throw RunStepsInputError("steps[\(index)].tool does not support \(tool)")
            }

            let suppliedArguments = object["arguments"]
            if let suppliedArguments, suppliedArguments.objectValue == nil {
                throw RunStepsInputError("steps[\(index)].arguments must be an object")
            }
            var stepArguments = suppliedArguments?.objectValue ?? [:]
            guard stepArguments["_batchDeadline"] == nil else {
                throw RunStepsInputError("steps[\(index)].arguments._batchDeadline is reserved for internal use")
            }
            for key in ["trace", "traceDuration", "eventTypes", "includeSnapshot"] where stepArguments[key] != nil {
                throw RunStepsInputError("steps[\(index)].arguments.\(key) must be set on run_steps instead")
            }
            if let tabId = stepArguments["tabId"], tabId.intValue == nil {
                throw RunStepsInputError("steps[\(index)].arguments.tabId must be an integer")
            }
            if stepArguments["tabId"] == nil, let batchTabId {
                stepArguments["tabId"] = batchTabId
            }
            return RunStep(tool: tool, arguments: stepArguments)
        }

        if let timeoutValue = arguments["timeout"], SafariMCPServer.numberValue(timeoutValue) == nil {
            throw RunStepsInputError("timeout must be a number")
        }
        timeout = max(0.1, min(SafariMCPServer.numberValue(arguments["timeout"]) ?? 60, Self.maxTimeout))
    }
}

struct RunStepsInputError: Error, CustomStringConvertible, Equatable {
    let description: String

    init(_ description: String) {
        self.description = description
    }
}

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
            version: MCPSafariProduct.version,
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
                return Self.failureResult(
                    ToolFailure(
                        code: "server_shutting_down",
                        message: "Server shutting down",
                        retryable: true,
                        recoveryAction: "retry"
                    )
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
    private static let waitSel: Value = .object(["type": .string("string"), "description": .string("Wait for CSS selector after action")])
    private static let waitTxt: Value = .object(["type": .string("string"), "description": .string("Wait for visible text after action")])
    private static let waitTimeout: Value = .object(["type": .string("number"), "description": .string("Post-action wait timeout seconds (default: 10)")])
    private static let trace: Value = .object(["type": .string("boolean"), "description": .string("Capture page trace events during and shortly after action")])
    private static let traceDuration: Value = .object(["type": .string("number"), "description": .string("Seconds to continue trace capture after action and waits (default: 2, max: 30)")])
    private static let eventTypes: Value = .object([
        "type": .string("array"),
        "items": .object(["type": .string("string"), "minLength": .int(1)]),
        "description": .string("Exact trace event types to capture (for example dom.mutation, network.fetch, console.error); omitted captures all"),
    ])
    private static let filePath: Value = .object(["type": .string("string"), "description": .string("Local file path (~ expanded)")])
    private static let filePaths: Value = .object([
        "type": .string("array"),
        "items": .object(["type": .string("string"), "minLength": .int(1)]),
        "description": .string("Local file paths, up to \(FileAttachmentLoader.maxFileCount) and \(FileAttachmentLoader.maxTotalBytes / (1024 * 1024)) MB per call"),
    ])
    private static let mimeType: Value = .object(["type": .string("string"), "description": .string("Override the MIME type inferred from the file extension")])
    private static let fileInputKeys: Set<String> = ["filePath", "filePaths", "mimeType"]
    private static let postActionWaitKeys: Set<String> = ["waitForSelector", "waitForText", "waitTimeout"]
    private static let postActionTraceKeys: Set<String> = ["trace", "traceDuration", "eventTypes"]
    private static let actionControlKeys: Set<String> = postActionWaitKeys
        .union(postActionTraceKeys)
        .union(["_batchDeadline"])

    private static func withPostActionWait(_ properties: [String: Value]) -> [String: Value] {
        var props = properties
        props["waitForSelector"] = Self.waitSel
        props["waitForText"] = Self.waitTxt
        props["waitTimeout"] = Self.waitTimeout
        return props
    }

    private static func withActionOptions(_ properties: [String: Value]) -> [String: Value] {
        var props = Self.withPostActionWait(properties)
        props["trace"] = Self.trace
        props["traceDuration"] = Self.traceDuration
        props["eventTypes"] = Self.eventTypes
        return props
    }

    private static func textContent(_ text: String) -> Tool.Content {
        .text(text: text, annotations: nil, _meta: nil)
    }

    private static func imageContent(data: String, mimeType: String) -> Tool.Content {
        .image(data: data, mimeType: mimeType, annotations: nil, _meta: nil)
    }

    // MARK: - Tool Definitions

    private func buildToolDefinitions() -> [Tool] {
        [
            Tool(
                name: "status",
                description: "Report local Safari MCP listener, authentication, version, and token health. Works without an extension connection.",
                inputSchema: .object(["type": .string("object"), "properties": .object([:])]),
                annotations: .init(readOnlyHint: true, openWorldHint: false)
            ),

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
                description: "Pin a tab as default context for future calls. Activates and focuses the tab unless bringToFront is false.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "tabId": Self.tab,
                        "bringToFront": .object(["type": .string("boolean"), "description": .string("Activate and focus the tab (default: true)")]),
                    ]),
                    "required": .array([.string("tabId")]),
                ])
            ),

            // ── Navigation ───────────────────────────────────────────

            Tool(
                name: "navigate",
                description: "Go to URL or back/forward/reload.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(Self.withPostActionWait([
                        "url": .object(["type": .string("string")]),
                        "action": .object(["type": .string("string"), "enum": .array([.string("goto"), .string("back"), .string("forward"), .string("reload")])]),
                        "includeSnapshot": Self.snap,
                        "tabId": Self.tab,
                    ])),
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
                description: "Find elements by selector, visible text or accessible name, or ARIA role. Returns up to 50 UIDs.",
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
                    "properties": .object(Self.withActionOptions([
                        "uid": Self.uid, "selector": Self.sel, "text": Self.txt,
                        "x": .object(["type": .string("number")]),
                        "y": .object(["type": .string("number")]),
                        "doubleClick": .object(["type": .string("boolean")]),
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ])),
                ])
            ),
            Tool(
                name: "type_text",
                description: "Type into element. Set native=true for real macOS key events in editors that depend on keyboard input.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(Self.withActionOptions([
                        "text": .object(["type": .string("string")]),
                        "uid": Self.uid, "selector": Self.sel,
                        "clearFirst": .object(["type": .string("boolean")]),
                        "native": .object([
                            "type": .string("boolean"),
                            "description": .string("Use real macOS key events; requires Safari to already be the frontmost application and Accessibility permission"),
                        ]),
                        "submitKey": .object(["type": .string("string"), "description": .string("Key after typing (Enter, Tab)")]),
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ])),
                    "required": .array([.string("text")]),
                ])
            ),
            Tool(
                name: "form_input",
                description: "Batch fill form fields. React-compatible.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(Self.withActionOptions([
                        "fields": .object([
                            "type": .string("object"),
                            "description": .string("CSS selector → value map"),
                            "additionalProperties": .object(["type": .string("string")]),
                        ]),
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ])),
                    "required": .array([.string("fields")]),
                ])
            ),
            Tool(
                name: "select_option",
                description: "Select dropdown option by value or label.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(Self.withActionOptions([
                        "uid": Self.uid, "selector": Self.sel,
                        "value": .object(["type": .string("string")]),
                        "label": .object(["type": .string("string")]),
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ])),
                ])
            ),
            Tool(
                name: "scroll",
                description: "Scroll page or element.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(Self.withActionOptions([
                        "direction": .object(["type": .string("string"), "enum": .array([.string("up"), .string("down"), .string("left"), .string("right")])]),
                        "amount": .object(["type": .string("integer"), "description": .string("Pixels (default: viewport height)")]),
                        "uid": Self.uid, "selector": Self.sel, "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ])),
                    "required": .array([.string("direction")]),
                ])
            ),
            Tool(
                name: "press_key",
                description: "Press key combo (Enter, Tab, Meta+a, Control+c).",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(Self.withActionOptions([
                        "key": .object(["type": .string("string")]),
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ])),
                    "required": .array([.string("key")]),
                ])
            ),
            Tool(
                name: "hover",
                description: "Hover element to trigger tooltips/menus.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(Self.withActionOptions([
                        "uid": Self.uid, "selector": Self.sel, "text": Self.txt,
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ])),
                ])
            ),
            Tool(
                name: "drag",
                description: "Drag and drop between elements.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(Self.withActionOptions([
                        "fromUid": .object(["type": .string("string")]),
                        "toUid": .object(["type": .string("string")]),
                        "fromSelector": .object(["type": .string("string")]),
                        "toSelector": .object(["type": .string("string")]),
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ])),
                ])
            ),
            Tool(
                name: "upload_file",
                description: "Attach local files to a file input.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(Self.withActionOptions([
                        "uid": Self.uid, "selector": Self.sel,
                        "filePath": Self.filePath, "filePaths": Self.filePaths, "mimeType": Self.mimeType,
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ])),
                ])
            ),
            Tool(
                name: "drop_file",
                description: "Drop local files onto an element (dragenter/dragover/drop).",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(Self.withActionOptions([
                        "uid": Self.uid, "selector": Self.sel,
                        "filePath": Self.filePath, "filePaths": Self.filePaths, "mimeType": Self.mimeType,
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ])),
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
                description: "Execute JS in page context. Returns expression results.",
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
                name: "run_steps",
                description: "Run up to 10 interaction or wait steps sequentially. Stops on the first failure; completed actions are not rolled back.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "tabId": Self.tab,
                        "steps": .object([
                            "type": .string("array"),
                            "minItems": .int(1),
                            "maxItems": .int(RunStepsPlan.maxSteps),
                            "items": .object([
                                "type": .string("object"),
                                "properties": .object([
                                    "tool": .object([
                                        "type": .string("string"),
                                        "enum": .array(RunStepsPlan.allowedTools.sorted().map(Value.string)),
                                    ]),
                                    "arguments": .object([
                                        "type": .string("object"),
                                        "additionalProperties": .bool(true),
                                    ]),
                                ]),
                                "required": .array([.string("tool")]),
                            ]),
                        ]),
                        "timeout": .object([
                            "type": .string("number"),
                            "description": .string("Total batch deadline in seconds (default and max: 60)"),
                            "minimum": .double(0.1),
                            "maximum": .double(RunStepsPlan.maxTimeout),
                        ]),
                        "trace": Self.trace,
                        "traceDuration": Self.traceDuration,
                        "eventTypes": Self.eventTypes,
                        "includeSnapshot": Self.snap,
                    ]),
                    "required": .array([.string("steps")]),
                ]),
                annotations: .init(readOnlyHint: false)
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
            case "status":          return try await handleStatus()
            case "tabs_context":    return try await handleTabsContext()
            case "tabs_create":     return try await handleTabsCreate(args)
            case "close_tab":       return try await handleCloseTab(args)
            case "select_tab":      return try await handleSelectTab(args)
            case "navigate":        return try await handleNavigate(args)
            case "read_page":       return try await handleReadPage(args)
            case "snapshot":        return try await handleSnapshot(args)
            case "find":            return try await handleFind(args)
            case "click":           return try await handleInteraction("click", args)
            case "type_text":       return try await handleTypeText(args)
            case "form_input":      return try await handleFormInput(args)
            case "select_option":   return try await handleInteraction("select_option", args)
            case "scroll":          return try await handleInteraction("scroll", args)
            case "press_key":       return try await handleInteraction("press_key", args)
            case "hover":           return try await handleInteraction("hover", args)
            case "drag":            return try await handleInteraction("drag", args)
            case "upload_file":     return try await handleFileAction("upload_file", args)
            case "drop_file":       return try await handleFileAction("drop_file", args)
            case "handle_dialog":   return try await handleInteraction("handle_dialog", args)
            case "screenshot":      return try await handleScreenshot(args)
            case "javascript_tool": return try await handleJavaScript(args)
            case "read_console":    return try await handleReadConsole(args)
            case "read_network":    return try await handleReadNetwork(args)
            case "resize_window":   return try await handleResizeWindow(args)
            case "run_steps":       return try await handleRunSteps(args)
            case "wait":            return try await handleWait(args)
            default:
                return Self.failureResult(
                    ToolFailure(
                        code: "unknown_tool",
                        message: "Unknown tool: \(params.name)",
                        retryable: false,
                        recoveryAction: "list_tools"
                    )
                )
            }
        } catch {
            return Self.failureResult(toolFailure(for: error))
        }
    }

    // MARK: - Tool Handlers

    private func handleStatus() async throws -> CallTool.Result {
        let status = await bridge.status()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(status)
        return CallTool.Result(content: [Self.textContent(String(decoding: data, as: UTF8.self))])
    }

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
                    content: [Self.textContent("Invalid URL or disallowed scheme. Only http, https, about, and file are allowed.")],
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
    private static let allowedPageFormats: Set<String> = ["text", "html", "snapshot"]
    private static let allowedConsoleLevels: Set<String> = ["all", "log", "warn", "error", "info", "debug"]
    private static let allowedNetworkTypes: Set<String> = ["all", "xhr", "fetch"]

    private func handleNavigate(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let url = args["url"]?.stringValue {
            guard let parsed = URL(string: url),
                  let scheme = parsed.scheme?.lowercased(),
                  Self.allowedURLSchemes.contains(scheme)
            else {
                return CallTool.Result(
                    content: [Self.textContent("Invalid URL or disallowed scheme. Only http, https, about, and file are allowed.")],
                    isError: true
                )
            }
            params["url"] = AnyCodable(url)
        }
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        if let action = args["action"]?.stringValue {
            guard Self.allowedNavActions.contains(action) else {
                return CallTool.Result(
                    content: [Self.textContent("Invalid navigation action: \(action). Use goto, back, forward, or reload.")],
                    isError: true
                )
            }
            params["action"] = AnyCodable(action)
        }
        let response = try await bridge.send(
            action: "navigate",
            params: params,
            timeout: Self.bridgeTimeout(args)
        )
        return try await resultAfterAction(response, args)
    }

    private func handleReadPage(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        if let format = args["format"]?.stringValue {
            guard Self.allowedPageFormats.contains(format) else {
                return CallTool.Result(
                    content: [Self.textContent("Invalid page format: \(format). Use text, html, or snapshot.")],
                    isError: true
                )
            }
            params["format"] = AnyCodable(format)
        }
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

    /// Reads the caller's local files, then runs the interaction with them attached.
    private func handleFileAction(_ action: String, _ args: [String: Value]) async throws -> CallTool.Result {
        var paths: [String] = []
        if let filePath = args["filePath"] {
            guard let path = filePath.stringValue else { throw ToolInputError("filePath must be a string") }
            paths.append(path)
        }
        if let filePaths = args["filePaths"] {
            guard let values = filePaths.arrayValue else { throw ToolInputError("filePaths must be an array of strings") }
            for value in values {
                guard let path = value.stringValue else { throw ToolInputError("filePaths must be an array of strings") }
                paths.append(path)
            }
        }

        var mimeTypeOverride: String?
        if let mimeType = args["mimeType"] {
            guard let value = mimeType.stringValue else { throw ToolInputError("mimeType must be a string") }
            mimeTypeOverride = value
        }

        let attachments: [FileAttachment]
        do {
            attachments = try FileAttachmentLoader.load(paths: paths, mimeTypeOverride: mimeTypeOverride)
        } catch let error as FileAttachmentError {
            throw ToolInputError(error.description)
        }

        let files = attachments.map { attachment in
            AnyCodable([
                "name": AnyCodable(attachment.name),
                "type": AnyCodable(attachment.mimeType),
                "data": AnyCodable(attachment.base64),
            ] as [String: AnyCodable])
        }

        return try await handleInteraction(
            action,
            args,
            extraParams: ["files": AnyCodable(files)],
            skipKeys: Self.fileInputKeys
        )
    }

    /// Unified handler for interaction tools: click, type_text, hover, scroll, press_key, select_option, drag.
    /// Forwards all params to the extension and optionally appends a snapshot.
    private func handleInteraction(
        _ action: String,
        _ args: [String: Value],
        extraParams: [String: AnyCodable] = [:],
        skipKeys: Set<String> = []
    ) async throws -> CallTool.Result {
        var params = interactionParams(args, skipKeys: skipKeys)
        let wantSnapshot = args["includeSnapshot"]?.boolValue == true

        // Server-supplied params win over forwarded caller args.
        params.merge(extraParams) { _, supplied in supplied }

        let traceSession = try await startTraceIfNeeded(args)
        do {
            let response = try await bridge.send(
                action: action,
                params: params,
                timeout: Self.bridgeTimeout(args)
            )
            return try await resultAfterAction(response, args, wantSnapshot: wantSnapshot, traceSession: traceSession)
        } catch {
            if let traceSession {
                _ = try? await stopTraceResponse(traceSession, args, waitForDuration: false)
            }
            throw error
        }
    }

    private func interactionParams(_ args: [String: Value], skipKeys: Set<String> = []) -> [String: AnyCodable] {
        var params: [String: AnyCodable] = [:]
        for (key, value) in args {
            if key == "includeSnapshot" || key == "tabId" || Self.actionControlKeys.contains(key) { continue }
            if skipKeys.contains(key) { continue }
            if let s = value.stringValue { params[key] = AnyCodable(s) }
            else if let i = value.intValue { params[key] = AnyCodable(i) }
            else if let d = value.doubleValue { params[key] = AnyCodable(d) }
            else if let b = value.boolValue { params[key] = AnyCodable(b) }
        }
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        return params
    }

    private func handleTypeText(_ args: [String: Value]) async throws -> CallTool.Result {
        if let native = args["native"], native.boolValue == nil {
            throw ToolInputError("native must be a boolean")
        }
        guard args["native"]?.boolValue == true else {
            return try await handleInteraction("type_text", args)
        }
        return try await handleNativeTypeText(args)
    }

    private func handleNativeTypeText(_ args: [String: Value]) async throws -> CallTool.Result {
        let input = try Self.nativeInputPlan(args)
        let traceSession = try await startTraceIfNeeded(args)
        do {
            let preparation = try await bridge.send(
                action: "native_type_text",
                params: interactionParams(args),
                timeout: Self.bridgeTimeout(args)
            )
            guard preparation.success else {
                return try await resultAfterAction(preparation, args, traceSession: traceSession)
            }

            let message = try Self.typeNativeText(
                input,
                deadline: Self.numberValue(args["_batchDeadline"])
            )
            let response = BridgeResponse(
                id: preparation.id,
                success: true,
                data: AnyCodable(message),
                error: nil,
                errorCode: nil,
                retryable: nil,
                recoveryAction: nil
            )
            return try await resultAfterAction(response, args, traceSession: traceSession)
        } catch {
            if let traceSession {
                _ = try? await stopTraceResponse(traceSession, args, waitForDuration: false)
            }
            throw error
        }
    }

    private struct NativeInputError: Error {
        let failure: ToolFailure
    }

    private struct NativeInputPlan {
        let text: String
        let clearFirst: Bool
        let submitKey: String?
        let submitKeyCode: CGKeyCode?
    }

    private nonisolated static func nativeInputPlan(_ args: [String: Value]) throws -> NativeInputPlan {
        guard let text = args["text"]?.stringValue else {
            throw ToolInputError("text is required")
        }
        if let clearFirst = args["clearFirst"], clearFirst.boolValue == nil {
            throw ToolInputError("clearFirst must be a boolean")
        }
        if let submitKey = args["submitKey"], submitKey.stringValue == nil {
            throw ToolInputError("submitKey must be a string")
        }

        let submitKey = args["submitKey"]?.stringValue
        let submitKeyCode = try nativeSubmitKeyCode(for: submitKey)
        guard AXIsProcessTrusted() else {
            throw NativeInputError(failure: ToolFailure(
                code: "native_input_permission_required",
                message: "Native typing requires Accessibility permission for the app running mcp-safari (Codex, Claude, or your terminal). Enable that app in System Settings > Privacy & Security > Accessibility. Standard typing works without this permission.",
                retryable: false,
                recoveryAction: "grant_accessibility_to_mcp_client"
            ))
        }

        return NativeInputPlan(
            text: text,
            clearFirst: args["clearFirst"]?.boolValue == true,
            submitKey: submitKey,
            submitKeyCode: submitKeyCode
        )
    }

    private nonisolated static func typeNativeText(
        _ input: NativeInputPlan,
        deadline: Double? = nil
    ) throws -> String {
        func checkDeadline() throws {
            guard let deadline, ProcessInfo.processInfo.systemUptime >= deadline else { return }
            throw NativeInputError(failure: ToolFailure(
                code: "batch_timeout",
                message: "run_steps reached its deadline during native typing. Input may be partial.",
                retryable: false,
                recoveryAction: "inspect_batch_result"
            ))
        }

        try checkDeadline()
        try ensureSafariIsFrontmost()
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            throw nativeInputUnavailable("macOS could not create a native keyboard event.")
        }

        if input.clearFirst {
            try checkDeadline()
            try postKey(code: 0, flags: .maskCommand, source: source)
            try checkDeadline()
            try postKey(code: 51, source: source)
        }
        for character in input.text {
            try checkDeadline()
            try postText(String(character), source: source)
        }
        if let submitKeyCode = input.submitKeyCode {
            try checkDeadline()
            try postKey(code: submitKeyCode, source: source)
        }
        // One check before and one after typing: a per-keystroke re-check
        // would abort mid-word on any transient focus blip without saying
        // how much was delivered.
        try ensureSafariIsFrontmost(afterTyping: true)

        let suffix = input.submitKey.map { " then pressed \($0)" } ?? ""
        return "Typed \(input.text.count) character(s) with native input\(suffix)"
    }

    private nonisolated static func nativeSubmitKeyCode(for key: String?) throws -> CGKeyCode? {
        guard let key else { return nil }
        switch key.lowercased() {
        case "enter", "return": return 36
        case "tab": return 48
        default: throw ToolInputError("Native submitKey does not support \(key). Use Enter, Return, or Tab.")
        }
    }

    private nonisolated static func ensureSafariIsFrontmost(afterTyping: Bool = false) throws {
        // NSWorkspace.frontmostApplication freezes at first touch in this
        // run-loop-less process; a fresh fetch reads current state.
        let safariIsActive = NSRunningApplication
            .runningApplications(withBundleIdentifier: "com.apple.Safari")
            .contains { $0.isActive }
        guard safariIsActive else {
            throw NativeInputError(failure: ToolFailure(
                code: "native_input_focus_lost",
                message: afterTyping
                    ? "Safari lost focus during native typing. Some keystrokes may have gone to another application; verify the target and retry."
                    : "Safari is not the frontmost application. Native key events go to whichever app has focus; activate Safari and retry. Nothing was typed.",
                retryable: true,
                recoveryAction: "retry"
            ))
        }
    }

    private nonisolated static func nativeInputUnavailable(_ message: String) -> NativeInputError {
        NativeInputError(failure: ToolFailure(
            code: "native_input_unavailable",
            message: message,
            retryable: false,
            recoveryAction: "inspect_error"
        ))
    }

    private nonisolated static func postText(_ text: String, source: CGEventSource) throws {
        let utf16 = Array(text.utf16)
        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
        else {
            throw nativeInputUnavailable("macOS could not create a native keyboard event.")
        }
        utf16.withUnsafeBufferPointer { buffer in
            keyDown.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            keyUp.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
        }
        keyDown.post(tap: .cgSessionEventTap)
        keyUp.post(tap: .cgSessionEventTap)
        Thread.sleep(forTimeInterval: 0.005)
    }

    private nonisolated static func postKey(
        code: CGKeyCode,
        flags: CGEventFlags = [],
        source: CGEventSource
    ) throws {
        guard let keyDown = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let keyUp = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
        else {
            throw nativeInputUnavailable("macOS could not create a native keyboard event.")
        }
        keyDown.flags = flags
        keyUp.flags = flags
        keyDown.post(tap: .cgSessionEventTap)
        keyUp.post(tap: .cgSessionEventTap)
        Thread.sleep(forTimeInterval: 0.005)
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

        guard !fieldDict.isEmpty else {
            return CallTool.Result(
                content: [Self.textContent("fields must contain at least one CSS selector and value")],
                isError: true
            )
        }

        params["fields"] = AnyCodable(fieldDict)
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        let traceSession = try await startTraceIfNeeded(args)
        do {
            let response = try await bridge.send(
                action: "form_input",
                params: params,
                timeout: Self.bridgeTimeout(args)
            )
            return try await resultAfterAction(response, args, traceSession: traceSession)
        } catch {
            if let traceSession {
                _ = try? await stopTraceResponse(traceSession, args, waitForDuration: false)
            }
            throw error
        }
    }

    private func handleScreenshot(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        let response = try await bridge.send(action: "screenshot", params: params)

        guard response.success, let raw = response.data?.stringValue else {
            return textResult(response)
        }

        // Current extensions send the image plus its capture context; older
        // ones send the base64 image on its own.
        let capture = Self.decodeCapture(raw)
        let imageData = capture?["image"]?.stringValue ?? raw

        if let failure = Self.captureFailure(imageData) {
            return Self.failureResult(failure)
        }

        var content: [Tool.Content] = [
            Self.imageContent(data: imageData, mimeType: "image/png"),
        ]
        if let capture, let note = Self.captureNote(capture) {
            content.append(Self.textContent(note))
        }
        return CallTool.Result(content: content)
    }

    /// Safari resolves a failed capture to an empty or non-image payload, and
    /// the extension forwards whatever it gets. Emitting that as base64 image
    /// content makes the whole tool result unparseable for the client, which
    /// reads as "this tool is broken" rather than as a recoverable failure.
    static func captureFailure(_ image: String) -> ToolFailure? {
        // Every extension version asks captureVisibleTab for PNG, so anything
        // without the signature is a failed capture rather than another format.
        let bytes = Data(base64Encoded: image)
        if let bytes, bytes.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
            return nil
        }

        // debugDescription quotes and escapes the prefix, so an HTML or data-URL
        // payload cannot break the error message across lines.
        let head = String(image.prefix(48)).debugDescription
        let payload: String
        if image.isEmpty {
            payload = "an empty payload"
        } else if bytes == nil {
            payload = "\(image.utf8.count) bytes that are not base64: \(head)"
        } else {
            payload = "\(image.utf8.count) base64 bytes with no PNG signature: \(head)"
        }
        return ToolFailure(
            code: "internal_error",
            message: "Safari returned \(payload) instead of PNG image data. "
                + "Re-enable the MCPSafari extension for this page in Safari Settings > "
                + "Extensions, or relaunch Safari, then retry.",
            retryable: false,
            recoveryAction: "inspect_error"
        )
    }

    /// The extension serializes non-string tool data, so a capture arrives as
    /// JSON text. Base64 image data never parses as JSON.
    static func decodeCapture(_ raw: String) -> [String: AnyCodable]? {
        guard raw.hasPrefix("{"), let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode([String: AnyCodable].self, from: data)
    }

    /// Describes the captured frame: pixel space, and what state Safari withheld
    /// from a page it was not presenting when the capture was taken.
    static func captureNote(_ capture: [String: AnyCodable]) -> String? {
        var parts: [String] = []
        if let viewport = capture["viewport"]?.objectValue,
           let width = number(viewport["width"]),
           let height = number(viewport["height"]) {
            let scale = number(capture["devicePixelRatio"]) ?? 1
            parts.append(
                "Viewport \(Int(width))x\(Int(height)) CSS px, devicePixelRatio \(formatScale(scale)). "
                + "The PNG is in device pixels; click(x, y) takes CSS pixels."
            )
        }
        if capture["visible"]?.boolValue == false {
            // A hidden page is also unfocused, so the focus note would add noise.
            parts.append(
                "Page visibility: hidden. Safari does not repaint an occluded page or run its "
                + "requestAnimationFrame callbacks, so this frame may predate your last action "
                + "and any rAF-scheduled work has not run."
            )
        } else if capture["hasFocus"]?.boolValue == false {
            parts.append(
                "Window not focused. Safari does not match :focus or :focus-within while its "
                + "window is not key, so focus states are missing from this frame even though "
                + "document.activeElement is set."
            )
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// JSON numbers arrive as Int or Double depending on the value.
    private static func number(_ value: AnyCodable?) -> Double? {
        value?.doubleValue ?? value?.intValue.map(Double.init)
    }

    private static func formatScale(_ scale: Double) -> String {
        scale == scale.rounded() ? String(Int(scale)) : String(scale)
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
        if let level = args["level"]?.stringValue {
            guard Self.allowedConsoleLevels.contains(level) else {
                return CallTool.Result(
                    content: [Self.textContent("Invalid console level: \(level). Use all, log, warn, error, info, or debug.")],
                    isError: true
                )
            }
            params["level"] = AnyCodable(level)
        }
        if let clear = args["clear"]?.boolValue { params["clear"] = AnyCodable(clear) }
        if let pattern = args["pattern"]?.stringValue {
            guard pattern.count <= 200 else {
                return CallTool.Result(
                    content: [Self.textContent("Pattern too long (max 200 characters)")],
                    isError: true
                )
            }
            // Validate it's a valid regex
            guard (try? NSRegularExpression(pattern: pattern)) != nil else {
                return CallTool.Result(
                    content: [Self.textContent("Invalid regex pattern: \(pattern)")],
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
        if let type = args["type"]?.stringValue {
            guard Self.allowedNetworkTypes.contains(type) else {
                return CallTool.Result(
                    content: [Self.textContent("Invalid network type: \(type). Use all, xhr, or fetch.")],
                    isError: true
                )
            }
            params["type"] = AnyCodable(type)
        }
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
    private static let maxTraceSeconds: Double = 30

    private func handleRunSteps(_ args: [String: Value]) async throws -> CallTool.Result {
        let plan: RunStepsPlan
        do {
            plan = try RunStepsPlan(arguments: args)
        } catch let error as RunStepsInputError {
            throw ToolInputError(error.description)
        }
        if let includeSnapshot = args["includeSnapshot"], includeSnapshot.boolValue == nil {
            throw ToolInputError("includeSnapshot must be a boolean")
        }

        var batchArgs = args
        batchArgs["_batchDeadline"] = .double(ProcessInfo.processInfo.systemUptime + plan.timeout)
        let traceSession = try await startTraceIfNeeded(batchArgs)
        var results: [Value] = []
        var content: [Tool.Content] = []

        for (index, step) in plan.steps.enumerated() {
            guard Self.batchRemaining(batchArgs) > 0 else {
                return await runStepsFailure(
                    ToolFailure(
                        code: "batch_timeout",
                        message: "run_steps reached its \(plan.timeout)-second deadline before step \(index)",
                        retryable: false,
                        recoveryAction: "inspect_batch_result"
                    ),
                    failedStep: index,
                    completedSteps: index,
                    results: results,
                    content: content,
                    traceSession: traceSession,
                    args: batchArgs
                )
            }

            var stepArguments = step.arguments
            stepArguments["_batchDeadline"] = batchArgs["_batchDeadline"]
            let result = await handleToolCall(.init(name: step.tool, arguments: stepArguments))
            content.append(Self.textContent("--- Step \(index): \(step.tool) ---"))
            content.append(contentsOf: result.content)
            results.append(try .object([
                "index": .int(index),
                "tool": .string(step.tool),
                "result": Value(result),
            ]))

            if result.isError == true {
                return await runStepsFailure(
                    Self.toolFailure(from: result, step: index, tool: step.tool),
                    failedStep: index,
                    completedSteps: index,
                    results: results,
                    content: content,
                    traceSession: traceSession,
                    args: batchArgs
                )
            }
        }

        var details = Self.runStepsDetails(results: results, completedSteps: plan.steps.count)
        if let traceSession {
            do {
                let traceResponse = try await stopTraceResponse(traceSession, batchArgs)
                let traceText = responseText(traceResponse)
                content.append(Self.textContent("--- Page Trace ---\n\(traceText)"))
                details["trace"] = .string(traceText)
                guard traceResponse.success else {
                    return Self.failureResult(traceResponse.toolFailure, content: content, details: details)
                }
            } catch {
                return Self.failureResult(toolFailure(for: error), content: content, details: details)
            }
        }

        if args["includeSnapshot"]?.boolValue == true {
            do {
                let snapshot = try await snapshotResponse(batchArgs)
                let snapshotText = responseText(snapshot)
                content.append(Self.textContent("--- Page Snapshot ---\n\(snapshotText)"))
                details["snapshot"] = .string(snapshotText)
                guard snapshot.success else {
                    return Self.failureResult(snapshot.toolFailure, content: content, details: details)
                }
            } catch {
                return Self.failureResult(toolFailure(for: error), content: content, details: details)
            }
        }

        return CallTool.Result(content: content, structuredContent: .object(details), isError: false)
    }

    private func runStepsFailure(
        _ failure: ToolFailure,
        failedStep: Int?,
        completedSteps: Int,
        results: [Value],
        content: [Tool.Content],
        traceSession: TraceSession?,
        args: [String: Value]
    ) async -> CallTool.Result {
        var content = content
        var details = Self.runStepsDetails(
            results: results,
            completedSteps: completedSteps,
            failedStep: failedStep
        )
        if let traceSession {
            do {
                let traceResponse = try await stopTraceResponse(traceSession, args, waitForDuration: false)
                let traceText = responseText(traceResponse)
                content.append(Self.textContent("--- Page Trace ---\n\(traceText)"))
                details["trace"] = .string(traceText)
            } catch {
                content.append(Self.textContent("--- Page Trace ---\nFailed to stop trace: \(error)"))
            }
        }
        return Self.failureResult(failure, content: content, details: details)
    }

    private func handleWait(_ args: [String: Value]) async throws -> CallTool.Result {
        if let seconds = Self.numberValue(args["seconds"]), args["selector"] == nil, args["text"] == nil {
            let requested = max(0, min(seconds, Self.maxWaitSeconds))
            let duration = min(requested, Self.batchRemaining(args))
            try await Task.sleep(for: .seconds(duration))
            guard duration == requested else {
                return Self.failureResult(ToolFailure(
                    code: "batch_timeout",
                    message: "run_steps reached its deadline while waiting",
                    retryable: false,
                    recoveryAction: "inspect_batch_result"
                ))
            }
            return CallTool.Result(content: [Self.textContent("Waited \(duration) seconds")])
        }

        var params: [String: AnyCodable] = [:]
        if let selector = args["selector"]?.stringValue { params["selector"] = AnyCodable(selector) }
        if let text = args["text"]?.stringValue { params["text"] = AnyCodable(text) }
        let userTimeout = min(Self.cappedWaitTimeout(args["timeout"]), Self.batchRemaining(args))
        params["timeout"] = AnyCodable(userTimeout)
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        // Extend bridge timeout to exceed the wait timeout so it doesn't race
        let response = try await bridge.send(
            action: "wait",
            params: params,
            timeout: Self.bridgeTimeout(args, default: userTimeout + 5)
        )
        return textResult(response)
    }

    // MARK: - Helpers

    private struct TraceSession {
        let id: String
        let duration: Double
    }

    private func resultAfterAction(
        _ response: BridgeResponse,
        _ args: [String: Value],
        wantSnapshot: Bool? = nil,
        traceSession: TraceSession? = nil
    ) async throws -> CallTool.Result {
        var content = [Self.textContent(responseText(response))]
        guard response.success else {
            if let traceSession {
                let traceResponse = try await stopTraceResponse(traceSession, args, waitForDuration: false)
                content.append(Self.textContent("--- Page Trace ---\n\(responseText(traceResponse))"))
            }
            return Self.failureResult(response.toolFailure, content: content)
        }

        if let waitResponse = try await waitAfterAction(args) {
            guard waitResponse.success else {
                content.append(Self.textContent(responseText(waitResponse)))
                if let traceSession {
                    let traceResponse = try await stopTraceResponse(traceSession, args, waitForDuration: false)
                    content.append(Self.textContent("--- Page Trace ---\n\(responseText(traceResponse))"))
                }
                return Self.failureResult(waitResponse.toolFailure, content: content)
            }
            content.append(Self.textContent(responseText(waitResponse)))
        }

        if let traceSession {
            let traceResponse = try await stopTraceResponse(traceSession, args)
            content.append(Self.textContent("--- Page Trace ---\n\(responseText(traceResponse))"))
            guard traceResponse.success else {
                return Self.failureResult(traceResponse.toolFailure, content: content)
            }
        }

        if wantSnapshot ?? args["includeSnapshot"]?.boolValue == true {
            let snapResponse = try await snapshotResponse(args)
            let snapText = responseText(snapResponse)
            content.append(Self.textContent("--- Page Snapshot ---\n\(snapText)"))
            guard snapResponse.success else {
                return Self.failureResult(snapResponse.toolFailure, content: content)
            }
        }

        return CallTool.Result(content: content)
    }

    private func startTraceIfNeeded(_ args: [String: Value]) async throws -> TraceSession? {
        guard let traceValue = args["trace"] else { return nil }
        guard let traceEnabled = traceValue.boolValue else { throw ToolInputError("trace must be a boolean") }
        guard traceEnabled else { return nil }

        var params: [String: AnyCodable] = [:]
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        if let value = args["eventTypes"] {
            guard let values = value.arrayValue,
                  values.allSatisfy({ $0.stringValue?.isEmpty == false }) else {
                throw ToolInputError("eventTypes must be an array of non-empty strings")
            }
            params["eventTypes"] = AnyCodable(values.compactMap(\.stringValue))
        }

        let response = try await bridge.send(
            action: "start_trace",
            params: params,
            timeout: Self.bridgeTimeout(args)
        )
        guard response.success else { throw ToolInputError(responseText(response)) }
        guard let traceID = response.data?.stringValue, !traceID.isEmpty else {
            throw ToolInputError("Trace did not return an id")
        }

        return TraceSession(
            id: traceID,
            duration: try Self.cappedTraceDuration(args["traceDuration"])
        )
    }

    private func stopTraceResponse(
        _ traceSession: TraceSession,
        _ args: [String: Value],
        waitForDuration: Bool = true
    ) async throws -> BridgeResponse {
        if waitForDuration, traceSession.duration > 0 {
            try await Task.sleep(for: .seconds(min(traceSession.duration, Self.batchRemaining(args))))
        }

        var params: [String: AnyCodable] = ["id": AnyCodable(traceSession.id)]
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        return try await bridge.send(
            action: "stop_trace",
            params: params,
            timeout: Self.bridgeTimeout(args)
        )
    }

    private func waitAfterAction(_ args: [String: Value]) async throws -> BridgeResponse? {
        guard args["waitForSelector"] != nil || args["waitForText"] != nil else { return nil }
        var params: [String: AnyCodable] = [:]
        if let selectorValue = args["waitForSelector"] {
            guard let selector = selectorValue.stringValue else { throw ToolInputError("waitForSelector must be a string") }
            guard !selector.isEmpty else { throw ToolInputError("waitForSelector must not be empty") }
            params["selector"] = AnyCodable(selector)
        }
        if let textValue = args["waitForText"] {
            guard let text = textValue.stringValue else { throw ToolInputError("waitForText must be a string") }
            guard !text.isEmpty else { throw ToolInputError("waitForText must not be empty") }
            params["text"] = AnyCodable(text)
        }
        let timeout = min(Self.cappedWaitTimeout(args["waitTimeout"]), Self.batchRemaining(args))
        params["timeout"] = AnyCodable(timeout)
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        return try await bridge.send(
            action: "wait",
            params: params,
            timeout: Self.bridgeTimeout(args, default: timeout + 5)
        )
    }

    private func snapshotResponse(_ args: [String: Value]) async throws -> BridgeResponse {
        var snapParams: [String: AnyCodable] = [:]
        if let tabId = args["tabId"]?.intValue { snapParams["tabId"] = AnyCodable(tabId) }
        return try await bridge.send(
            action: "snapshot",
            params: snapParams,
            timeout: Self.bridgeTimeout(args)
        )
    }

    private static func cappedWaitTimeout(_ value: Value?) -> Double {
        max(0.1, min(Self.numberValue(value) ?? 10, Self.maxWaitSeconds))
    }

    private static func cappedTraceDuration(_ value: Value?) throws -> Double {
        if let value, Self.numberValue(value) == nil {
            throw ToolInputError("traceDuration must be a number")
        }
        return max(0, min(Self.numberValue(value) ?? 2, Self.maxTraceSeconds))
    }

    private static func batchRemaining(_ args: [String: Value]) -> Double {
        guard let deadline = numberValue(args["_batchDeadline"]) else { return .infinity }
        return max(0, deadline - ProcessInfo.processInfo.systemUptime)
    }

    private static func bridgeTimeout(_ args: [String: Value], default defaultTimeout: Double = 30) -> Double {
        max(0.1, min(defaultTimeout, batchRemaining(args)))
    }

    static func numberValue(_ value: Value?) -> Double? {
        if let double = value?.doubleValue { return double }
        if let int = value?.intValue { return Double(int) }
        return nil
    }

    private struct ToolInputError: Error, CustomStringConvertible {
        let description: String

        init(_ description: String) {
            self.description = description
        }
    }

    private func textResult(_ response: BridgeResponse) -> CallTool.Result {
        guard response.success else {
            return Self.failureResult(response.toolFailure)
        }
        return CallTool.Result(
            content: [Self.textContent(responseText(response))],
            isError: false
        )
    }

    private func toolFailure(for error: any Error) -> ToolFailure {
        if let bridgeError = error as? WebSocketBridge.BridgeError {
            return bridgeError.toolFailure
        }
        if let nativeInputError = error as? NativeInputError {
            return nativeInputError.failure
        }
        if let inputError = error as? ToolInputError {
            return ToolFailure(
                code: "invalid_input",
                message: inputError.description,
                retryable: false,
                recoveryAction: "fix_input"
            )
        }
        return ToolFailure(
            code: "internal_error",
            message: "\(error)",
            retryable: false,
            recoveryAction: "inspect_error"
        )
    }

    private static func failureResult(
        _ failure: ToolFailure,
        content: [Tool.Content]? = nil,
        details: [String: Value] = [:]
    ) -> CallTool.Result {
        var structuredContent = details
        structuredContent["code"] = .string(failure.code)
        structuredContent["message"] = .string(failure.message)
        structuredContent["retryable"] = .bool(failure.retryable)
        structuredContent["recoveryAction"] = .string(failure.recoveryAction)
        return CallTool.Result(
            content: content ?? [Self.textContent(failure.message)],
            structuredContent: .object(structuredContent),
            isError: true
        )
    }

    private static func runStepsDetails(
        results: [Value],
        completedSteps: Int,
        failedStep: Int? = nil
    ) -> [String: Value] {
        [
            "results": .array(results),
            "completedSteps": .int(completedSteps),
            "failedStep": failedStep.map(Value.int) ?? .null,
        ]
    }

    private static func toolFailure(from result: CallTool.Result, step: Int, tool: String) -> ToolFailure {
        let details = result.structuredContent?.objectValue
        return ToolFailure(
            code: details?["code"]?.stringValue ?? "step_failed",
            message: details?["message"]?.stringValue ?? "Step \(step) (\(tool)) failed",
            retryable: details?["retryable"]?.boolValue ?? false,
            recoveryAction: details?["recoveryAction"]?.stringValue ?? "inspect_batch_result"
        )
    }

    private func responseText(_ response: BridgeResponse) -> String {
        if let data = response.data {
            return "\(data)"
        } else if let error = response.error {
            return error
        } else {
            return response.success ? "OK" : "Failed"
        }
    }
}
