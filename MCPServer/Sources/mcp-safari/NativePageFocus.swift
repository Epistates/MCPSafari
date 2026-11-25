import AppKit
import ApplicationServices
import Foundation

// MARK: - Giving the page the keyboard

/// Native input goes wherever macOS sends the keyboard and pointer, and Safari
/// often leaves its own keyboard focus outside the page: a new window and a
/// navigation both tend to leave it in the address bar. Page script cannot take
/// it back from Safari's controls, and bringing the window forward hands the
/// keyboard to whatever held it in that window, so the extension refuses with
/// `native_input_focus_failed` and nothing is sent.
///
/// A person clicks into the page. This does what Tab or VoiceOver does instead:
/// it asks Safari, through Accessibility, to focus the web area of the window in
/// front. The page sees its window gain focus and no mouse or DOM events. That
/// happens only after Accessibility confirms the window in front is the one
/// holding the agent's tab, so the keyboard never moves into a page the user has
/// in front instead.
extension SafariMCPServer {
    /// The agent's tab and its window, as the extension saw them when it
    /// refused. Screen points with the origin at the top left, as Accessibility
    /// measures windows.
    struct NativeTarget: Decodable, Equatable, Sendable {
        let left: Double
        let top: Double
        let width: Double
        let height: Double
        /// The tab's title, which Safari also shows as its window's title.
        let title: String?
    }

    /// A Safari window as Accessibility reports it.
    struct NativeWindowSummary: Equatable, Sendable {
        let frame: CGRect
        let title: String?
    }

    /// Who has the keyboard when it isn't the page.
    enum KeyboardHolder: Equatable, Sendable {
        /// The page has it after all, so the refusal was about something else,
        /// such as a field that wouldn't take focus.
        case page
        case otherApplication(String?)
        case addressBar
        case findBar
        case otherSafariWindow(title: String?)
        /// Another control of Safari's, named as Accessibility describes it.
        case safariControl(String)
        case unknown
    }

    /// What the focused element looks like to Accessibility, for working out
    /// which of Safari's controls it is.
    struct FocusedElementSummary: Equatable, Sendable {
        var applicationIsSafari: Bool
        var applicationName: String?
        var role: String?
        var subrole: String?
        var description: String?
        var identifier: String?
        var placeholder: String?
        var title: String?
        /// The focused element's window, when Accessibility names one.
        var window: NativeWindowSummary?
        /// Whether it sits inside a web area: the page, rather than Safari's own controls.
        var inPage = false
    }

    /// The machine side, so the decisions below can be tested with fakes.
    struct NativePageFocus: Sendable {
        /// Safari's focused window, or nil when Accessibility can't say.
        let frontWindow: @Sendable () -> NativeWindowSummary?
        /// Asks Safari to focus the web area of its focused window. False when
        /// there was no web area to ask, or Safari refused.
        let focusPage: @Sendable () -> Bool
        /// The element holding the keyboard, or nil when Accessibility can't say.
        let focusedElement: @Sendable () -> FocusedElementSummary?
        /// A moment for Safari to move the focus before the page is asked again.
        let settle: @Sendable () async -> Void

        static let live = NativePageFocus(
            frontWindow: { SafariMCPServer.safariFocusedWindow().map(SafariMCPServer.windowSummary) },
            focusPage: { SafariMCPServer.focusSafariWebArea() },
            focusedElement: { SafariMCPServer.focusedElementSummary() },
            settle: { try? await Task.sleep(nanoseconds: 150_000_000) }
        )
    }

    /// How far a window's frame may be from the extension's report of it and
    /// still count as the same window. The two round differently.
    nonisolated static let windowFrameTolerance: Double = 2

    /// Whether the window Accessibility has in front is the agent's: the same
    /// frame, and the same title when the tab has one. The title is the selected
    /// tab's, so it also says the agent's tab is the one showing.
    nonisolated static func windowIsTarget(_ window: NativeWindowSummary, _ target: NativeTarget) -> Bool {
        let frame = window.frame
        let close = abs(frame.minX - target.left) <= windowFrameTolerance
            && abs(frame.minY - target.top) <= windowFrameTolerance
            && abs(frame.width - target.width) <= windowFrameTolerance
            && abs(frame.height - target.height) <= windowFrameTolerance
        guard close else { return false }
        guard let title = target.title, !title.isEmpty else { return true }
        return window.title == title
    }

