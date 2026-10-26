import Foundation
import MCP

// MARK: - Tool Parameters

/// What each tool sends the extension, validated.
///
/// Every function here is pure: it reads the caller's arguments and returns the
/// bridge parameters, or throws `ToolInputError` for the first thing wrong. The
/// handlers call them to build their request, and `preflight` calls the same
/// ones before a handler runs, so there is one definition of "valid" for a tool
/// and a bad argument is refused before any step of the call has acted.
extension SafariMCPServer {
    // MARK: Allowed values

    nonisolated static let allowedURLSchemes: Set<String> = ["http", "https", "about", "file"]
    nonisolated static let allowedNavActions: Set<String> = ["goto", "back", "forward", "reload"]
    nonisolated static let allowedPageFormats: Set<String> = ["text", "html", "snapshot"]
    nonisolated static let allowedConsoleLevels: Set<String> = ["all", "log", "warn", "error", "info", "debug"]
    nonisolated static let allowedNetworkTypes: Set<String> = ["all", "xhr", "fetch", "resource"]

    /// The most a caller can ask for in one result. Each sits an order of
    /// magnitude or so above the default, which is the point of raising a limit,
    /// and well inside what the 32 MiB bridge message and the client's own output
    /// limit can carry. Asking for more gets the maximum.
    nonisolated static let maxPageChars = 1_000_000 // default 100,000
    nonisolated static let maxSnapshotNodes = 10_000 // default 2,000
    nonisolated static let maxNetworkResults = 1_000 // the buffers hold 500 requests

    /// Safari clamps a window to the screen anyway; this only turns a typo such
    /// as an extra zero into a refusal rather than a request for the whole desktop.
    nonisolated static let maxWindowDimension = 10_000

    // MARK: Preflight

    /// Runs the validation for `tool` without sending anything. Called before
    /// the handler for every direct call, and by `run_steps` over each step while
    /// it plans, so a bad argument in step 7 is refused before step 1 acts.
    nonisolated static func preflight(tool: String, arguments args: [String: Value]) throws {
        if actionTools.contains(tool) {
            _ = try postActionWait(args)
            _ = try traceOptions(args)
            _ = try optionalBool("includeSnapshot", in: args)
        }
        if nativeCapableTools.contains(tool) {
            _ = try optionalBool("native", in: args)
        }
        switch tool {
        case "run_steps":
            _ = try traceOptions(args)
            _ = try optionalBool("includeSnapshot", in: args)
        case "type_text":
            // The permission is not checked here: whether this process holds
            // Accessibility is a fact about the machine, not about the arguments.
            if try optionalBool("native", in: args) == true { _ = try nativeInputPlan(args, permission: {}) }
        case "press_key":
            if try optionalBool("native", in: args) == true { _ = try nativeKeyCombo(requiredKey(args)) }
        case "upload_file", "drop_file": _ = try fileAttachmentInputs(args)
        case "screenshot":
            _ = try capturePadding(args)
            _ = try captureScale(args)
            if let path = try optionalString("filePath", in: args) {
                do {
                    _ = try captureDestination(path)
                } catch let error as FileAttachmentError {
                    throw ToolInputError(error.description)
                }
            }
        case "tabs_create": _ = try tabsCreateParams(args)
        case "select_tab": _ = try selectTabParams(args)
        case "navigate": _ = try navigateParams(args)
        case "read_page": _ = try readPageParams(args)
        case "snapshot": _ = try snapshotParams(args)
        case "find": _ = try findParams(args)
        case "javascript_tool": _ = try javaScriptParams(args)
        case "read_console": _ = try readConsoleParams(args)
        case "read_network": _ = try readNetworkParams(args)
        case "resize_window": _ = try resizeWindowParams(args)
        case "wait": _ = try waitRequest(args)
        default: break
        }
    }

    /// The tools that take `native: true`.
    nonisolated static let nativeCapableTools: Set<String> = ["type_text", "press_key", "hover", "drag"]

