import MCP

// MARK: - Tool Catalog

/// The advertised tool surface: every `inputSchema` the server publishes, and
/// the shared fragments those schemas are assembled from.
///
/// This is pure declaration. Nothing in here reads actor state, which is what
/// lets it sit apart from the handlers that do.
extension SafariMCPServer {
    // MARK: - Shared Schema Fragments (terse to minimize token usage)

    private static let tab: Value = .object([
        "type": .string("string"),
        "description": .string("Tab handle from tabs_context, such as p0t5 (default: selected tab)"),
    ])
    private static let uid: Value = .object(["type": .string("string"), "description": .string("Element UID from snapshot")])
    private static let sel: Value = .object(["type": .string("string"), "description": .string("CSS selector")])
    private static let txt: Value = .object(["type": .string("string"), "description": .string("Visible text to match")])
    private static let force: Value = .object(["type": .string("boolean"), "description": .string("Dispatch even when another element covers the target")])
    private static let snap: Value = .object(["type": .string("boolean"), "description": .string("Return snapshot after action")])
    private static let coordX: Value = .object(["type": .string("number"), "description": .string("Viewport x in CSS px; events dispatch at this exact point (overrides uid/selector/text)")])
    private static let coordY: Value = .object(["type": .string("number"), "description": .string("Viewport y in CSS px")])
    private static let nativeRequirements = "Requires Safari to already be the frontmost application and Accessibility permission. Native input takes over the user's keyboard and mouse, so ask the user before bringing Safari to the front unless they have already allowed it."
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
    // MARK: - Tool Definitions