    /// Which control has the keyboard, in the terms a person would use.
    nonisolated static func keyboardHolder(_ element: FocusedElementSummary?, target: NativeTarget) -> KeyboardHolder {
        guard let element else { return .unknown }
        guard element.applicationIsSafari else { return .otherApplication(element.applicationName) }
        if let window = element.window, !windowIsTarget(window, target) {
            return .otherSafariWindow(title: window.title)
        }
        if element.inPage { return .page }
        let words = [element.description, element.identifier, element.placeholder, element.title]
            .compactMap { $0?.lowercased() }
            .joined(separator: " ")
        let isTextField = ["AXTextField", "AXSearchField", "AXComboBox"].contains(element.role ?? "")
            || element.subrole == "AXSearchField"
        if isTextField, ["address", "smart search", "website name", "url"].contains(where: words.contains) {
            return .addressBar
        }
        if isTextField, words.contains("find") {
            return .findBar
        }
        let name = element.description ?? element.title ?? element.role
        return name.map { .safariControl($0) } ?? .unknown
    }

    /// The refusal once the page could not be given the keyboard, saying where
    /// the keyboard is so the user can be told exactly where to click.
    nonisolated static func pageFocusFailure(_ holder: KeyboardHolder, keyboard: Bool) -> ToolFailure {
        let place: String
        let fix: String
        switch holder {
        case .page, .unknown:
            place = "The page doesn't have the keyboard, and Accessibility can't say what does"
            fix = "Ask the user to click in the page, then retry."
        case .otherApplication(let name):
            place = "\(name ?? "Another application") has the keyboard, not Safari"
            fix = "Ask the user to bring Safari to the front and click in the page, then retry."
        case .addressBar:
            place = "Safari's address bar has the keyboard, not the page"
            fix = "Ask the user to click in the page, then retry."
        case .findBar:
            place = "Safari's find bar has the keyboard, not the page"
            fix = "Ask the user to close the find bar with Escape or click in the page, then retry."
        case .otherSafariWindow(let title):
            let named = title.flatMap { $0.isEmpty ? nil : " (\"\($0)\")" } ?? ""
            place = "Another Safari window\(named) has the keyboard, not the agent's tab"
            fix = "Bring the agent's tab forward with select_tab and bringToFront, or ask the user to click in its page, then retry."
        case .safariControl(let name):
            place = "Safari's \(name) has the keyboard, not the page"
            fix = "Ask the user to click in the page, then retry."
        }
        let field = keyboard
            ? " To type into a field, click it first with click and native: true, which focuses it the way a person's click does."
            : ""
        return ToolFailure(
            code: "native_input_focus_failed",
            message: "\(place), so nothing was sent. \(fix)\(field)",
            retryable: true,
            recoveryAction: "ask_user"
        )
    }

    /// The refusal when the window in front isn't the agent's. Focusing the page
    /// in front then would hand the keyboard to whatever the user has open.
    nonisolated static func wrongWindowFailure(_ window: NativeWindowSummary?) -> ToolFailure {
        let shown = window?.title.flatMap { $0.isEmpty ? nil : " (it shows \"\($0)\")" } ?? ""
        return ToolFailure(
            code: "native_input_focus_failed",
            message: "The Safari window in front isn't the one holding the agent's tab\(shown), so MCPSafari didn't move the keyboard and nothing was sent. Bring the agent's tab forward with select_tab and bringToFront, or ask the user to, then retry.",
            retryable: true,
            recoveryAction: "ask_user"
        )
    }

    /// The target the extension attached to its refusal, if it did. An older
    /// extension attaches none, and the refusal then stands as it was.
    nonisolated static func nativeTarget(from response: BridgeResponse) -> NativeTarget? {
        guard response.errorCode == "native_input_focus_failed",
              let raw = response.data?.stringValue,
              let payload = try? JSONDecoder().decode(NativeTargetPayload.self, from: Data(raw.utf8))
        else { return nil }
        return payload.nativeTarget
    }

    private struct NativeTargetPayload: Decodable {
        let nativeTarget: NativeTarget
    }

    /// Prepares native input, giving the page the keyboard first when the
    /// extension refuses because it doesn't have it.
    ///
    /// `prepare` asks the extension; its argument says the window was confirmed
    /// to be the agent's, which lets a pointer action go on without keyboard
    /// focus, since the click itself gives the page focus. Keys never go on
    /// without it. Returns the extension's answer, success or a refusal of some
    /// other kind, and throws when the keyboard couldn't be moved into the page.
    static func prepareNativeInput(
        pointer: Bool,
        pageFocus: NativePageFocus,
        isolation: isolated (any Actor)? = #isolation,
        prepare: (_ windowVerified: Bool) async throws -> BridgeResponse
    ) async throws -> BridgeResponse {
        var last = try await prepare(false)
        guard !last.success, let target = nativeTarget(from: last) else { return last }

        let front = pageFocus.frontWindow()
        guard let front, windowIsTarget(front, target) else {
            throw NativeInputError(failure: wrongWindowFailure(front))
        }

        if pageFocus.focusPage() {
            await pageFocus.settle()
            last = try await prepare(false)
            if last.success || nativeTarget(from: last) == nil { return last }
        }

        if pointer {
            // The window is the agent's and in front, so a click lands in its page.
            last = try await prepare(true)
            if last.success || nativeTarget(from: last) == nil { return last }
        }

        let holder = keyboardHolder(pageFocus.focusedElement(), target: target)
        // The page holds the keyboard, so the extension refused for its own
        // reason, and that refusal says it better.
        if holder == .page { return last }
        throw NativeInputError(failure: pageFocusFailure(holder, keyboard: !pointer))
    }