    // MARK: Files

    struct FileAttachmentInputs: Equatable {
        let paths: [String]
        let mimeType: String?
    }

    /// The paths and MIME type named by `upload_file` or `drop_file`, checked for
    /// shape and count. Nothing is read here; `FileAttachmentLoader` does that.
    nonisolated static func fileAttachmentInputs(_ args: [String: Value]) throws -> FileAttachmentInputs {
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
        do {
            try FileAttachmentLoader.validateCount(of: paths)
        } catch let error as FileAttachmentError {
            throw ToolInputError(error.description)
        }
        let mimeType = try optionalString("mimeType", in: args)
        return FileAttachmentInputs(paths: paths, mimeType: mimeType)
    }

    // MARK: Native input

    /// The key for a native `press_key`, which the schema requires.
    nonisolated static func requiredKey(_ args: [String: Value]) throws -> String {
        guard let key = try optionalString("key", in: args), !key.isEmpty else {
            throw ToolInputError("key is required")
        }
        return key
    }

    // MARK: Tabs and navigation

    nonisolated static func tabsCreateParams(_ args: [String: Value]) throws -> [String: AnyCodable] {
        var params: [String: AnyCodable] = [:]
        if let url = try optionalString("url", in: args) {
            params["url"] = AnyCodable(try validatedNavigationURL(url))
        }
        return params
    }

    nonisolated static func selectTabParams(_ args: [String: Value]) throws -> [String: AnyCodable] {
        var params: [String: AnyCodable] = [:]
        if let bringToFront = try optionalBool("bringToFront", in: args) {
            params["bringToFront"] = AnyCodable(bringToFront)
        }
        return params
    }

    nonisolated static func navigateParams(_ args: [String: Value]) throws -> [String: AnyCodable] {
        var params: [String: AnyCodable] = [:]
        if let url = try optionalString("url", in: args) {
            params["url"] = AnyCodable(try validatedNavigationURL(url))
        }
        if let action = try optionalString("action", in: args) {
            guard allowedNavActions.contains(action) else {
                throw ToolInputError("Invalid navigation action: \(action). Use goto, back, forward, or reload.")
            }
            params["action"] = AnyCodable(action)
        }
        return params
    }

    // MARK: Page reading

    nonisolated static func readPageParams(_ args: [String: Value]) throws -> [String: AnyCodable] {
        var params: [String: AnyCodable] = [:]
        if let format = try optionalString("format", in: args) {
            guard allowedPageFormats.contains(format) else {
                throw ToolInputError("Invalid page format: \(format). Use text, html, or snapshot.")
            }
            params["format"] = AnyCodable(format)
        }
        if let maxChars = try optionalPositiveInt("maxChars", in: args, maximum: maxPageChars) {
            params["maxChars"] = AnyCodable(maxChars)
        }
        if let maxNodes = try optionalPositiveInt("maxNodes", in: args, maximum: maxSnapshotNodes) {
            params["maxNodes"] = AnyCodable(maxNodes)
        }
        return params
    }

    nonisolated static func snapshotParams(_ args: [String: Value]) throws -> [String: AnyCodable] {
        var params: [String: AnyCodable] = [:]
        if let maxNodes = try optionalPositiveInt("maxNodes", in: args, maximum: maxSnapshotNodes) {
            params["maxNodes"] = AnyCodable(maxNodes)
        }
        return params
    }

    nonisolated static func findParams(_ args: [String: Value]) throws -> [String: AnyCodable] {
        var params: [String: AnyCodable] = [:]
        for key in ["selector", "text", "role"] {
            if let value = try optionalString(key, in: args) { params[key] = AnyCodable(value) }
        }
        return params
    }

    nonisolated static func javaScriptParams(_ args: [String: Value]) throws -> [String: AnyCodable] {
        var params: [String: AnyCodable] = [:]
        if let code = try optionalString("code", in: args) { params["code"] = AnyCodable(code) }
        return params
    }

