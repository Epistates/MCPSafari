import Foundation
import Logging
import MCP
import struct os.OSAllocatedUnfairLock

/// Core MCP server that registers Safari automation tools and bridges
/// tool calls to the Safari extension via WebSocket.
actor SafariMCPServer {
    private let server: Server
    private let bridge: WebSocketBridge
    private let logger: Logger

    /// Held from the extension's prepare step through the act step of every tool
    /// that depends on what has focus: native input, `screenshot`, and
    /// `select_tab` when it brings the tab to the front.
    private let focusLock = AsyncFIFOLock()

    init(
        port: UInt16 = 8089,
        portCount: UInt16 = WebSocketBridge.defaultPortCount,
        logger: Logger
    ) throws {
        self.logger = logger
        self.bridge = try WebSocketBridge(port: port, portCount: portCount, logger: logger)
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
        // Not awaited: a bind that stalls must not hold up `initialize`. Until it
        // finishes, tool calls fail with `bridge_unavailable` rather than waiting.
        Task { await bridge.start() }
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

    /// Takes the bridge down and removes its token files. For a signal, which ends the
    /// process without letting `start()` return.
    func shutdown() async {
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
            try Self.preflight(tool: params.name, arguments: args)
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
        // Resolved here rather than left to the bridge, so the profile a request
        // went to is known and can qualify the tab the extension reports back.
        let profileIndex: Int
        if let handle { profileIndex = handle.profileIndex } else { profileIndex = try await resolveProfileIndex(args) }
        var response = try await bridge.send(
            action: action,
            params: params,
            timeout: timeout ?? Self.bridgeTimeout(args),
            profileIndex: profileIndex
        )
        response.profileIndex = profileIndex
        if let tab = Self.resolvedHandle(of: response) { Self.batchPin?.recordFirst(tab) }
        return response
    }

    /// The tab the extension resolved for a response, named by a handle.
    static func resolvedHandle(of response: BridgeResponse) -> TabHandle? {
        guard let tabID = response.resolvedTabId, let profileIndex = response.profileIndex else { return nil }
        return TabHandle(profileIndex: profileIndex, tabID: tabID)
    }

    /// `args` with `tabId` filled in from the tab `response` was resolved against,
    /// when the caller named none.
    ///
    /// A call that names no tab acts on whichever tab is selected at the time,
    /// and the follow-ups it makes itself (the wait, the snapshot, the end of a
    /// trace) are separate requests that would each pick again. If the user, or
    /// a parallel call, moves the selection in between, they land on a different
    /// tab than the action did. An older extension reports no tab, and the
    /// arguments are returned as they were.
    static func pinned(_ args: [String: Value], to response: BridgeResponse) -> [String: Value] {
        guard args["tabId"] == nil || args["tabId"] == .null,
              let handle = resolvedHandle(of: response)
        else { return args }
        var pinned = args
        pinned["tabId"] = .string(handle.description)
        return pinned
    }

    /// The first tab a `run_steps` batch resolved, so the steps after it act on
    /// the same one when the batch names none. Set around each step by
    /// `handleRunSteps`, and read by `send`, which is where responses arrive.
    @TaskLocal static var batchPin: BatchTabPin?

    final class BatchTabPin: Sendable {
        private let first = OSAllocatedUnfairLock<TabHandle?>(initialState: nil)

        var handle: TabHandle? { first.withLock { $0 } }

        func recordFirst(_ handle: TabHandle) {
            first.withLock { if $0 == nil { $0 = handle } }
        }
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
        var content = [Self.textContent(Self.jsonText(tab) ?? raw)]
        if let note = Self.accessNote(for: [tab]) { content.append(Self.textContent(note)) }
        return CallTool.Result(
            content: content,
            structuredContent: .object(["tab": (try? Value(tab)) ?? .null])
        )
    }

    /// Tabs on a site Safari has not granted are listed, selected and created
    /// like any other and carry `access: "not_granted"` and an `accessHint`. The
    /// JSON carries that for a program; this sentence is for the model reading
    /// the result, which would otherwise find out only when its next read fails
    /// with `permission_required`. One sentence for a whole listing, with each
    /// distinct hint said once, rather than one per tab.
    static func accessNote(for tabs: [[String: AnyCodable]]) -> String? {
        let ungranted = tabs.filter { $0["access"]?.stringValue == "not_granted" }
        guard !ungranted.isEmpty else { return nil }
        var hints: [String] = []
        for hint in ungranted.compactMap({ $0["accessHint"]?.stringValue }) where !hints.contains(hint) {
            hints.append(hint)
        }
        let subject = ungranted.count == 1
            ? "Access to one tab's site is not granted"
            : "Access to \(ungranted.count) tabs' sites is not granted"
        return ([
            "\(subject), so reading or acting on \(ungranted.count == 1 ? "it" : "them") will fail with permission_required until the user grants it.",
        ] + hints).joined(separator: " ")
    }

    /// Which profile a call will land on. An explicit handle names it; otherwise it
    /// is whichever profile the bridge drives right now. Resolved once and reused
    /// for both the routing and the handle, so a tab cannot be created in one
    /// profile and named as if it were in another.
    private func resolveProfileIndex(_ args: [String: Value]) async throws -> Int {
        if let handle = try TabHandle.resolve(args["tabId"]) { return handle.profileIndex }
        guard let selected = await bridge.connectedProfiles().first(where: \.selected) else {
            throw await bridge.noConnectionError()
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
        if let note = Self.accessNote(for: merged.tabs.compactMap(\.objectValue)) {
            content.append(Self.textContent(note))
        }
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
        let profileIndex = try await resolveProfileIndex(args)
        let response = try await bridge.send(
            action: "tabs_create",
            params: try Self.tabsCreateParams(args),
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
        let params = try Self.selectTabParams(args)
        // Bringing a tab to the front moves focus, so it queues with the other
        // focus-sensitive tools. Selecting without it touches nothing they use.
        let response = params["bringToFront"]?.boolValue == false
            ? try await send("select_tab", args, params: params)
            : try await focusLock.withLock { try await send("select_tab", args, params: params) }
        guard response.success else { return textResult(response, as: "tab") }
        // Pinning the tab pins its profile too, so later calls that name no tab
        // stay in the browser window the caller just chose.
        try await bridge.selectProfile(atIndex: handle.profileIndex)
        return tabResult(response, profileIndex: handle.profileIndex)
    }

    private func handleNavigate(_ args: [String: Value]) async throws -> CallTool.Result {
        let response = try await send("navigate", args, params: try Self.navigateParams(args))
        return try await resultAfterAction(response, args)
    }

    private func handleReadPage(_ args: [String: Value]) async throws -> CallTool.Result {
        let response = try await send("read_page", args, params: try Self.readPageParams(args))
        return textResult(response, as: "page", decoding: args["format"]?.stringValue == "snapshot" ? .containers : .text)
    }

    private func handleSnapshot(_ args: [String: Value]) async throws -> CallTool.Result {
        let response = try await send("snapshot", args, params: try Self.snapshotParams(args))
        return textResult(response, as: "snapshot")
    }

    private func handleFind(_ args: [String: Value]) async throws -> CallTool.Result {
        let response = try await send("find", args, params: try Self.findParams(args))
        return textResult(response, as: "matches")
    }

    /// Reads the caller's local files, then runs the interaction with them attached.
    private func handleFileAction(_ action: String, _ args: [String: Value]) async throws -> CallTool.Result {
        let inputs = try Self.fileAttachmentInputs(args)

        let attachments: [FileAttachment]
        do {
            attachments = try FileAttachmentLoader.load(paths: inputs.paths, mimeTypeOverride: inputs.mimeType)
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
        return try await runNativeAction("native_type_text", args) { _ in
            try await Self.typeNativeText(input, deadline: Self.numberValue(args["_batchDeadline"]))
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
    //
    // Preparation and posting run under the focus lock as one unit. The
    // extension focuses the tab or element during preparation, and the events
    // are only right while that focus holds; a parallel call that focuses
    // something else in between would take the keystrokes or the click.
    private func runNativeAction(
        _ action: String,
        _ args: [String: Value],
        perform: (BridgeResponse) async throws -> String
    ) async throws -> CallTool.Result {
        try Self.ensureNativeInputPermission()
        let traceSession = try await startTraceIfNeeded(args)
        do {
            let (preparation, delivered) = try await focusLock.withLock { () -> (BridgeResponse, String?) in
                let preparation = try await send(action, args, params: interactionParams(args))
                guard preparation.success else { return (preparation, nil) }
                return (preparation, try await perform(preparation))
            }
            guard let message = delivered else {
                return try await resultAfterAction(preparation, args, traceSession: traceSession)
            }

            let response = BridgeResponse(
                id: preparation.id,
                success: true,
                data: AnyCodable(message),
                error: nil,
                errorCode: nil,
                retryable: nil,
                recoveryAction: nil,
                resolvedTabId: preparation.resolvedTabId,
                profileIndex: preparation.profileIndex
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
        let combo = try Self.nativeKeyCombo(Self.requiredKey(args))
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
        // Validated before the bridge call (see `preflight`): a targeted capture
        // scrolls the page, and a refused destination should not have cost that.
        let padding = try Self.capturePadding(args)
        let scale = try Self.captureScale(args)
        // The extension may activate the tab before capturing it, so the capture
        // queues with the other focus-sensitive tools rather than racing them.
        // The extension may activate the tab before capturing it, so the capture
        // queues with the other focus-sensitive tools rather than racing them.
        let response = try await focusLock.withLock { try await send("screenshot", args, params: params) }

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

        if let path = try Self.optionalString("filePath", in: args) {
            let url: URL
            do {
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
        let response = try await send("javascript_tool", args, params: try Self.javaScriptParams(args))
        return textResult(response, as: "result", decoding: .json)
    }

    private func handleReadConsole(_ args: [String: Value]) async throws -> CallTool.Result {
        let response = try await send("read_console", args, params: try Self.readConsoleParams(args))
        return textResult(response, as: "messages")
    }

    private func handleReadNetwork(_ args: [String: Value]) async throws -> CallTool.Result {
        let response = try await send("read_network", args, params: try Self.readNetworkParams(args))
        return textResult(response, as: "requests")
    }

    private func handleResizeWindow(_ args: [String: Value]) async throws -> CallTool.Result {
        let response = try await send("resize_window", args, params: try Self.resizeWindowParams(args))
        return textResult(response, as: "window")
    }

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
        let pin = BatchTabPin()
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
            // With no batch tab, step 1 acts on whichever tab is selected and
            // every later step acts on that same one, even if the selection
            // moves while the batch runs.
            if stepArguments["tabId"] == nil, let tab = pin.handle {
                stepArguments["tabId"] = .string(tab.description)
            }
            let result = await Self.$batchPin.withValue(pin) {
                await handleToolCall(.init(name: step.tool, arguments: stepArguments))
            }
            if batchArgs["tabId"] == nil, let tab = pin.handle {
                batchArgs["tabId"] = .string(tab.description)
            }
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
        let request = try Self.waitRequest(args)
        switch request {
        case .duration(let requested):
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

        case .condition(let selector, let text, let timeout):
            var params: [String: AnyCodable] = [:]
            if let selector { params["selector"] = AnyCodable(selector) }
            if let text { params["text"] = AnyCodable(text) }
            let userTimeout = min(timeout, Self.batchRemaining(args))
            params["timeout"] = AnyCodable(userTimeout)
            // Extend bridge timeout to exceed the wait timeout so it doesn't race
            let response = try await send(
                "wait", args,
                params: params,
                timeout: Self.bridgeTimeout(args, default: userTimeout + 5)
            )
            return textResult(response, as: "wait")
        }
    }

    // MARK: - Helpers

    private struct TraceSession {
        let id: String
        let duration: Double
        /// The tab `start_trace` resolved, when the extension reported one.
        let tab: TabHandle?
    }

    private func resultAfterAction(
        _ response: BridgeResponse,
        _ args: [String: Value],
        wantSnapshot: Bool? = nil,
        traceSession: TraceSession? = nil
    ) async throws -> CallTool.Result {
        // Everything after the action goes to the tab the action went to.
        let args = Self.pinned(args, to: response)
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
        // Every option is validated before `start_trace` goes out, so a bad one
        // cannot leave a trace running that nothing will stop.
        guard let options = try Self.traceOptions(args) else { return nil }

        var params: [String: AnyCodable] = [:]
        if let eventTypes = options.eventTypes { params["eventTypes"] = AnyCodable(eventTypes) }

        let response = try await send("start_trace", args, params: params)
        guard response.success else { throw ToolInputError(responseText(response)) }
        guard let traceID = response.data?.stringValue, !traceID.isEmpty else {
            throw ToolInputError("Trace did not return an id")
        }

        return TraceSession(
            id: traceID,
            duration: options.duration,
            tab: Self.resolvedHandle(of: response)
        )
    }

    private func stopTraceResponse(
        _ traceSession: TraceSession,
        _ args: [String: Value],
        waitForDuration: Bool = true
    ) async throws -> BridgeResponse {
        // The trace lives on the tab it was started on. Stopping it is aimed
        // there when nothing more specific names a tab.
        var args = args
        if args["tabId"] == nil || args["tabId"] == .null, let tab = traceSession.tab {
            args["tabId"] = .string(tab.description)
        }
        if waitForDuration, traceSession.duration > 0 {
            try await Task.sleep(for: .seconds(min(traceSession.duration, Self.batchRemaining(args))))
        }

        return try await send("stop_trace", args, params: ["id": AnyCodable(traceSession.id)])
    }

    private func waitAfterAction(_ args: [String: Value]) async throws -> BridgeResponse? {
        guard let wait = try Self.postActionWait(args) else { return nil }
        var params: [String: AnyCodable] = [:]
        if let selector = wait.selector { params["selector"] = AnyCodable(selector) }
        if let text = wait.text { params["text"] = AnyCodable(text) }
        let timeout = min(wait.timeout, Self.batchRemaining(args))
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

    private static func batchRemaining(_ args: [String: Value]) -> Double {
        guard let deadline = numberValue(args["_batchDeadline"]) else { return .infinity }
        return max(0, deadline - ProcessInfo.processInfo.systemUptime)
    }

    private static func bridgeTimeout(_ args: [String: Value], default defaultTimeout: Double = 30) -> Double {
        max(0.1, min(defaultTimeout, batchRemaining(args)))
    }
}