    // MARK: Accessibility

    private nonisolated static func safariApplication() -> AXUIElement? {
        guard AXIsProcessTrusted(),
              let safari = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").first
        else { return nil }
        let app = AXUIElementCreateApplication(safari.processIdentifier)
        // A busy Safari must not hold up the call for the default six seconds.
        AXUIElementSetMessagingTimeout(app, 1)
        return app
    }

    private nonisolated static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        return value
    }

    private nonisolated static func element(_ value: CFTypeRef?) -> AXUIElement? {
        guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeDowncast(value, to: AXUIElement.self)
    }

    private nonisolated static func string(_ element: AXUIElement, _ name: String) -> String? {
        attribute(element, name) as? String
    }

    private nonisolated static func frame(of element: AXUIElement) -> CGRect? {
        var origin = CGPoint.zero
        var size = CGSize.zero
        guard let position = attribute(element, kAXPositionAttribute),
              CFGetTypeID(position) == AXValueGetTypeID(),
              AXValueGetValue(unsafeDowncast(position, to: AXValue.self), .cgPoint, &origin),
              let extent = attribute(element, kAXSizeAttribute),
              CFGetTypeID(extent) == AXValueGetTypeID(),
              AXValueGetValue(unsafeDowncast(extent, to: AXValue.self), .cgSize, &size)
        else { return nil }
        return CGRect(origin: origin, size: size)
    }

    nonisolated static func safariFocusedWindow() -> AXUIElement? {
        guard let app = safariApplication() else { return nil }
        return element(attribute(app, kAXFocusedWindowAttribute))
    }

    nonisolated static func windowSummary(_ window: AXUIElement) -> NativeWindowSummary {
        NativeWindowSummary(frame: frame(of: window) ?? .null, title: string(window, kAXTitleAttribute))
    }

    /// The page of Safari's focused window: its largest web area, since the
    /// window can also hold small ones, such as an extension's popover.
    nonisolated static func focusSafariWebArea() -> Bool {
        guard let window = safariFocusedWindow() else { return false }
        var largest: (element: AXUIElement, area: CGFloat)?
        var level = [window]
        // The page sits a few levels below the window; a bound keeps a cyclic or
        // runaway tree from looping.
        for _ in 0..<12 where !level.isEmpty {
            var next: [AXUIElement] = []
            for node in level {
                if string(node, kAXRoleAttribute) == "AXWebArea" {
                    let size = frame(of: node).map { $0.width * $0.height } ?? 0
                    if size > (largest?.area ?? -1) { largest = (node, size) }
                    continue
                }
                if let children = attribute(node, kAXChildrenAttribute) as? [AXUIElement] {
                    next.append(contentsOf: children)
                }
            }
            level = next
        }
        guard let page = largest?.element else { return false }
        return AXUIElementSetAttributeValue(page, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
    }

    nonisolated static func focusedElementSummary() -> FocusedElementSummary? {
        guard AXIsProcessTrusted() else { return nil }
        let system = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(system, 1)
        guard let app = element(attribute(system, kAXFocusedApplicationAttribute)) else { return nil }
        var pid: pid_t = 0
        AXUIElementGetPid(app, &pid)
        let running = NSRunningApplication(processIdentifier: pid)
        var summary = FocusedElementSummary(
            applicationIsSafari: running?.bundleIdentifier == "com.apple.Safari",
            applicationName: running?.localizedName
        )
        guard let focused = element(attribute(app, kAXFocusedUIElementAttribute)) else { return summary }
        summary.role = string(focused, kAXRoleAttribute)
        summary.subrole = string(focused, kAXSubroleAttribute)
        summary.description = string(focused, kAXDescriptionAttribute)
        summary.identifier = string(focused, kAXIdentifierAttribute)
        summary.placeholder = string(focused, kAXPlaceholderValueAttribute)
        summary.title = string(focused, kAXTitleAttribute)
        summary.window = element(attribute(focused, kAXWindowAttribute)).map(windowSummary)
        summary.inPage = focusedElementIsInWebArea() == true
        return summary
    }
}