    func buildToolDefinitions() -> [Tool] {
        [
            Tool(
                name: "status",
                description: "Report local Safari MCP listener, authentication, version, token health, and which Safari profiles are connected. Each profile's handle (p0, p1) is the prefix of its tab handles, and one profile is marked selected: that is where a call naming no tab lands. Works without an extension connection.",
                inputSchema: .object(["type": .string("object"), "properties": .object([:])]),
                annotations: .init(readOnlyHint: true, openWorldHint: false)
            ),

            // ── Tabs ─────────────────────────────────────────────────

            Tool(
                name: "tabs_context",
                description: "List open tabs across every connected Safari profile, with handles, URLs, titles. Each id is a handle such as p0t5; pass it back as tabId.",
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
                description: "Close a tab by handle.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(["tabId": Self.tab]),
                    "required": .array([.string("tabId")]),
                ]),
                annotations: .init(readOnlyHint: false, destructiveHint: true)
            ),
            Tool(
                name: "select_tab",
                description: "Pin a tab as default context for future calls, including its Safari profile. Activates and focuses the tab unless bringToFront is false.",
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
                description: "Accessibility tree with element UIDs for interaction tools. UIDs change between snapshots. Capped at 2000 nodes by default; a cut tree marks the root `truncated` and each parent whose children were dropped `childrenTruncated`.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "maxNodes": .object([
                            "type": .string("integer"),
                            "description": .string("Maximum nodes to return (default 2000)"),
                        ]),
                        "tabId": Self.tab,
                    ]),
                ]),
                annotations: .init(readOnlyHint: true)
            ),
            Tool(
                name: "read_page",
                description: "Page content as text, html, or snapshot. Text and html are capped at 100000 characters by default and say so when cut; snapshot takes maxNodes.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "format": .object(["type": .string("string"), "enum": .array([.string("text"), .string("html"), .string("snapshot")])]),
                        "maxChars": .object([
                            "type": .string("integer"),
                            "description": .string("Character cap for text and html (default 100000)"),
                        ]),
                        "maxNodes": .object([
                            "type": .string("integer"),
                            "description": .string("Node cap when format is snapshot (default 2000)"),
                        ]),
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
                description: "Click element by UID, selector, text, or x/y coordinates. Text that matches several elements equally fails with their UIDs. A target covered by another element (modal, banner) fails with target_covered, and one outside the viewport with target_not_visible, unless force=true.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(Self.withActionOptions([
                        "uid": Self.uid, "selector": Self.sel, "text": Self.txt,
                        "x": Self.coordX,
                        "y": Self.coordY,
                        "doubleClick": .object(["type": .string("boolean")]),
                        "force": Self.force,
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
                            "description": .string("Types one character at a time with real macOS key events; this is not paste, and keystrokes follow focus into whatever app is frontmost. Use only for short input that synthetic typing cannot enter, never for bulk text or source code. " + Self.nativeRequirements),
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
                description: "Press key combo (Enter, Tab, Meta+a, Control+c). Set native=true for a real macOS key event that triggers default actions (focus moves, dialog dismiss).",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(Self.withActionOptions([
                        "key": .object(["type": .string("string")]),
                        "native": .object([
                            "type": .string("boolean"),
                            "description": .string("Use a real macOS key event. " + Self.nativeRequirements),
                        ]),
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ])),
                    "required": .array([.string("key")]),
                ])
            ),
            Tool(
                name: "hover",
                description: "Hover element to trigger tooltips/menus. Dispatches pointer and mouse events; synthetic events never apply CSS :hover. Set native=true to move the real OS pointer there, producing true :hover state and boundary events along the path. Synthetic hover fails with target_covered or target_not_visible when a real pointer could not reach the target, unless force=true.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(Self.withActionOptions([
                        "uid": Self.uid, "selector": Self.sel, "text": Self.txt,
                        "x": Self.coordX,
                        "y": Self.coordY,
                        "native": .object([
                            "type": .string("boolean"),
                            "description": .string("Move the real OS pointer. " + Self.nativeRequirements),
                        ]),
                        "force": Self.force,
                        "includeSnapshot": Self.snap, "tabId": Self.tab,
                    ])),
                ])
            ),
            Tool(
                name: "drag",
                description: "Drag and drop between elements along an interpolated pointer-event path plus HTML5 drag events. Set native=true for a real macOS mouse drag that threshold-based drag libraries (pointer sensors) accept. A synthetic drag scrolls to both ends and hit-tests each, failing with target_covered or target_not_visible when one of them is somewhere a real pointer could not reach, unless force=true.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object(Self.withActionOptions([
                        "fromUid": .object(["type": .string("string")]),
                        "toUid": .object(["type": .string("string")]),
                        "fromSelector": .object(["type": .string("string")]),
                        "toSelector": .object(["type": .string("string")]),
                        "native": .object([
                            "type": .string("boolean"),
                            "description": .string("Use real macOS mouse events. " + Self.nativeRequirements),
                        ]),
                        "force": Self.force,
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
                description: "Arm accept/dismiss for the next alert, confirm, or prompt within 30 seconds. Call before triggering the dialog, then call again to read the captured result. Native dialogs already open cannot be handled.",
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
                description: "Capture visible tab as PNG. Pass uid or selector to scroll that element into view and capture it with padding, scale to shrink the image, and filePath to save the PNG to disk and get the path back instead of inline image data.",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "uid": Self.uid, "selector": Self.sel,
                        "padding": .object(["type": .string("number"), "description": .string("CSS px kept around the element (default: 16)")]),
                        "scale": .object(["type": .string("number"), "description": .string("Shrink the PNG by this factor, 0 to 1 (default: 1)")]),
                        "filePath": .object(["type": .string("string"), "description": .string("Save the PNG to this local path (~ expanded) and return the path instead of the image")]),
                        "tabId": Self.tab,
                    ]),
                ]),
                annotations: .init(readOnlyHint: false)
            ),
            Tool(
                name: "javascript_tool",
                description: "Execute JS in page context. A single expression returns its value; a multi-statement body must end in an explicit `return` to produce a value. If the page's Content Security Policy forbids evaluating strings, this reruns in the extension's isolated world, where the DOM is shared but the page's own JavaScript globals are not visible; the result says so when that happens.",
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
                        "pattern": .object(["type": .string("string"), "description": .string("Bounded regex: literals, dots, anchors, character classes, alternation; no repetitions or groups (max 200 characters)")]),
                        "tabId": Self.tab,
                    ]),
                ]),
                annotations: .init(readOnlyHint: true)
            ),
            Tool(
                name: "read_network",
                description: "Read captured XHR/fetch requests; use type resource for resource timings (no status or headers). Filter with urlPattern (regex), status, and maxResults (most recent N).",
                inputSchema: .object([
                    "type": .string("object"),
                    "properties": .object([
                        "type": .object(["type": .string("string"), "enum": .array([.string("all"), .string("xhr"), .string("fetch"), .string("resource")])]),
                        "urlPattern": .object(["type": .string("string"), "description": .string("Bounded regex on URL: literals, dots, anchors, character classes, alternation; no repetitions or groups (max 200 characters)")]),
                        "status": .object(["type": .string("integer"), "description": .string("Filter by HTTP status code (fetch/xhr only; 0 means network error)")]),
                        "maxResults": .object(["type": .string("integer"), "description": .string("Return at most this many most recent entries")]),
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
}
