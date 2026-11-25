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

    /// Held for the whole of every call to a tool that is not annotated read-only.
    ///
    /// Almost everything that acts can move focus or change what is frontmost:
    /// `tabs_create` activates the new tab, `close_tab` hands focus to another,
    /// `resize_window` and `click` can raise a window, `javascript_tool` can do
    /// any of it. And the tools that depend on focus (native input, `screenshot`)
    /// prepare it in one bridge request and use it in the next, so none of those
    /// may run in between. A list of the tools that move focus would be wrong
    /// the first time one was added; the annotation each tool already carries is
    /// the rule, and it errs towards waiting. Read-only tools touch nothing and
    /// run alongside everything.
    ///
    /// A `run_steps` batch holds it once for all its steps, which run without
    /// asking for it again: the lock is not reentrant.
    private let focusLock = AsyncFIFOLock()

    init(
        port: UInt16 = 8089,
        portCount: UInt16 = WebSocketBridge.defaultPortCount,
        logger: Logger,
        connectGraceTimeout: Duration = WebSocketBridge.defaultConnectGraceTimeout,
        instance: InstanceIdentity = InstanceIdentity()
    ) throws {
        self.logger = logger
        self.bridge = try WebSocketBridge(
            port: port,
            portCount: portCount,
            logger: logger,
            connectGraceTimeout: connectGraceTimeout,
            instance: instance
        )
        self.server = Server(
            name: "mcp-safari",
            version: MCPSafariProduct.version,
            instructions: """
                Safari browser automation. Use tabs_context to list tabs, snapshot for element UIDs, \
                then click/type_text/hover by UID. Use includeSnapshot on interactions to see updated state. \
                Tab handles look like p0t5, where p0 names the Safari profile; read them from \
                tabs_context rather than composing them. If a call reports bridge_disconnected right after \
                startup or a reconnect, call status or retry in a few seconds before assuming Safari is closed.
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
            try await server.start(transport: transport) { [weak self] info, _ in
                await self?.clientIntroduced(info)
            }
            logger.info("Safari MCP server started")
            await server.waitUntilCompleted()
        } catch {
            await bridge.stop()
            throw error
        }
        await bridge.stop()
    }

    /// Tells Safari which MCP client is behind this server, for the tooltip on the
    /// connection's row in the popup. Profiles that connect later get it in the
    /// handshake. Not awaited by `initialize`: Safari may not be there yet, and a
    /// label is no reason to hold up the client. An extension that predates
    /// naming answers `identify` with "Unknown action", which is ignored with
    /// every other failure here.
    private func clientIntroduced(_ info: Client.Info) async {
        let client = ClientIdentity(name: String(info.name.prefix(100)), version: String(info.version.prefix(100)))
        await bridge.setClient(client)
        Task { [bridge] in
            _ = try? await bridge.broadcast(action: "identify", params: client.parameters, timeout: 5, waitForConnection: false)
        }
    }

    /// Takes the bridge down and removes its token files. For a signal, which ends the
    /// process without letting `start()` return.
    func shutdown() async {
        await bridge.stop()
    }

    // MARK: - Tool Registration

    private func registerToolHandlers() async {
        let allTools = Self.toolDefinitions

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

    /// A call from a client. Its arguments are checked against the tool's schema
    /// before anything runs, and `_batchDeadline` is no argument a client may give.
    private func handleToolCall(_ params: CallTool.Parameters) async -> CallTool.Result {
        let args = params.arguments ?? [:]
        do {
            try Self.preflight(tool: params.name, arguments: args)
        } catch {
            return Self.failureResult(toolFailure(for: error))
        }
        guard Self.declaresTool(params.name), !Self.readOnlyTools.contains(params.name) else {
            return await dispatch(tool: params.name, arguments: args)
        }
        do {
            return try await focusLock.withLock { await dispatch(tool: params.name, arguments: args) }
        } catch {
            // Cancelled while queued: it never ran.
            return Self.failureResult(toolFailure(for: error))
        }
    }

    /// Runs a tool whose arguments are already checked. A `run_steps` batch checks
    /// every step while it plans and then calls here, adding the deadline and tab
    /// it pins to the arguments after that check, so each step reports its own
    /// page's visibility.
    private func dispatch(tool: String, arguments args: [String: Value]) async -> CallTool.Result {
        let report = PageVisibilityReport()
        let result = await Self.$pageVisibility.withValue(report) {
            do {
                if Self.focusMovingTools.contains(tool) { try await waitForSafari(args) }
                return try await Self.whileNoServerTypes(tool, timeout: Self.bridgeTimeout(args)) {
                    await dispatchUnreported(tool: tool, arguments: args)
                }
            } catch {
                // Refused while another server typed, so it never ran.
                return Self.failureResult(toolFailure(for: error))
            }
        }
        // A screenshot reads visibility itself and says so in its own words.
        guard report.sawHidden, tool != "screenshot" else { return result }
        return Self.notingHiddenPage(result)
    }

    /// Waits, within the call's own time, for Safari to connect the profile the
    /// call is for. A call takes this wait before the native input lock, never
    /// while holding it, so a server whose Safari is reconnecting doesn't keep
    /// every other server's typing waiting too.
    private func waitForSafari(_ args: [String: Value]) async throws {
        let profileIndex = try TabHandle.resolve(args["tabId"])?.profileIndex
        try await bridge.waitForConnection(profileIndex: profileIndex, timeout: .seconds(Self.bridgeTimeout(args)))
    }

    /// Runs a call that can move Safari's keyboard once no server is typing,
    /// and any other call at once. A server sending native input holds the lock
    /// alone for as long as it types, so a new window or tab switch from another
    /// agent can't take the keyboard from under its text.
    static func whileNoServerTypes<T>(
        _ tool: String,
        timeout: Double,
        lockURL: URL = NativeInputLock.defaultURL,
        isolation: isolated (any Actor)? = #isolation,
        _ body: () async throws -> T
    ) async throws -> T {
        guard focusMovingTools.contains(tool) else { return try await body() }
        return try await NativeInputLock.withLock(at: lockURL, timeout: timeout, shared: true, body)
    }

    private func dispatchUnreported(tool: String, arguments args: [String: Value]) async -> CallTool.Result {
        let params = (name: tool, arguments: args)
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
            case "click":           return try await handleClick(args)
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
            case "clear_cookies":   return try await handleClearCookies(args)
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
        Self.pageVisibility?.record(response)
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

    /// Whether a page this tool call read or acted on said it wasn't showing.
    /// Set around each tool call by `dispatch`, and fed by `send`, where
    /// responses arrive.
    @TaskLocal static var pageVisibility: PageVisibilityReport?

    final class PageVisibilityReport: Sendable {
        private let hidden = OSAllocatedUnfairLock(initialState: false)

        var sawHidden: Bool { hidden.withLock { $0 } }

        /// A `page_hidden` or `page_not_responding` failure already says why,
        /// in more detail than the note could.
        func record(_ response: BridgeResponse) {
            guard response.pageVisibility == "hidden",
                  !["page_hidden", "page_not_responding"].contains(response.errorCode ?? "")
            else { return }
            hidden.withLock { $0 = true }
        }
    }

    static let hiddenPageNote = "Page visibility: hidden. This tab's window is minimized, completely "
        + "covered by other windows or on another Space, or another tab is showing in its window, and "
        + "Safari pauses pages it isn't showing. Some web apps show stale or empty content until the page "
        + "is visible again. If this result looks wrong, bring the tab to the front with select_tab, or "
        + "ask the user to make its window at least partly visible."

    /// `result` with the hidden-page note after its text, and `pageVisibility`
    /// beside its payload. Most reads and writes work on a hidden page, so the
    /// call stands; the note is there for a result that looks wrong.
    static func notingHiddenPage(_ result: CallTool.Result) -> CallTool.Result {
        var structured = result.structuredContent
        if case var .object(fields) = structured {
            fields["pageVisibility"] = .string("hidden")
            structured = .object(fields)
        }
        var noted = CallTool.Result(
            content: result.content + [textContent(hiddenPageNote)],
            structuredContent: structured,
            isError: result.isError
        )
        noted._meta = result._meta
        return noted
    }

    /// Rewrites the `id` of a tab object the extension returned into the handle
    /// that names it, so the only tab identifier a caller ever sees is one they
    /// can hand straight back.
    private func tabResult(_ response: BridgeResponse, profileIndex: Int, newWindowRequested: Bool = false) -> CallTool.Result {
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
        if let note = Self.newWindowNote(requested: newWindowRequested, tab: tab) { content.append(Self.textContent(note)) }
        return CallTool.Result(
            content: content,
            structuredContent: .object(["tab": (try? Value(tab)) ?? .null])
        )
    }

    /// An extension older than `newWindow` ignores it and opens the tab in the
    /// window in front, and says nothing. One that opened a window says so in
    /// the tab it reports, so its absence is how the caller hears about the
    /// first case rather than believing it has a window of its own.
    static func newWindowNote(requested: Bool, tab: [String: AnyCodable]) -> String? {
        guard requested, tab["newWindow"]?.boolValue != true else { return nil }
        return "The Safari extension is older than this server and opened the tab in the window in front, "
            + "not in a new window. Update the MCPSafari app to get newWindow; until then, ask the user "
            + "for a window of your own."
    }

    /// Tabs on a site the extension hasn't confirmed access to are listed,
    /// selected and created like any other and carry `access: "not_granted"` and
    /// an `accessHint`. The JSON carries that for a program; this note is for the
    /// model reading the result, once for a whole listing rather than once per
    /// tab.
    ///
    /// `not_granted` means unconfirmed: the extension learns a site is allowed
    /// only when a call works there, so after a reinstall every allowed site
    /// reads this way until then. The note says what the next call will do
    /// rather than that it will fail, and it is the server's own words, so a
    /// listing from an older extension, whose hint says "not granted", is not
    /// repeated back.
    static func accessNote(for tabs: [[String: AnyCodable]]) -> String? {
        let unconfirmed = tabs.filter { $0["access"]?.stringValue == "not_granted" }.count
        guard unconfirmed > 0 else { return nil }
        let subject = unconfirmed == 1
            ? "One tab is on a site MCPSafari hasn't confirmed access to, so its URL and title are withheld."
            : "\(unconfirmed) tabs are on sites MCPSafari hasn't confirmed access to, so their URLs and titles are withheld."
        return subject
            + " A call on such a tab works if the user has allowed its site, and later listings then describe the tab."
            + " If not, the call fails with permission_required, and the user can allow the site"
            + " from the MCPSafari button in Safari's toolbar."
    }

    /// Which profile a call will land on. An explicit handle names it; otherwise it
    /// is whichever profile the bridge drives right now. Resolved once and reused
    /// for both the routing and the handle, so a tab cannot be created in one
    /// profile and named as if it were in another.
    private func resolveProfileIndex(_ args: [String: Value]) async throws -> Int {
        if let handle = try TabHandle.resolve(args["tabId"]) { return handle.profileIndex }
        if await bridge.connectedProfiles().isEmpty {
            try await bridge.waitForConnection(timeout: .seconds(Self.bridgeTimeout(args)))
        }
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
        let instance = Self.instanceStatus(bridge.instance, client: await bridge.client)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(status)
        var content = [Self.textContent(String(decoding: data, as: UTF8.self))]
        content.append(Self.textContent(Self.jsonText(["instance": AnyCodable(instance)]) ?? "{}"))
        return CallTool.Result(
            content: content,
            structuredContent: .object([
                "status": try Value(status),
                "instance": try Value(AnyCodable(instance)),
            ])
        )
    }

    /// Who this server tells Safari it is: its name, the folder it was started in,
    /// and the MCP client behind it.
    static func instanceStatus(_ instance: InstanceIdentity, client: ClientIdentity?) -> [String: AnyCodable] {
        var object: [String: AnyCodable] = [:]
        object["name"] = AnyCodable(instance.name ?? NSNull())
        object["folder"] = AnyCodable(instance.folder ?? NSNull())
        if let client {
            object["client"] = AnyCodable(["name": AnyCodable(client.name), "version": AnyCodable(client.version ?? NSNull())])
        }
        return object
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
        var params = try Self.tabsCreateParams(args)
        // The named tab's window is where the new tab opens, so the extension
        // needs the tab as well as the profile it picks.
        if let handle = try TabHandle.resolve(args["tabId"]) { params["tabId"] = AnyCodable(handle.tabID) }
        let response = try await bridge.send(
            action: "tabs_create",
            params: params,
            timeout: Self.bridgeTimeout(args),
            profileIndex: profileIndex
        )
        return tabResult(response, profileIndex: profileIndex, newWindowRequested: params["newWindow"] != nil)
    }

    private func handleCloseTab(_ args: [String: Value]) async throws -> CallTool.Result {
        let handle = try Self.requiredTabHandle(args, tool: "close_tab")
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
        let handle = try Self.requiredTabHandle(args, tool: "select_tab")
        let params = try Self.selectTabParams(args)
        let response = try await send("select_tab", args, params: params)
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
        return findResult(response)
    }

    /// Sends the caller's local files to the page a chunk at a time, then runs the
    /// interaction with them attached.
    ///
    /// The content script of the frame holding the target keeps the files until
    /// the action: `stage_files` finds the target and opens a transfer there,
    /// each `file_chunk` adds to it, and `upload_file` or `drop_file` builds the
    /// files from what arrived. The chunks stay in the content script's isolated
    /// world, so the page sees nothing until it is handed the finished files.
    private func handleFileAction(_ action: String, _ args: [String: Value]) async throws -> CallTool.Result {
        let inputs = try Self.fileAttachmentInputs(args)
        let files: [OpenedFile]
        do {
            files = try FileAttachmentLoader.open(paths: inputs.paths, mimeTypeOverride: inputs.mimeType)
        } catch let error as FileAttachmentError {
            throw ToolInputError(error.description)
        }
        defer { FileAttachmentLoader.close(files) }

        var stageParams = interactionParams(args, skipKeys: Self.fileInputKeys)
        stageParams["intent"] = AnyCodable(action)
        stageParams["files"] = AnyCodable(files.map { file in
            AnyCodable([
                "name": AnyCodable(file.name),
                "type": AnyCodable(file.mimeType),
                "size": AnyCodable(file.size),
            ] as [String: AnyCodable])
        })
        let staged = try await send("stage_files", args, params: stageParams)
        guard staged.success else { return Self.failureResult(staged.toolFailure) }
        guard let transfer = Self.stagedTransfer(staged) else {
            return Self.failureResult(ToolFailure(
                code: "extension_error",
                message: "The Safari extension did not say where it is keeping the files.",
                retryable: false,
                recoveryAction: "inspect_error"
            ))
        }
        // Every chunk, and the action, go to the tab the target was found in.
        let args = Self.pinned(args, to: staged)

        do {
            for (index, file) in files.enumerated() {
                var offset = 0
                while offset < file.size {
                    let bytes: Data
                    do {
                        bytes = try FileAttachmentLoader.chunk(of: file, at: offset)
                    } catch let error as FileAttachmentError {
                        throw ToolInputError(error.description)
                    }
                    let sent = try await send("file_chunk", args, params: [
                        "transfer": transfer,
                        "file": AnyCodable(index),
                        "offset": AnyCodable(offset),
                        "data": AnyCodable(bytes.base64EncodedString()),
                    ])
                    guard sent.success else {
                        await discardStagedFiles(transfer, args)
                        return Self.failureResult(sent.toolFailure)
                    }
                    offset += bytes.count
                }
                // Before the page is handed anything, so a file that changed
                // while it was read is let go rather than delivered.
                do {
                    try FileAttachmentLoader.confirmUnchanged(file)
                } catch let error as FileAttachmentError {
                    throw ToolInputError(error.description)
                }
            }
            let result = try await handleInteraction(
                action,
                args,
                extraParams: ["transfer": transfer],
                skipKeys: Self.fileInputKeys
            )
            // The action takes the files whether it succeeds or not; this lets go
            // of them if it never reached the content script.
            if result.isError == true { await discardStagedFiles(transfer, args) }
            return result
        } catch {
            await discardStagedFiles(transfer, args)
            throw error
        }
    }

    /// The transfer `stage_files` opened: its id and the frame that holds it.
    static func stagedTransfer(_ response: BridgeResponse) -> AnyCodable? {
        guard let raw = response.data?.stringValue,
              let data = raw.data(using: .utf8),
              let reply = try? JSONDecoder().decode([String: AnyCodable].self, from: data),
              let id = reply["transferId"]?.stringValue,
              let frameId = reply["frameId"]?.intValue
        else { return nil }
        return AnyCodable(["id": AnyCodable(id), "frameId": AnyCodable(frameId)] as [String: AnyCodable])
    }

    /// Best effort: the content script also lets go of a transfer nothing has
    /// added to for a minute, and a page that navigated has dropped it already.
    private func discardStagedFiles(_ transfer: AnyCodable, _ args: [String: Value]) async {
        _ = try? await send("discard_files", args, params: ["transfer": transfer])
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
        // The action goes to the tab the trace is on, not to whichever is selected
        // by the time it is sent.
        let args = traceSession?.pinning(args) ?? args
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
    // Preparation and posting are one unit. The extension focuses the tab or
    // element during preparation, and the events are only right while that focus
    // holds. Inside this process the call already holds the focus lock, so no
    // parallel call can focus something else in between; across processes, the
    // native input lock does the same for the other servers sharing the keyboard.
    private func runNativeAction(
        _ action: String,
        _ args: [String: Value],
        perform: (BridgeResponse) async throws -> String
    ) async throws -> CallTool.Result {
        // Before the trace starts and before the extension is asked to focus
        // anything: neither is worth doing for input that will be refused.
        try Self.ensureNativeInputReady()
        let traceSession = try await startTraceIfNeeded(args)
        let args = traceSession?.pinning(args) ?? args
        do {
            try await waitForSafari(args)
            let (preparation, delivered) = try await NativeInputLock.withLock(
                timeout: Self.bridgeTimeout(args)
            ) { () -> (BridgeResponse, String?) in
                // Inside the lock, so another server's typing has finished and
                // been recorded, and before anything is focused or raised.
                try UserActivity.ensureIdle()
                let preparation = try await Self.prepareNativeInput(
                    pointer: action == "native_pointer",
                    pageFocus: .live
                ) { windowVerified in
                    var params = interactionParams(args)
                    if windowVerified { params["windowVerified"] = AnyCodable(true) }
                    return try await send(action, args, params: params)
                }
                guard preparation.success else { return (preparation, nil) }
                // Recorded however the posting ends, since some events may be out.
                defer { UserActivity.recordOwnInput() }
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
            try await Self.pressNativeKey(combo, deadline: Self.numberValue(args["_batchDeadline"]))
        }
    }

    // MARK: - Native pointer (click, hover, drag native=true)

    private func handleClick(_ args: [String: Value]) async throws -> CallTool.Result {
        guard try nativeRequested(args) else {
            return try await handleInteraction("click", args)
        }
        let clickCount = args["doubleClick"]?.boolValue == true ? 2 : 1
        return try await runNativeAction("native_pointer", args) { preparation in
            let targets = try Self.placedPointerTargets(preparation)
            return try await Self.clickNativePointer(
                at: targets.from, clickCount: clickCount, deadline: Self.numberValue(args["_batchDeadline"]),
                agentWindow: targets.window
            )
        }
    }

    /// The extension's pointer points placed on screen through Accessibility.
    private static func placedPointerTargets(_ preparation: BridgeResponse) throws -> PlacedPointerTargets {
        try placedPointerTargets(nativePointerTargets(from: preparation.data), windows: NativePageFocus.live.windows())
    }

    private func handleHover(_ args: [String: Value]) async throws -> CallTool.Result {
        guard try nativeRequested(args) else {
            return try await handleInteraction("hover", args)
        }
        return try await runNativeAction("native_pointer", args) { preparation in
            let targets = try Self.placedPointerTargets(preparation)
            _ = try await Self.moveNativePointer(
                to: targets.from, deadline: Self.numberValue(args["_batchDeadline"]), agentWindow: targets.window
            )
            return "Hovered with native input; pointer at (\(Int(targets.from.x)), \(Int(targets.from.y)))"
        }
    }

    private func handleDrag(_ args: [String: Value]) async throws -> CallTool.Result {
        guard try nativeRequested(args) else {
            return try await handleInteraction("drag", args)
        }
        return try await runNativeAction("native_pointer", args) { preparation in
            let targets = try Self.placedPointerTargets(preparation)
            guard let to = targets.to else {
                throw ToolInputError("drag requires toUid or toSelector")
            }
            return try await Self.dragNativePointer(
                from: targets.from, to: to, deadline: Self.numberValue(args["_batchDeadline"]), agentWindow: targets.window
            )
        }
    }

    private func handleFormInput(_ args: [String: Value]) async throws -> CallTool.Result {
        let params: [String: AnyCodable] = ["fields": AnyCodable(try Self.formInputFields(args))]
        let traceSession = try await startTraceIfNeeded(args)
        let args = traceSession?.pinning(args) ?? args
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

    /// Acts on a profile, not a tab: `tabId` only names which profile, as it does
    /// for `tabs_create`, and is not sent.
    private func handleClearCookies(_ args: [String: Value]) async throws -> CallTool.Result {
        let response = try await bridge.send(
            action: "clear_cookies",
            params: try Self.clearCookiesParams(args),
            timeout: Self.bridgeTimeout(args),
            profileIndex: try await resolveProfileIndex(args)
        )
        return textResult(response, as: "cookies")
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
        // A trace lives on the tab it started on, and that is the batch's tab: the
        // steps that name none act there, and the trace and the final snapshot are
        // read from there. Left to the first step's response, a first step on some
        // other tab would have made that the batch's tab and stopped the trace on a
        // tab that has none.
        if let tab = traceSession?.tab {
            pin.recordFirst(tab)
            batchArgs = traceSession?.pinning(batchArgs) ?? batchArgs
        }
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
                await dispatch(tool: step.tool, arguments: stepArguments)
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

        /// `args` aimed at that tab when the caller named none. The action the
        /// trace is for happens there, and so does everything that follows it.
        func pinning(_ args: [String: Value]) -> [String: Value] {
            guard args["tabId"] == nil || args["tabId"] == .null, let tab else { return args }
            var pinned = args
            pinned["tabId"] = .string(tab.description)
            return pinned
        }
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
        // A step after the action can fail when the action itself did not. The
        // failure carries everything gathered so far in `details`, so a caller
        // told the wait timed out can still read what the click returned.
        guard response.success else {
            details["result"] = nil // the action failed; the failure is its result
            if let traceSession {
                let traceResponse = try await stopTraceResponse(traceSession, args, waitForDuration: false)
                content.append(Self.textContent("--- Page Trace ---\n\(responseText(traceResponse))"))
                details["trace"] = Self.structuredPayload(traceResponse.data)
            }
            return Self.failureResult(response.toolFailure, content: content, details: details)
        }

        if let waitResponse = try await waitAfterAction(args) {
            guard waitResponse.success else {
                content.append(Self.textContent(responseText(waitResponse)))
                if let traceSession {
                    let traceResponse = try await stopTraceResponse(traceSession, args, waitForDuration: false)
                    content.append(Self.textContent("--- Page Trace ---\n\(responseText(traceResponse))"))
                    details["trace"] = Self.structuredPayload(traceResponse.data)
                }
                return Self.failureResult(waitResponse.toolFailure, content: content, details: details)
            }
            content.append(Self.textContent(responseText(waitResponse)))
            details["wait"] = Self.structuredPayload(waitResponse.data)
        }

        if let traceSession {
            let traceResponse = try await stopTraceResponse(traceSession, args)
            details["trace"] = Self.structuredPayload(traceResponse.data)
            content.append(Self.textContent("--- Page Trace ---\n\(responseText(traceResponse))"))
            guard traceResponse.success else {
                return Self.failureResult(traceResponse.toolFailure, content: content, details: details)
            }
        }

        if wantSnapshot ?? args["includeSnapshot"]?.boolValue == true {
            let snapResponse = try await snapshotResponse(args)
            details["snapshot"] = Self.structuredPayload(snapResponse.data)
            let snapText = responseText(snapResponse)
            content.append(Self.textContent("--- Page Snapshot ---\n\(snapText)"))
            guard snapResponse.success else {
                return Self.failureResult(snapResponse.toolFailure, content: content, details: details)
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
        // The trace lives on the tab it was started on, so stopping it goes there
        // whatever tab the rest of the call has been addressed to: a batch whose
        // first step is on another tab would otherwise stop it where there is none.
        var args = args
        if let tab = traceSession.tab {
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