    // MARK: Debugging

    nonisolated static func readConsoleParams(_ args: [String: Value]) throws -> [String: AnyCodable] {
        var params: [String: AnyCodable] = [:]
        if let level = try optionalString("level", in: args) {
            guard allowedConsoleLevels.contains(level) else {
                throw ToolInputError("Invalid console level: \(level). Use all, log, warn, error, info, or debug.")
            }
            params["level"] = AnyCodable(level)
        }
        if let clear = try optionalBool("clear", in: args) { params["clear"] = AnyCodable(clear) }
        if let pattern = try optionalString("pattern", in: args) {
            params["pattern"] = AnyCodable(try validatedFilterPattern(pattern, name: "pattern"))
        }
        return params
    }

    nonisolated static func readNetworkParams(_ args: [String: Value]) throws -> [String: AnyCodable] {
        var params: [String: AnyCodable] = [:]
        if let type = try optionalString("type", in: args) {
            guard allowedNetworkTypes.contains(type) else {
                throw ToolInputError("Invalid network type: \(type). Use all, xhr, fetch, or resource.")
            }
            params["type"] = AnyCodable(type)
        }
        if let urlPattern = try optionalString("urlPattern", in: args) {
            params["urlPattern"] = AnyCodable(try validatedFilterPattern(urlPattern, name: "urlPattern"))
        }
        if let status = try optionalInt("status", in: args) {
            guard (0...599).contains(status) else {
                throw ToolInputError("Invalid status: \(status). Use an HTTP status code (0-599; 0 means network error).")
            }
            params["status"] = AnyCodable(status)
        }
        if let maxResults = try optionalPositiveInt("maxResults", in: args, maximum: maxNetworkResults) {
            params["maxResults"] = AnyCodable(maxResults)
        }
        if let clear = try optionalBool("clear", in: args) { params["clear"] = AnyCodable(clear) }
        return params
    }

    // MARK: Window

    nonisolated static func resizeWindowParams(_ args: [String: Value]) throws -> [String: AnyCodable] {
        var params: [String: AnyCodable] = [:]
        for key in ["width", "height"] {
            guard let size = try optionalInt(key, in: args) else {
                throw ToolInputError("\(key) is required: a positive integer of at most \(maxWindowDimension)")
            }
            guard (1...maxWindowDimension).contains(size) else {
                throw ToolInputError("Invalid \(key): \(size). Use a positive integer of at most \(maxWindowDimension).")
            }
            params[key] = AnyCodable(size)
        }
        return params
    }

    // MARK: Action options

    /// The tools whose result goes through the post-action steps: the optional
    /// wait, trace and snapshot that run after the action succeeded.
    nonisolated static let actionTools: Set<String> = [
        "navigate", "click", "type_text", "form_input", "select_option", "scroll",
        "press_key", "hover", "drag", "upload_file", "drop_file", "handle_dialog",
    ]

    struct PostActionWait: Equatable {
        let selector: String?
        let text: String?
        let timeout: Double
    }

    /// The wait to run after an action, or nil when none was asked for.
    ///
    /// Read before the action is sent, never after. These arguments used to be
    /// checked only once the action had already run, so a caller who fixed a bad
    /// `waitForSelector` and retried submitted the form a second time.
    nonisolated static func postActionWait(_ args: [String: Value]) throws -> PostActionWait? {
        let selector = try optionalString("waitForSelector", in: args)
        let text = try optionalString("waitForText", in: args)
        let timeout = try optionalNumber("waitTimeout", in: args)
        if selector?.isEmpty == true { throw ToolInputError("waitForSelector must not be empty") }
        if text?.isEmpty == true { throw ToolInputError("waitForText must not be empty") }
        guard selector != nil || text != nil else { return nil }
        return PostActionWait(selector: selector, text: text, timeout: cappedWaitTimeout(timeout))
    }

