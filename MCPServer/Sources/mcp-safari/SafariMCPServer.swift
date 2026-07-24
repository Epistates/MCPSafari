import AppKit
import ApplicationServices
import CoreGraphics
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
    private static let actionControlKeys: Set<String> = postActionWaitKeys.union(postActionTraceKeys)

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
                description: "Find elements by selector, visible text or accessible name, or ARIA role. Returns UIDs.",
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
                            "description": .string("Use real macOS key events; foregrounds Safari and requires Accessibility permission"),
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
        let response = try await bridge.send(action: "navigate", params: params)
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
        if let path = args["filePath"]?.stringValue { paths.append(path) }
        if let values = args["filePaths"]?.arrayValue {
            for value in values {
                guard let path = value.stringValue else { throw ToolInputError("filePaths must be an array of strings") }
                paths.append(path)
            }
        }

        let attachments: [FileAttachment]
        do {
            attachments = try FileAttachmentLoader.load(paths: paths, mimeTypeOverride: args["mimeType"]?.stringValue)
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
            let response = try await bridge.send(action: action, params: params)
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
            let preparation = try await bridge.send(action: "native_type_text", params: interactionParams(args))
            guard preparation.success else {
                return try await resultAfterAction(preparation, args, traceSession: traceSession)
            }

            let message = try Self.typeNativeText(input)
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

    private nonisolated static func typeNativeText(_ input: NativeInputPlan) throws -> String {
        try ensureSafariIsFrontmost()
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            throw nativeInputUnavailable("macOS could not create a native keyboard event.")
        }

        if input.clearFirst {
            try postKey(code: 0, flags: .maskCommand, source: source)
            try postKey(code: 51, source: source)
        }
        for character in input.text {
            try ensureSafariIsFrontmost()
            try postText(String(character), source: source)
        }
        if let submitKeyCode = input.submitKeyCode {
            try postKey(code: submitKeyCode, source: source)
        }

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

    private nonisolated static func ensureSafariIsFrontmost() throws {
        guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == "com.apple.Safari" else {
            throw NativeInputError(failure: ToolFailure(
                code: "native_input_focus_lost",
                message: "Safari lost focus before native typing completed. Input may be partial; focus the target and retry.",
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
        try ensureSafariIsFrontmost()
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
            let response = try await bridge.send(action: "form_input", params: params)
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

        if response.success, let imageData = response.data?.stringValue {
            return CallTool.Result(content: [
                Self.imageContent(data: imageData, mimeType: "image/png"),
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

    private func handleWait(_ args: [String: Value]) async throws -> CallTool.Result {
        if let seconds = Self.numberValue(args["seconds"]), args["selector"] == nil, args["text"] == nil {
            let capped = max(0, min(seconds, Self.maxWaitSeconds))
            try await Task.sleep(for: .seconds(capped))
            return CallTool.Result(content: [Self.textContent("Waited \(capped) seconds")])
        }

        var params: [String: AnyCodable] = [:]
        if let selector = args["selector"]?.stringValue { params["selector"] = AnyCodable(selector) }
        if let text = args["text"]?.stringValue { params["text"] = AnyCodable(text) }
        let userTimeout = Self.cappedWaitTimeout(args["timeout"])
        params["timeout"] = AnyCodable(userTimeout)
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        // Extend bridge timeout to exceed the wait timeout so it doesn't race
        let response = try await bridge.send(action: "wait", params: params, timeout: userTimeout + 5)
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

        let response = try await bridge.send(action: "start_trace", params: params)
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
            try await Task.sleep(for: .seconds(traceSession.duration))
        }

        var params: [String: AnyCodable] = ["id": AnyCodable(traceSession.id)]
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        return try await bridge.send(action: "stop_trace", params: params)
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
        let timeout = Self.cappedWaitTimeout(args["waitTimeout"])
        params["timeout"] = AnyCodable(timeout)
        if let tabId = args["tabId"]?.intValue { params["tabId"] = AnyCodable(tabId) }
        return try await bridge.send(action: "wait", params: params, timeout: timeout + 5)
    }

    private func snapshotResponse(_ args: [String: Value]) async throws -> BridgeResponse {
        var snapParams: [String: AnyCodable] = [:]
        if let tabId = args["tabId"]?.intValue { snapParams["tabId"] = AnyCodable(tabId) }
        return try await bridge.send(action: "snapshot", params: snapParams)
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

    private static func numberValue(_ value: Value?) -> Double? {
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
        content: [Tool.Content]? = nil
    ) -> CallTool.Result {
        CallTool.Result(
            content: content ?? [Self.textContent(failure.message)],
            structuredContent: .object([
                "code": .string(failure.code),
                "message": .string(failure.message),
                "retryable": .bool(failure.retryable),
                "recoveryAction": .string(failure.recoveryAction),
            ]),
            isError: true
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
