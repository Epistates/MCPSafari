import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation
import ImageIO
import Logging
import MCP
import UniformTypeIdentifiers

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
                then click/type_text/hover by UID. Use includeSnapshot on interactions to see updated state. \
                Tab handles look like p0t5, where p0 names the Safari profile; read them from \
                tabs_context rather than composing them.
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
        let transport = ClientCapabilityNormalizingTransport(
            wrapping: StdioTransport(),
            logger: logger
        )
        do {
            try await server.start(transport: transport)
            logger.info("Safari MCP server started")
            await server.waitUntilCompleted()
        } catch {
            await bridge.stop()
            throw error
        }
        await bridge.stop()
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

    // MARK: - Request Keys

    private static let fileInputKeys: Set<String> = ["filePath", "filePaths", "mimeType"]
    private static let postActionWaitKeys: Set<String> = ["waitForSelector", "waitForText", "waitTimeout"]
    private static let postActionTraceKeys: Set<String> = ["trace", "traceDuration", "eventTypes"]
    private static let actionControlKeys: Set<String> = postActionWaitKeys
        .union(postActionTraceKeys)
        .union(["_batchDeadline"])

    static func textContent(_ text: String) -> Tool.Content {
        .text(text: text, annotations: nil, _meta: nil)
    }

    private static func imageContent(data: String, mimeType: String) -> Tool.Content {
        .image(data: data, mimeType: mimeType, annotations: nil, _meta: nil)
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
            case "press_key":       return try await handlePressKey(args)
            case "hover":           return try await handleHover(args)
            case "drag":            return try await handleDrag(args)
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

    // MARK: - Profile Routing

    /// Every bridge call goes through here so the caller's `tabId` is read in one
    /// place. The handle names the profile, so the request is routed to that
    /// profile's extension instance and the numeric tab id, which is all that
    /// instance knows, is what crosses the bridge.
    private func send(
        _ action: String,
        _ args: [String: Value],
        params: [String: AnyCodable] = [:],
        timeout: Double? = nil
    ) async throws -> BridgeResponse {
        let handle = try TabHandle.resolve(args["tabId"])
        var params = params
        if let handle { params["tabId"] = AnyCodable(handle.tabID) }
        return try await bridge.send(
            action: action,
            params: params,
            timeout: timeout ?? Self.bridgeTimeout(args),
            profileIndex: handle?.profileIndex
        )
    }

    /// Rewrites the `id` of a tab object the extension returned into the handle
    /// that names it, so the only tab identifier a caller ever sees is one they
    /// can hand straight back.
    private func tabResult(_ response: BridgeResponse, profileIndex: Int) -> CallTool.Result {
        guard response.success, let raw = response.data?.stringValue else {
            return textResult(response, as: "tab")
        }
        guard let data = raw.data(using: .utf8),
              var tab = try? JSONDecoder().decode([String: AnyCodable].self, from: data),
              let tabID = tab["id"]?.intValue
        else {
            return textResult(response, as: "tab")
        }
        tab["id"] = AnyCodable(TabHandle(profileIndex: profileIndex, tabID: tabID).description)
        return CallTool.Result(
            content: [Self.textContent(Self.jsonText(tab) ?? raw)],
            structuredContent: .object(["tab": (try? Value(tab)) ?? .null])
        )
    }

    /// Which profile a call will land on. An explicit handle names it; otherwise it
    /// is whichever profile the bridge drives right now. Resolved once and reused
    /// for both the routing and the handle, so a tab cannot be created in one
    /// profile and named as if it were in another.
    private func resolveProfileIndex(_ args: [String: Value]) async throws -> Int {
        if let handle = try TabHandle.resolve(args["tabId"]) { return handle.profileIndex }
        guard let selected = await bridge.connectedProfiles().first(where: \.selected) else {
            throw WebSocketBridge.BridgeError.notConnected
        }
        return selected.index
    }

    private static func jsonText(_ value: some Encodable) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(value) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: - Tool Handlers

    private func handleStatus() async throws -> CallTool.Result {
        let status = await bridge.status()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(status)
        return CallTool.Result(
            content: [Self.textContent(String(decoding: data, as: UTF8.self))],
            structuredContent: .object(["status": try Value(status)])
        )
    }

    /// Asks every connected profile for its tabs and returns one merged listing,
    /// each tab named by a handle that says which profile it belongs to. A profile
    /// that fails to answer is named in a second block rather than dropped, so a
    /// short listing is never mistaken for an empty browser.
    private func handleTabsContext() async throws -> CallTool.Result {
        let merged = Self.mergedTabListing(try await bridge.broadcast(action: "tabs_query"))

        guard !merged.tabs.isEmpty || merged.failures.isEmpty else {
            return Self.failureResult(ToolFailure(
                code: "extension_error",
                message: "No Safari profile returned its tabs. \(merged.failures.joined(separator: "; "))",
                retryable: true,
                recoveryAction: "retry"
            ))
        }

        var content = [Self.textContent(Self.jsonText(merged.tabs) ?? "[]")]
        if !merged.failures.isEmpty {
            content.append(Self.textContent(
                "Tabs are missing from \(merged.failures.count) profile(s): "
                + merged.failures.joined(separator: "; ")
            ))
        }
        return CallTool.Result(content: content, structuredContent: .object([
            "tabs": try Value(merged.tabs),
            "profileFailures": .array(merged.failures.map(Value.string)),
        ]))
    }

    /// Flattens what each profile returned into one listing, naming every tab by
    /// its handle. A profile that could not answer is reported rather than
    /// dropped: a short listing that looks complete is worse than a named gap,
    /// because the caller concludes the tab they wanted is closed.
    static func mergedTabListing(
        _ outcomes: [WebSocketBridge.ProfileOutcome]
    ) -> (tabs: [AnyCodable], failures: [String]) {
        var tabs: [AnyCodable] = []
        var failures: [String] = []

        for outcome in outcomes {
            let response: BridgeResponse
            switch outcome.reply {
            case .answered(let answer):
                response = answer
            case .unreachable(let detail):
                failures.append("\(outcome.label): \(detail)")
                continue
            }

            guard response.success else {
                failures.append("\(outcome.label): \(response.error ?? "no reason given")")
                continue
            }
            guard let raw = response.data?.stringValue,
                  let data = raw.data(using: .utf8),
                  let listing = try? JSONDecoder().decode([[String: AnyCodable]].self, from: data)
            else {
                failures.append("\(outcome.label): unreadable tab listing")
                continue
            }
            for var tab in listing {
                if let tabID = tab["id"]?.intValue {
                    tab["id"] = AnyCodable(
                        TabHandle(profileIndex: outcome.index, tabID: tabID).description
                    )
                }
                tabs.append(AnyCodable(tab))
            }
        }

        return (tabs, failures)
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
        let profileIndex = try await resolveProfileIndex(args)
        let response = try await bridge.send(
            action: "tabs_create",
            params: params,
            timeout: Self.bridgeTimeout(args),
            profileIndex: profileIndex
        )
        return tabResult(response, profileIndex: profileIndex)
    }

    private func handleCloseTab(_ args: [String: Value]) async throws -> CallTool.Result {
        guard let handle = try TabHandle.resolve(args["tabId"]) else {
            throw ToolInputError("close_tab requires tabId, a handle from tabs_context such as p0t5")
        }
        let response = try await send("tabs_close", args)
        guard response.success else { return textResult(response, as: "tab") }
        // The extension's confirmation names the tab by its own number, which is
        // ambiguous across profiles; the server knows the handle the caller used.
        return CallTool.Result(
            content: [Self.textContent("Closed tab \(handle)")],
            structuredContent: .object(["tab": .object([
                "id": .string(handle.description), "closed": .bool(true),
            ])])
        )
    }

    private func handleSelectTab(_ args: [String: Value]) async throws -> CallTool.Result {
        guard let handle = try TabHandle.resolve(args["tabId"]) else {
            throw ToolInputError("select_tab requires tabId, a handle from tabs_context such as p0t5")
        }
        var params: [String: AnyCodable] = [:]
        if let bringToFront = args["bringToFront"]?.boolValue { params["bringToFront"] = AnyCodable(bringToFront) }
        let response = try await send("select_tab", args, params: params)
        guard response.success else { return textResult(response, as: "tab") }
        // Pinning the tab pins its profile too, so later calls that name no tab
        // stay in the browser window the caller just chose.
        try await bridge.selectProfile(atIndex: handle.profileIndex)
        return tabResult(response, profileIndex: handle.profileIndex)
    }

    private static let allowedURLSchemes: Set<String> = ["http", "https", "about", "file"]
    private static let allowedNavActions: Set<String> = ["goto", "back", "forward", "reload"]
    private static let allowedPageFormats: Set<String> = ["text", "html", "snapshot"]
    private static let allowedConsoleLevels: Set<String> = ["all", "log", "warn", "error", "info", "debug"]
    private static let allowedNetworkTypes: Set<String> = ["all", "xhr", "fetch", "resource"]

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
        if let action = args["action"]?.stringValue {
            guard Self.allowedNavActions.contains(action) else {
                return CallTool.Result(
                    content: [Self.textContent("Invalid navigation action: \(action). Use goto, back, forward, or reload.")],
                    isError: true
                )
            }
            params["action"] = AnyCodable(action)
        }
        let response = try await send("navigate", args, params: params)
        return try await resultAfterAction(response, args)
    }

    private func handleReadPage(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let format = args["format"]?.stringValue {
            guard Self.allowedPageFormats.contains(format) else {
                return CallTool.Result(
                    content: [Self.textContent("Invalid page format: \(format). Use text, html, or snapshot.")],
                    isError: true
                )
            }
            params["format"] = AnyCodable(format)
        }
        if let maxChars = args["maxChars"]?.intValue {
            guard maxChars > 0 else {
                return Self.failureResult(ToolFailure(
                    code: "invalid_input",
                    message: "Invalid maxChars: \(maxChars). Use a positive integer.",
                    retryable: false,
                    recoveryAction: "fix_input"
                ))
            }
            params["maxChars"] = AnyCodable(maxChars)
        }
        if let maxNodes = args["maxNodes"]?.intValue {
            guard maxNodes > 0 else {
                return Self.failureResult(ToolFailure(
                    code: "invalid_input",
                    message: "Invalid maxNodes: \(maxNodes). Use a positive integer.",
                    retryable: false,
                    recoveryAction: "fix_input"
                ))
            }
            params["maxNodes"] = AnyCodable(maxNodes)
        }
        let response = try await send("read_page", args, params: params)
        return textResult(response, as: "page", decoding: args["format"]?.stringValue == "snapshot" ? .containers : .text)
    }

    private func handleSnapshot(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let maxNodes = args["maxNodes"]?.intValue {
            guard maxNodes > 0 else {
                return Self.failureResult(ToolFailure(
                    code: "invalid_input",
                    message: "Invalid maxNodes: \(maxNodes). Use a positive integer.",
                    retryable: false,
                    recoveryAction: "fix_input"
                ))
            }
            params["maxNodes"] = AnyCodable(maxNodes)
        }
        let response = try await send("snapshot", args, params: params)
        return textResult(response, as: "snapshot")
    }

    private func handleFind(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let selector = args["selector"]?.stringValue { params["selector"] = AnyCodable(selector) }
        if let text = args["text"]?.stringValue { params["text"] = AnyCodable(text) }
        if let role = args["role"]?.stringValue { params["role"] = AnyCodable(role) }
        let response = try await send("find", args, params: params)
        return textResult(response, as: "matches")
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
            let response = try await send(action, args, params: params)
            return try await resultAfterAction(response, args, wantSnapshot: wantSnapshot, traceSession: traceSession)
        } catch {
            if let traceSession {
                _ = try? await stopTraceResponse(traceSession, args, waitForDuration: false)
            }
            throw error
        }
    }

    /// Forwards the caller's arguments to the extension verbatim, minus the ones
    /// the server handles itself. `tabId` is one of those: it arrives as a handle
    /// the extension cannot read, and `send` puts the numeric id back.
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
            let preparation = try await send("native_type_text", args, params: interactionParams(args))
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

    // MARK: - Native key combos (press_key native=true)

    private func nativeRequested(_ args: [String: Value]) throws -> Bool {
        if let native = args["native"], native.boolValue == nil {
            throw ToolInputError("native must be a boolean")
        }
        return args["native"]?.boolValue == true
    }

    // Shared flow for native input tools: permission, trace, bridge
    // preparation, then the CGEvent posting supplied by the caller.
    private func runNativeAction(
        _ action: String,
        _ args: [String: Value],
        perform: (BridgeResponse) throws -> String
    ) async throws -> CallTool.Result {
        try Self.ensureNativeInputPermission()
        let traceSession = try await startTraceIfNeeded(args)
        do {
            let preparation = try await send(action, args, params: interactionParams(args))
            guard preparation.success else {
                return try await resultAfterAction(preparation, args, traceSession: traceSession)
            }

            let message = try perform(preparation)
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

    private func handlePressKey(_ args: [String: Value]) async throws -> CallTool.Result {
        guard try nativeRequested(args) else {
            return try await handleInteraction("press_key", args)
        }
        guard let key = args["key"]?.stringValue, !key.isEmpty else {
            throw ToolInputError("key is required")
        }
        let combo = try Self.nativeKeyCombo(key)
        return try await runNativeAction("native_press_key", args) { _ in
            try Self.pressNativeKey(combo, deadline: Self.numberValue(args["_batchDeadline"]))
        }
    }

    // MARK: - Native pointer (move_pointer, drag native=true)

    private func handleHover(_ args: [String: Value]) async throws -> CallTool.Result {
        guard try nativeRequested(args) else {
            return try await handleInteraction("hover", args)
        }
        return try await runNativeAction("native_pointer", args) { preparation in
            let targets = try Self.nativePointerTargets(from: preparation.data)
            _ = try Self.moveNativePointer(to: targets.from, deadline: Self.numberValue(args["_batchDeadline"]))
            return "Hovered with native input; pointer at (\(Int(targets.from.x)), \(Int(targets.from.y)))"
        }
    }

    private func handleDrag(_ args: [String: Value]) async throws -> CallTool.Result {
        guard try nativeRequested(args) else {
            return try await handleInteraction("drag", args)
        }
        return try await runNativeAction("native_pointer", args) { preparation in
            let targets = try Self.nativePointerTargets(from: preparation.data)
            guard let to = targets.to else {
                throw ToolInputError("drag requires toUid or toSelector")
            }
            return try Self.dragNativePointer(from: targets.from, to: to, deadline: Self.numberValue(args["_batchDeadline"]))
        }
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
        let traceSession = try await startTraceIfNeeded(args)
        do {
            let response = try await send("form_input", args, params: params)
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
        if let uid = args["uid"]?.stringValue { params["uid"] = AnyCodable(uid) }
        if let selector = args["selector"]?.stringValue { params["selector"] = AnyCodable(selector) }
        // Validate before the bridge call: a targeted capture scrolls the page.
        let padding: Double
        let scale: Double
        do {
            padding = try Self.capturePadding(args)
            scale = try Self.captureScale(args)
        } catch {
            return Self.failureResult(toolFailure(for: error))
        }
        let response = try await send("screenshot", args, params: params)

        guard response.success, let raw = response.data?.stringValue else {
            return textResult(response, as: "screenshot")
        }

        // Current extensions send the image plus its capture context; older
        // ones send the base64 image on its own.
        let capture = Self.decodeCapture(raw)
        var imageData = capture?["image"]?.stringValue ?? raw

        if let failure = Self.captureFailure(imageData) {
            return Self.failureResult(failure)
        }
        var note = capture.flatMap(Self.captureNote)
        var png = Data(base64Encoded: imageData) ?? Data()

        do {
            let clip = try Self.captureClip(args, capture: capture, padding: padding)
            if clip != nil || scale < 1 {
                let rendered = try Self.renderCapture(png, clip: clip, scale: scale)
                png = rendered.png
                imageData = png.base64EncodedString()
                note = [note, Self.renderNote(rendered, args: args, capture: capture, scale: scale)]
                    .compactMap { $0 }
                    .joined(separator: " ")
            }
        } catch {
            return Self.failureResult(toolFailure(for: error))
        }

        var captureDetails = capture ?? [:]
        captureDetails.removeValue(forKey: "image")
        captureDetails["mimeType"] = AnyCodable("image/png")
        captureDetails["byteCount"] = AnyCodable(png.count)
        captureDetails["scale"] = AnyCodable(scale)
        if let note { captureDetails["note"] = AnyCodable(note) }

        if let filePath = args["filePath"] {
            let url: URL
            do {
                guard let path = filePath.stringValue else { throw FileAttachmentError("filePath must be a string") }
                url = try Self.writeCapture(png, to: path)
            } catch {
                return Self.failureResult(ToolFailure(
                    code: "invalid_input",
                    message: "\(error)",
                    retryable: false,
                    recoveryAction: "fix_input"
                ))
            }
            let text = ["Saved PNG to \(url.path) (\(png.count) bytes).", note]
                .compactMap { $0 }
                .joined(separator: "\n")
            captureDetails["filePath"] = AnyCodable(url.path)
            return CallTool.Result(
                content: [Self.textContent(text)],
                structuredContent: .object(["screenshot": try Value(captureDetails)])
            )
        }

        var content: [Tool.Content] = [
            Self.imageContent(data: imageData, mimeType: "image/png"),
        ]
        if let note {
            content.append(Self.textContent(note))
        }
        return CallTool.Result(content: content, structuredContent: .object(["screenshot": try Value(captureDetails)]))
    }

    private func handleJavaScript(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let code = args["code"]?.stringValue { params["code"] = AnyCodable(code) }
        let response = try await send("javascript_tool", args, params: params)
        return textResult(response, as: "result", decoding: .json)
    }

    private func handleReadConsole(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
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
        let response = try await send("read_console", args, params: params)
        return textResult(response, as: "messages")
    }

    private func handleReadNetwork(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let type = args["type"]?.stringValue {
            guard Self.allowedNetworkTypes.contains(type) else {
                return CallTool.Result(
                    content: [Self.textContent("Invalid network type: \(type). Use all, xhr, fetch, or resource.")],
                    isError: true
                )
            }
            params["type"] = AnyCodable(type)
        }
        if let urlPattern = args["urlPattern"]?.stringValue {
            guard urlPattern.count <= 200 else {
                return CallTool.Result(
                    content: [Self.textContent("URL pattern too long (max 200 characters)")],
                    isError: true
                )
            }
            guard (try? NSRegularExpression(pattern: urlPattern)) != nil else {
                return CallTool.Result(
                    content: [Self.textContent("Invalid regex pattern: \(urlPattern)")],
                    isError: true
                )
            }
            params["urlPattern"] = AnyCodable(urlPattern)
        }
        if let status = args["status"]?.intValue {
            guard (0...599).contains(status) else {
                return CallTool.Result(
                    content: [Self.textContent("Invalid status: \(status). Use an HTTP status code (0-599; 0 means network error).")],
                    isError: true
                )
            }
            params["status"] = AnyCodable(status)
        }
        if let maxResults = args["maxResults"]?.intValue {
            guard maxResults > 0 else {
                return CallTool.Result(
                    content: [Self.textContent("Invalid maxResults: \(maxResults). Use a positive integer.")],
                    isError: true
                )
            }
            params["maxResults"] = AnyCodable(maxResults)
        }
        if let clear = args["clear"]?.boolValue { params["clear"] = AnyCodable(clear) }
        let response = try await send("read_network", args, params: params)
        return textResult(response, as: "requests")
    }

    private func handleResizeWindow(_ args: [String: Value]) async throws -> CallTool.Result {
        var params: [String: AnyCodable] = [:]
        if let width = args["width"]?.intValue { params["width"] = AnyCodable(width) }
        if let height = args["height"]?.intValue { params["height"] = AnyCodable(height) }
        let response = try await send("resize_window", args, params: params)
        return textResult(response, as: "window")
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
                details["trace"] = Self.structuredPayload(traceResponse.data)
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
                details["snapshot"] = Self.structuredPayload(snapshot.data)
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
                details["trace"] = Self.structuredPayload(traceResponse.data)
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
            return CallTool.Result(
                content: [Self.textContent("Waited \(duration) seconds")],
                structuredContent: .object(["wait": .object(["seconds": .double(duration)])])
            )
        }

        var params: [String: AnyCodable] = [:]
        if let selector = args["selector"]?.stringValue { params["selector"] = AnyCodable(selector) }
        if let text = args["text"]?.stringValue { params["text"] = AnyCodable(text) }
        let userTimeout = min(Self.cappedWaitTimeout(args["timeout"]), Self.batchRemaining(args))
        params["timeout"] = AnyCodable(userTimeout)
        // Extend bridge timeout to exceed the wait timeout so it doesn't race
        let response = try await send(
            "wait", args,
            params: params,
            timeout: Self.bridgeTimeout(args, default: userTimeout + 5)
        )
        return textResult(response, as: "wait")
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
        var details: [String: Value] = ["result": Self.structuredPayload(response.data)]
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
            details["wait"] = Self.structuredPayload(waitResponse.data)
        }

        if let traceSession {
            let traceResponse = try await stopTraceResponse(traceSession, args)
            details["trace"] = Self.structuredPayload(traceResponse.data)
            content.append(Self.textContent("--- Page Trace ---\n\(responseText(traceResponse))"))
            guard traceResponse.success else {
                return Self.failureResult(traceResponse.toolFailure, content: content)
            }
        }

        if wantSnapshot ?? args["includeSnapshot"]?.boolValue == true {
            let snapResponse = try await snapshotResponse(args)
            details["snapshot"] = Self.structuredPayload(snapResponse.data)
            let snapText = responseText(snapResponse)
            content.append(Self.textContent("--- Page Snapshot ---\n\(snapText)"))
            guard snapResponse.success else {
                return Self.failureResult(snapResponse.toolFailure, content: content)
            }
        }

        return CallTool.Result(content: content, structuredContent: .object(details))
    }

    private func startTraceIfNeeded(_ args: [String: Value]) async throws -> TraceSession? {
        guard let traceValue = args["trace"] else { return nil }
        guard let traceEnabled = traceValue.boolValue else { throw ToolInputError("trace must be a boolean") }
        guard traceEnabled else { return nil }

        var params: [String: AnyCodable] = [:]
        if let value = args["eventTypes"] {
            guard let values = value.arrayValue,
                  values.allSatisfy({ $0.stringValue?.isEmpty == false }) else {
                throw ToolInputError("eventTypes must be an array of non-empty strings")
            }
            params["eventTypes"] = AnyCodable(values.compactMap(\.stringValue))
        }

        let response = try await send("start_trace", args, params: params)
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

        return try await send("stop_trace", args, params: ["id": AnyCodable(traceSession.id)])
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
        return try await send(
            "wait", args,
            params: params,
            timeout: Self.bridgeTimeout(args, default: timeout + 5)
        )
    }

    private func snapshotResponse(_ args: [String: Value]) async throws -> BridgeResponse {
        try await send("snapshot", args)
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
}