    struct TraceOptions: Equatable {
        let eventTypes: [String]?
        let duration: Double
    }

    nonisolated static let maxTraceSeconds: Double = 30

    /// The trace to capture around an action, or nil when `trace` is not set.
    /// Like the wait, it is read before anything is sent: `start_trace` used to go
    /// out first and a bad `traceDuration` was found afterwards, leaving a trace
    /// running that nothing would stop.
    nonisolated static func traceOptions(_ args: [String: Value]) throws -> TraceOptions? {
        let enabled = try optionalBool("trace", in: args)
        let duration = try optionalNumber("traceDuration", in: args)
        var eventTypes: [String]?
        if let value = args["eventTypes"], value != .null {
            guard let values = value.arrayValue,
                  values.allSatisfy({ $0.stringValue?.isEmpty == false })
            else { throw ToolInputError("eventTypes must be an array of non-empty strings") }
            eventTypes = values.compactMap(\.stringValue)
        }
        guard enabled == true else { return nil }
        return TraceOptions(eventTypes: eventTypes, duration: max(0, min(duration ?? 2, maxTraceSeconds)))
    }

    // MARK: Waiting

    /// The two things `wait` can do: sleep, or poll for a condition.
    enum WaitRequest: Equatable {
        case duration(seconds: Double)
        case condition(selector: String?, text: String?, timeout: Double)
    }

    nonisolated static func waitRequest(_ args: [String: Value]) throws -> WaitRequest {
        let seconds = try optionalNumber("seconds", in: args)
        let selector = try optionalString("selector", in: args)
        let text = try optionalString("text", in: args)
        let timeout = try optionalNumber("timeout", in: args)
        if let seconds, selector == nil, text == nil {
            return .duration(seconds: max(0, min(seconds, maxWaitSeconds)))
        }
        return .condition(selector: selector, text: text, timeout: cappedWaitTimeout(timeout))
    }

    nonisolated static let maxWaitSeconds: Double = 300 // 5-minute cap

    nonisolated static func cappedWaitTimeout(_ value: Double?) -> Double {
        max(0.1, min(value ?? 10, maxWaitSeconds))
    }

    // MARK: Validators

    /// The URL a tool may send the browser to, as the browser will read it.
    /// Shared by `navigate` and `tabs_create`.
    ///
    /// The scheme is judged on the string a browser parses, not on what
    /// Foundation makes of the raw one. WebKit drops leading and trailing control
    /// characters and spaces and deletes every tab and newline before it looks
    /// for the scheme, so `" javascript:alert(1)"` and `"jav\tascript:alert(1)"`
    /// are `javascript:` URLs to Safari whatever `URL(string:)` thinks. Judging
    /// the same normalized string, and sending it, means the scheme that was
    /// checked is the scheme that runs.
    ///
    /// A `file:` URL is also refused when it resolves into the directories the
    /// bridge token lives in. Safari would render the token as text, and
    /// `read_page` would hand it to the caller, or to whatever a page script
    /// could then do with a valid token.
    nonisolated static func validatedNavigationURL(
        _ url: String,
        protectedRoots: [String] = ProtectedPaths.defaultRoots
    ) throws -> String {
        let normalized = browserNormalizedURL(url)
        guard let scheme = urlScheme(of: normalized),
              allowedURLSchemes.contains(scheme.lowercased()),
              let parsed = URL(string: normalized)
        else {
            throw ToolInputError("Invalid URL or disallowed scheme. Only http, https, about, and file are allowed.")
        }
        if scheme.lowercased() == "file", ProtectedPaths.isProtected(parsed.path, roots: protectedRoots) {
            throw ToolInputError("Refusing to open \(parsed.path): it is in a directory where MCPSafari keeps its bridge token")
        }
        return normalized
    }

    private nonisolated static func browserNormalizedURL(_ url: String) -> String {
        let scalars = Array(url.unicodeScalars)
        // C0 controls and space at either end; tab, LF and CR anywhere.
        let isStrippable: (Unicode.Scalar) -> Bool = { $0.value <= 0x20 }
        guard let first = scalars.firstIndex(where: { !isStrippable($0) }),
              let last = scalars.lastIndex(where: { !isStrippable($0) })
        else { return "" }
        var normalized = String.UnicodeScalarView()
        normalized.append(contentsOf: scalars[first...last].filter { ![0x09, 0x0A, 0x0D].contains($0.value) })
        return String(normalized)
    }

    /// The scheme of an absolute URL: an ASCII letter, then letters, digits,
    /// `+`, `-` or `.`, then `:`. Nil for a relative reference such as `//host`.
    private nonisolated static func urlScheme(of url: String) -> String? {
        var scheme = ""
        for (offset, scalar) in url.unicodeScalars.enumerated() {
            if scalar == ":" { return scheme.isEmpty ? nil : scheme }
            let isLetter = ("a"..."z").contains(scalar) || ("A"..."Z").contains(scalar)
            let isContinuation = isLetter || ("0"..."9").contains(scalar) || "+-.".unicodeScalars.contains(scalar)
            guard offset == 0 ? isLetter : isContinuation else { return nil }
            scheme.unicodeScalars.append(scalar)
        }
        return nil
    }

    /// The longest pattern `read_console` and `read_network` accept, in UTF-16
    /// code units, which is how the page-world filters count it.
    nonisolated static let maxFilterPatternLength = 200

    /// A regex for `read_console` and `read_network`, held to the same bounded
    /// subset the page-world filters in console-interceptor.js and
    /// network-interceptor.js enforce: at most 200 UTF-16 code units, none of
    /// `( ) * + ? { }` outside an escape, and no backreference. Those are the
    /// constructs that let matching work grow faster than pattern times input.
    ///
    /// The server is the gate rather than the page, because a page can replace
    /// the page-side check along with everything else it can rewrite there, and
    /// the call then costs nothing to refuse before the extension sees it.
    nonisolated static func validatedFilterPattern(_ pattern: String, name: String) throws -> String {
        let length = pattern.utf16.count
        guard length <= maxFilterPatternLength else {
            throw ToolInputError("\(name) is too long: \(length) UTF-16 code units, max \(maxFilterPatternLength)")
        }
        guard isBoundedFilterSubset(pattern) else {
            throw ToolInputError("Unsupported \(name): use literals, dots, anchors, character classes, or alternation; no repetition, groups, or backreferences.")
        }
        guard (try? NSRegularExpression(pattern: pattern)) != nil else {
            throw ToolInputError("Invalid regex \(name): \(pattern)")
        }
        return pattern
    }

    /// The same two tests the page-world filters make, in the same order of
    /// operations. A backreference is a backslash and `1`-`9` or `k` found
    /// anywhere in the raw pattern. Quantifiers and groups are looked for only
    /// after every backslash and the character after it are dropped, as
    /// `/\\./g` does there, which leaves a line terminator after a backslash in
    /// place exactly as it does in JavaScript, where `.` does not match one.
    private nonisolated static func isBoundedFilterSubset(_ pattern: String) -> Bool {
        let units = Array(pattern.utf16)
        let backslash: UInt16 = 0x5C
        let backreferenceMarkers = Set("123456789k".utf16)
        for (index, unit) in units.enumerated() where unit == backslash && index + 1 < units.count {
            if backreferenceMarkers.contains(units[index + 1]) { return false }
        }

        let lineTerminators: Set<UInt16> = [0x0A, 0x0D, 0x2028, 0x2029]
        let quantifiersAndGroups = Set("()*+?{}".utf16)
        var index = 0
        while index < units.count {
            if units[index] == backslash, index + 1 < units.count, !lineTerminators.contains(units[index + 1]) {
                index += 2
                continue
            }
            if quantifiersAndGroups.contains(units[index]) { return false }
            index += 1
        }
        return true
    }
}
