import AppKit
import ApplicationServices
import Carbon
import CoreGraphics
import Foundation
import MCP

// MARK: - Native Input

/// Real keyboard and mouse events, for the `native: true` paths of
/// `type_text`, `press_key`, `move_pointer` and `drag`.
///
/// Synthetic DOM events cannot reach anything outside the page, so a native
/// path exists for the cases that need the real input stream. That takes over
/// the user's keyboard and mouse, which is why every entry point here checks
/// Accessibility permission and that Safari is frontmost before posting.
///
/// Every function is `nonisolated static`: none of it reads actor state, and
/// the keyboard-layout calls must not be serialized on the actor. The handlers
/// that drive it stay with the other tool handlers and reach it through the
/// internal entry points below.
extension SafariMCPServer {
    // What is internal here rather than private is exactly what the tool handlers
    // call from the main file. Everything else stays private, so the internal
    // declarations are the whole surface the rest of the server can reach.
    struct NativeInputError: Error {
        let failure: ToolFailure
    }

    struct NativeInputPlan {
        let text: String
        let clearFirst: Bool
        /// Where the active layout puts `a`, resolved up front so a layout that
        /// has no such key refuses the call before anything is sent. Present
        /// exactly when `clearFirst` is.
        let selectAllKeyCode: CGKeyCode?
        let submitKey: String?
        let submitKeyCode: CGKeyCode?
    }

    /// The resolver and the permission check are parameters so the plan can be
    /// tested without a particular keyboard layout or an Accessibility grant.
    nonisolated static func nativeInputPlan(
        _ args: [String: Value],
        resolveCharacter: (String) -> ResolvedCharacter? = currentLayoutKeyCode(for:),
        permission: () throws -> Void = ensureNativeInputPermission
    ) throws -> NativeInputPlan {
        guard let text = args["text"]?.stringValue else {
            throw ToolInputError("text is required")
        }
        if let clearFirst = args["clearFirst"], clearFirst.boolValue == nil {
            throw ToolInputError("clearFirst must be a boolean")
        }
        if let submitKey = args["submitKey"], submitKey.stringValue == nil {
            throw ToolInputError("submitKey must be a string")
        }

        let characterCount = text.count
        guard characterCount <= maxNativeTextCharacters else {
            throw ToolInputError("Native type_text types at most \(maxNativeTextCharacters) characters and this text has \(characterCount). Use type_text without native for longer text: native typing is for short input that synthetic typing cannot enter.")
        }

        let submitKey = args["submitKey"]?.stringValue
        let submitKeyCode = try nativeSubmitKeyCode(for: submitKey)
        let clearFirst = args["clearFirst"]?.boolValue == true
        let selectAllKeyCode = try clearFirst ? resolveSelectAllKeyCode(resolveCharacter: resolveCharacter) : nil
        try permission()

        return NativeInputPlan(
            text: text,
            clearFirst: clearFirst,
            selectAllKeyCode: selectAllKeyCode,
            submitKey: submitKey,
            submitKeyCode: submitKeyCode
        )
    }

    /// Command plus the key that types `a` on the active layout. Keycode 0 is `a`
    /// on QWERTY and `q` on AZERTY, so a constant here sends Command-Q, which
    /// quits Safari, to a French or Belgian user. A layout with no unshifted `a`
    /// is refused rather than guessed at, and never falls back to keycode 0.
    private nonisolated static func resolveSelectAllKeyCode(
        resolveCharacter: (String) -> ResolvedCharacter?
    ) throws -> CGKeyCode {
        guard let resolved = resolveCharacter("a"), !resolved.needsShift else {
            let layout = currentKeyboardLayoutName().map { " on \($0)" } ?? ""
            throw ToolInputError("Native type_text cannot select the field's text first because there is no plain a key\(layout). Switch the keyboard layout, or omit clearFirst and clear the field another way.")
        }
        return resolved.keyCode
    }

    private nonisolated static func checkNativeDeadline(_ deadline: Double?) throws {
        guard let deadline, ProcessInfo.processInfo.systemUptime >= deadline else { return }
        throw NativeInputError(failure: ToolFailure(
            code: "batch_timeout",
            message: "run_steps reached its deadline during native input. Input may be partial.",
            retryable: false,
            recoveryAction: "inspect_batch_result"
        ))
    }

    /// What native typing needs from the machine, so the loop below can be
    /// driven by a fake in tests without keystrokes reaching the real keyboard.
    struct NativeKeyboard: Sendable {
        let safariIsFrontmost: @Sendable () -> Bool
        let postText: @Sendable (String) throws -> Void
        let postKey: @Sendable (CGKeyCode, CGEventFlags) throws -> Void

        static func live() throws -> NativeKeyboard {
            guard let source = CGEventSource(stateID: .hidSystemState) else {
                throw nativeInputUnavailable("macOS could not create a native keyboard event.")
            }
            let box = EventSourceBox(source)
            return NativeKeyboard(
                safariIsFrontmost: { SafariMCPServer.safariIsActive() },
                postText: { try SafariMCPServer.postText($0, source: box.source) },
                postKey: { try SafariMCPServer.postKey(code: $0, flags: $1, source: box.source) }
            )
        }
    }

    /// The source is only ever used by one task at a time, one event after
    /// another, which is all `CGEventSource` asks of its caller.
    private final class EventSourceBox: @unchecked Sendable {
        let source: CGEventSource

        init(_ source: CGEventSource) {
            self.source = source
        }
    }

    /// Native typing is for short input that synthetic typing cannot enter. The
    /// cap keeps one call from holding the user's keyboard for minutes.
    nonisolated static let maxNativeTextCharacters = 1000

    /// How many characters go out between checks that Safari still has focus.
    /// Every keystroke would be too chatty to be worth it, and one check at each
    /// end leaves a long text typing into whatever took focus from Safari.
    nonisolated static let nativeFocusCheckInterval = 16

    /// Types one character at a time, off the actor and yielding between
    /// characters. The posting is synchronous, so running it on the actor would
    /// stall every other tool call for as long as the text takes to type.
    nonisolated static func typeNativeText(
        _ input: NativeInputPlan,
        deadline: Double? = nil,
        keyboard: NativeKeyboard? = nil
    ) async throws -> String {
        let keyboard = try keyboard ?? NativeKeyboard.live()
        let characters = Array(input.text)
        var delivered = 0

        try checkNativeDeadline(deadline)
        guard keyboard.safariIsFrontmost() else {
            throw NativeInputError(failure: nativeFocusFailure(eventsAlreadySent: false))
        }

        do {
            if let selectAllKeyCode = input.selectAllKeyCode {
                try checkNativeDeadline(deadline)
                try keyboard.postKey(selectAllKeyCode, .maskCommand)
                try await nativeKeystrokePause()
                try checkNativeDeadline(deadline)
                try keyboard.postKey(51, [])
                try await nativeKeystrokePause()
            }
            for (index, character) in characters.enumerated() {
                try Task.checkCancellation()
                try checkNativeDeadline(deadline)
                if index > 0, index % nativeFocusCheckInterval == 0, !keyboard.safariIsFrontmost() {
                    throw NativeInputError(failure: nativeFocusFailure(
                        eventsAlreadySent: true,
                        delivered: (delivered, characters.count)
                    ))
                }
                try keyboard.postText(String(character))
                delivered += 1
                try await nativeKeystrokePause()
            }
            if let submitKeyCode = input.submitKeyCode {
                try checkNativeDeadline(deadline)
                try keyboard.postKey(submitKeyCode, [])
                try await nativeKeystrokePause()
            }
        } catch is CancellationError {
            throw NativeInputError(failure: ToolFailure(
                code: "native_input_cancelled",
                message: "The call was cancelled after \(delivered) of \(characters.count) characters were delivered with native input.",
                retryable: false,
                recoveryAction: "inspect_error"
            ))
        }

        guard keyboard.safariIsFrontmost() else {
            throw NativeInputError(failure: nativeFocusFailure(
                eventsAlreadySent: true,
                delivered: (delivered, characters.count)
            ))
        }

        let suffix = input.submitKey.map { " then pressed \($0)" } ?? ""
        return "Typed \(input.text.count) character(s) with native input\(suffix)"
    }

    /// The gap that lets the receiving app take each keystroke before the next.
    /// A suspension rather than a sleep, so the thread is free for other work
    /// and a cancelled call stops here.
    private nonisolated static func nativeKeystrokePause() async throws {
        try await Task.sleep(for: .milliseconds(5))
    }

    private nonisolated static func nativeSubmitKeyCode(for key: String?) throws -> CGKeyCode? {
        guard let key else { return nil }
        switch key.lowercased() {
        case "enter", "return": return 36
        case "tab": return 48
        default: throw ToolInputError("Native submitKey does not support \(key). Use Enter, Return, or Tab.")
        }
    }

    /// What losing Safari's focus means, which depends entirely on whether
    /// anything has been delivered yet.
    ///
    /// `eventsAlreadySent` rather than `afterTyping`: the guard runs after
    /// `press_key`, `hover`, and `drag` too, and in every case the question is
    /// the same one. Nothing sent is a clean refusal the caller can retry.
    /// Something sent is not retryable, because a retry is not a recovery, it is
    /// a second stream of input into whatever is frontmost now.
    ///
    /// `delivered` is how much of a typed text went out before focus was lost,
    /// so the caller knows what the page and the other application each received.
    nonisolated static func nativeFocusFailure(
        eventsAlreadySent: Bool,
        delivered: (sent: Int, total: Int)? = nil
    ) -> ToolFailure {
        let progress = delivered.map { " Delivered \($0.sent) of \($0.total) characters before that." } ?? ""
        return ToolFailure(
            code: "native_input_focus_lost",
            message: eventsAlreadySent
                ? "Safari lost focus during native input, so some events may have gone to another application.\(progress) Tell the user before retrying: a retry sends the whole input again."
                : "Safari is not the frontmost application, so nothing was sent. Native input takes over the user's keyboard and mouse, so ask the user before bringing Safari to the front unless they have already allowed it, or omit native to use synthetic input, which does not need focus.",
            retryable: !eventsAlreadySent,
            recoveryAction: "ask_user"
        )
    }

    private nonisolated static func ensureSafariIsFrontmost(eventsAlreadySent: Bool = false) throws {
        guard safariIsActive() else {
            throw NativeInputError(failure: nativeFocusFailure(eventsAlreadySent: eventsAlreadySent))
        }
    }

    private nonisolated static func safariIsActive() -> Bool {
        // NSWorkspace.frontmostApplication freezes at first touch in this
        // run-loop-less process; a fresh fetch reads current state.
        NSRunningApplication
            .runningApplications(withBundleIdentifier: "com.apple.Safari")
            .contains { $0.isActive }
    }

    private nonisolated static func nativeInputUnavailable(_ message: String) -> NativeInputError {
        NativeInputError(failure: ToolFailure(
            code: "native_input_unavailable",
            message: message,
            retryable: false,
            recoveryAction: "inspect_error"
        ))
    }

    nonisolated static func ensureNativeInputPermission() throws {
        guard AXIsProcessTrusted() else {
            throw NativeInputError(failure: ToolFailure(
                code: "native_input_permission_required",
                message: "Native input requires Accessibility permission for the app running mcp-safari (Codex, Claude, or your terminal). Enable that app in System Settings > Privacy & Security > Accessibility. Standard input works without this permission.",
                retryable: false,
                recoveryAction: "grant_accessibility_to_mcp_client"
            ))
        }
    }

    /// The key-down and key-up pair that types `text`, not yet posted.
    nonisolated static func textKeyEvents(
        _ text: String,
        source: CGEventSource
    ) throws -> (down: CGEvent, up: CGEvent) {
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
        // A `.hidSystemState` source reports the modifiers that are physically
        // down, so a key the user is holding would turn typed text into a
        // shortcut: "q" with Command held is Command-Q. Typed text is never one.
        keyDown.flags = []
        keyUp.flags = []
        return (keyDown, keyUp)
    }

    private nonisolated static func postText(_ text: String, source: CGEventSource) throws {
        let events = try textKeyEvents(text, source: source)
        events.down.post(tap: .cgSessionEventTap)
        events.up.post(tap: .cgSessionEventTap)
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
    }

    struct NativeKeyCombo: Equatable, Sendable {
        let keyCode: CGKeyCode
        let flags: CGEventFlags
        let label: String
    }

    // Virtual keycodes name a physical key position, not a character, so these
    // are the same on every layout.
    nonisolated static let namedKeyCodes: [String: CGKeyCode] = [
        "enter": 36, "return": 36, "tab": 48, "space": 49, "spacebar": 49,
        " ": 49, "backspace": 51, "escape": 53, "esc": 53,
        "delete": 117, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
        "arrowleft": 123, "arrowright": 124, "arrowdown": 125, "arrowup": 126,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97,
        "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]

    struct ResolvedCharacter: Equatable, Sendable {
        let keyCode: CGKeyCode
        let needsShift: Bool
    }

    /// Which physical key produces `character` on the keyboard layout that is
    /// active right now.
    ///
    /// A character key cannot be a fixed keycode. Keycode 0 is `a` on QWERTY but
    /// `q` on AZERTY, so a hardcoded table turns `Meta+a` into Command-Q — Quit
    /// Safari — for a French or Belgian user. Ask the layout instead.
    nonisolated static func currentLayoutKeyCode(for character: String) -> ResolvedCharacter? {
        guard let layout = currentKeyboardLayout() else { return nil }
        for shifted in [false, true] {
            // Ascending, so the main block wins over the numeric keypad, which
            // produces the same digits from a different position.
            for code in CGKeyCode(0)...CGKeyCode(127)
            where self.character(forKeyCode: code, shifted: shifted, layout: layout.data) == character {
                return ResolvedCharacter(keyCode: code, needsShift: shifted)
            }
        }
        return nil
    }

    nonisolated static func currentKeyboardLayoutName() -> String? {
        currentKeyboardLayout()?.name
    }

    /// HIToolbox aborts the whole process if the Text Input Sources API is
    /// entered from two threads at once, and it offers no main-thread shortcut
    /// for a non-UI tool like this one. Tool calls run on the concurrency pool
    /// and several clients can be served at the same time, so every TIS call
    /// goes through this lock.
    private nonisolated static let keyboardLayoutLock = NSLock()

    private nonisolated static func currentKeyboardLayout() -> (data: Data, name: String)? {
        keyboardLayoutLock.lock()
        defer { keyboardLayoutLock.unlock() }

        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let dataPointer = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData)
        else { return nil }

        // Copied, not referenced: the layout outlives the input source it came from.
        let data = Data(Unmanaged<CFData>.fromOpaque(dataPointer).takeUnretainedValue() as Data)
        let name = TISGetInputSourceProperty(source, kTISPropertyLocalizedName).map {
            Unmanaged<CFString>.fromOpaque($0).takeUnretainedValue() as String
        }
        return (data, name ?? "the active keyboard layout")
    }

    private nonisolated static func character(
        forKeyCode code: CGKeyCode,
        shifted: Bool,
        layout: Data
    ) -> String? {
        let capacity = 4
        var characters = [UniChar](repeating: 0, count: capacity)
        var length = 0
        var deadKeyState: UInt32 = 0
        let status = layout.withUnsafeBytes { raw -> OSStatus in
            guard let base = raw.baseAddress else { return OSStatus(-1) }
            return UCKeyTranslate(
                base.assumingMemoryBound(to: UCKeyboardLayout.self),
                UInt16(code),
                UInt16(kUCKeyActionDown),
                shifted ? UInt32(shiftKey >> 8) : 0,
                UInt32(LMGetKbdType()),
                OptionBits(kUCKeyTranslateNoDeadKeysBit),
                &deadKeyState,
                capacity,
                &length,
                &characters
            )
        }
        guard status == noErr, length > 0 else { return nil }
        return String(utf16CodeUnits: characters, count: length)
    }

    nonisolated static func nativeKeyCombo(
        _ keyString: String,
        resolveCharacter: (String) -> ResolvedCharacter? = currentLayoutKeyCode(for:)
    ) throws -> NativeKeyCombo {
        var parts = keyString.split(separator: "+", omittingEmptySubsequences: true).map(String.init)
        guard let key = parts.popLast(), !key.isEmpty else {
            throw ToolInputError("press_key requires a non-empty key such as Enter, Tab, or Meta+a")
        }
        var flags = CGEventFlags()
        for modifier in parts {
            switch modifier.lowercased() {
            case "control", "ctrl": flags.insert(.maskControl)
            case "shift": flags.insert(.maskShift)
            case "alt", "option": flags.insert(.maskAlternate)
            case "meta", "command", "cmd": flags.insert(.maskCommand)
            default:
                throw ToolInputError("Unknown modifier \(modifier). Use Control, Shift, Alt, or Meta.")
            }
        }

        let normalized = key.lowercased()
        if let code = namedKeyCodes[normalized] {
            try refuseBlockedCombo(identity: namedKeyIdentity(code: code), flags: flags, label: keyString)
            return NativeKeyCombo(keyCode: code, flags: flags, label: keyString)
        }

        guard normalized.count == 1 else {
            throw ToolInputError("Native press_key does not support \(key). Use Enter, Tab, Escape, Space, Backspace, Delete, arrows, Home, End, PageUp, PageDown, F1-F12, or a single character.")
        }
        // Judged on the character the caller asked for, not on the keycode it
        // resolves to: Meta+q on AZERTY is keycode 0, and still Command-Q.
        try refuseBlockedCombo(identity: normalized, flags: flags, label: keyString)
        guard let resolved = resolveCharacter(normalized) else {
            let layout = currentKeyboardLayoutName().map { " on \($0)" } ?? ""
            throw ToolInputError("Native press_key cannot type \(key)\(layout). Switch the keyboard layout, or use a named key such as Enter, Tab, or the arrows.")
        }
        if resolved.needsShift { flags.insert(.maskShift) }
        return NativeKeyCombo(keyCode: resolved.keyCode, flags: flags, label: keyString)
    }

    /// A shortcut that native `press_key` will not send. The modifiers are the
    /// ones it requires, so adding Shift or Option to a blocked combination does
    /// not get past it: Command+Shift+Q and Command+Option+Shift+Q are still Q
    /// with Command held.
    struct BlockedNativeCombo: Equatable, Sendable {
        let modifiers: CGEventFlags
        let key: String
        let name: String
    }

    /// Everything here ends the session or takes Safari away from the caller:
    /// quit, close, hide, minimize, switch application, log out, lock, force
    /// quit, or empty the Trash. A real key event cannot be told apart from the
    /// user's own, so unlike a synthetic one there is no page to contain it. Kept
    /// short on purpose; documented in docs/tools.md.
    nonisolated static let blockedNativeCombos: [BlockedNativeCombo] = [
        .init(modifiers: .maskCommand, key: "q", name: "Command+Q"),
        .init(modifiers: .maskCommand, key: "w", name: "Command+W"),
        .init(modifiers: .maskCommand, key: "h", name: "Command+H"),
        .init(modifiers: .maskCommand, key: "m", name: "Command+M"),
        .init(modifiers: .maskCommand, key: "tab", name: "Command+Tab"),
        .init(modifiers: .maskCommand, key: "space", name: "Command+Space"),
        .init(modifiers: .maskControl, key: "space", name: "Control+Space"),
        .init(modifiers: [.maskCommand, .maskAlternate], key: "escape", name: "Command+Option+Escape"),
        .init(modifiers: [.maskCommand, .maskShift], key: "delete", name: "Command+Shift+Delete"),
    ]

    private nonisolated static func namedKeyIdentity(code: CGKeyCode) -> String? {
        switch code {
        case 48: "tab"
        case 49: "space"
        case 53: "escape"
        case 51, 117: "delete" // Backspace and forward delete are both "Delete" to Finder.
        default: nil
        }
    }

    private nonisolated static func refuseBlockedCombo(identity: String?, flags: CGEventFlags, label: String) throws {
        guard let identity,
              let blocked = blockedNativeCombos.first(where: { $0.key == identity && flags.isSuperset(of: $0.modifiers) })
        else { return }
        throw ToolInputError("Native press_key does not send \(label): it includes \(blocked.name), which quits, closes, hides, or leaves Safari, or locks, logs out, or empties the Trash, and a real key event cannot be contained to the page. Use close_tab to close a tab, or omit native to send the key to the page only.")
    }

    nonisolated static func pressNativeKey(_ combo: NativeKeyCombo, deadline: Double? = nil) throws -> String {
        let source = try nativeEventSource(deadline: deadline)
        try postKey(code: combo.keyCode, flags: combo.flags, source: source)
        Thread.sleep(forTimeInterval: 0.005)
        try ensureSafariIsFrontmost(eventsAlreadySent: true)
        return "Pressed \(combo.label) with native input"
    }

    // Bridge payloads cross as JSON strings (background.js stringifies
    // non-string data), so decode from the raw string.
    private struct NativePointerPayload: Codable {
        struct Point: Codable {
            let x: Double
            let y: Double
        }
        let from: Point
        let to: Point?
    }

    /// Internal, not private: `hover` and `drag` build one of these to hand back
    /// to the pointer code below.
    struct NativePointerTargets: Sendable {
        let from: CGPoint
        let to: CGPoint?
    }

    nonisolated static func nativePointerTargets(from data: AnyCodable?) throws -> NativePointerTargets {
        guard let raw = data?.stringValue,
              let payload = try? JSONDecoder().decode(NativePointerPayload.self, from: Data(raw.utf8))
        else {
            throw nativeInputUnavailable("The extension did not return pointer coordinates.")
        }
        return NativePointerTargets(
            from: CGPoint(x: payload.from.x, y: payload.from.y),
            to: payload.to.map { CGPoint(x: $0.x, y: $0.y) }
        )
    }

    // Deadline check, frontmost guard, and event source in one call; every
    // native posting path starts here.
    private nonisolated static func nativeEventSource(deadline: Double? = nil) throws -> CGEventSource {
        try checkNativeDeadline(deadline)
        try ensureSafariIsFrontmost()
        guard let source = CGEventSource(stateID: .hidSystemState) else {
            throw nativeInputUnavailable("macOS could not create a native input event.")
        }
        return source
    }

    /// One on-screen window as the window server reports it. `bounds` are in
    /// global display coordinates with the origin at the top left, which is the
    /// same space the pointer events are posted in.
    struct NativeWindowInfo: Equatable, Sendable {
        let ownerProcessID: pid_t
        let ownerName: String
        let bounds: CGRect
        let layer: Int
        let alpha: Double
    }

    /// Every on-screen window, front to back, across all layers. Overridable so
    /// the pointer guard can be tested against a made-up desktop.
    typealias NativeWindowLister = @Sendable () -> [NativeWindowInfo]

    nonisolated static let liveNativeWindows: NativeWindowLister = {
        guard let list = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements],
            kCGNullWindowID
        ) as? [[String: Any]] else { return [] }
        return list.compactMap { entry in
            guard let pid = entry[kCGWindowOwnerPID as String] as? Int,
                  let boundsDictionary = entry[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDictionary)
            else { return nil }
            return NativeWindowInfo(
                ownerProcessID: pid_t(pid),
                ownerName: entry[kCGWindowOwnerName as String] as? String ?? "another application",
                bounds: bounds,
                layer: entry[kCGWindowLayer as String] as? Int ?? 0,
                alpha: entry[kCGWindowAlpha as String] as? Double ?? 1
            )
        }
    }

    /// Whether the window at the top of the stack under `point` is Safari's.
    ///
    /// The frontmost check says Safari is the active application, which says
    /// nothing about what is drawn at a given point: a window of another app can
    /// sit over part of Safari, and so can the Dock or the menu bar. A pointer
    /// event goes to whatever is topmost there, so a click aimed at a page
    /// element would land in another app. Windows of every layer count, because
    /// the Dock (layer 20) and the menu bar (layer 24) take pointer events just
    /// as an ordinary window does. The two exceptions are fully transparent
    /// windows, which take none, and the window server's own cursor window,
    /// which follows the pointer and so is always under it.
    nonisolated static func ensurePointerIsOverSafari(
        at point: CGPoint,
        windows: [NativeWindowInfo],
        safariProcessIDs: Set<pid_t>
    ) throws {
        let cursorLayer = Int(CGWindowLevelForKey(.cursorWindow))
        let topmost = windows.first { window in
            window.bounds.contains(point) && window.alpha > 0 && window.layer < cursorLayer
        }
        guard let topmost, safariProcessIDs.contains(topmost.ownerProcessID) else {
            throw NativeInputError(failure: nativePointerObscuredFailure(at: point, by: topmost?.ownerName))
        }
    }

    /// The refusal for a pointer target that Safari is not showing. The same
    /// family as losing focus before anything was sent: nothing went out, so the
    /// call can be retried once the window is out of the way.
    nonisolated static func nativePointerObscuredFailure(at point: CGPoint, by owner: String?) -> ToolFailure {
        let spot = "(\(Int(point.x)), \(Int(point.y)))"
        let cause = owner.map { "a window of \($0) is on top of" } ?? "no window is at"
        return ToolFailure(
            code: "native_input_focus_lost",
            message: "Safari is not showing the point \(spot) because \(cause) it, so nothing was sent. Native input posts a real pointer event at that spot, which would go to whatever is there instead. Ask the user to bring the Safari window to the front or move the other window, or omit native to use synthetic input, which does not depend on what is on screen.",
            retryable: true,
            recoveryAction: "ask_user"
        )
    }

    private nonisolated static func ensurePointersAreOverSafari(_ points: [CGPoint], windows: NativeWindowLister) throws {
        let windows = windows()
        let safariProcessIDs = Set(
            NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.Safari").map(\.processIdentifier)
        )
        for point in points {
            try ensurePointerIsOverSafari(at: point, windows: windows, safariProcessIDs: safariProcessIDs)
        }
    }

    nonisolated static func moveNativePointer(
        to target: CGPoint,
        deadline: Double? = nil,
        windows: NativeWindowLister = liveNativeWindows
    ) throws -> String {
        let source = try nativeEventSource(deadline: deadline)
        try ensurePointersAreOverSafari([target], windows: windows)
        let start = CGEvent(source: nil)?.location ?? target
        try postPointerPath(from: start, to: target, mouseType: .mouseMoved, source: source)
        try ensureSafariIsFrontmost(eventsAlreadySent: true)
        return "Moved pointer to (\(Int(target.x)), \(Int(target.y))) with native input"
    }

    nonisolated static func dragNativePointer(
        from start: CGPoint,
        to target: CGPoint,
        deadline: Double? = nil,
        windows: NativeWindowLister = liveNativeWindows
    ) throws -> String {
        let source = try nativeEventSource(deadline: deadline)
        // Both ends up front: a drag refused at its destination would otherwise
        // already have the button down at its source.
        try ensurePointersAreOverSafari([start, target], windows: windows)
        try postMouse(type: .mouseMoved, at: start, source: source)
        Thread.sleep(forTimeInterval: 0.05)
        try postMouse(type: .leftMouseDown, at: start, source: source)
        // Pointer-sensor drag libraries arm on a delay or distance after
        // mousedown; moving immediately can start a text selection instead.
        Thread.sleep(forTimeInterval: 0.15)
        do {
            try checkNativeDeadline(deadline)
            try postPointerPath(from: start, to: target, mouseType: .leftMouseDragged, source: source, maxSteps: 16, interval: 0.02)
        } catch {
            // Never leave the OS button down.
            try? postMouse(type: .leftMouseUp, at: start, source: source)
            throw error
        }
        Thread.sleep(forTimeInterval: 0.05)
        try postMouse(type: .leftMouseUp, at: target, source: source)
        try ensureSafariIsFrontmost(eventsAlreadySent: true)
        return "Dragged from (\(Int(start.x)), \(Int(start.y))) to (\(Int(target.x)), \(Int(target.y))) with native input"
    }

    private nonisolated static func postMouse(
        type: CGEventType,
        at point: CGPoint,
        source: CGEventSource
    ) throws {
        guard let event = CGEvent(
            mouseEventSource: source,
            mouseType: type,
            mouseCursorPosition: point,
            mouseButton: .left
        ) else {
            throw nativeInputUnavailable("macOS could not create a native mouse event.")
        }
        event.post(tap: .cgSessionEventTap)
    }

    // Interpolated so boundary events (mouseout/mouseleave, dragenter/dragover)
    // fire for elements along the path, matching a real pointer's reachability.
    private nonisolated static func postPointerPath(
        from start: CGPoint,
        to target: CGPoint,
        mouseType: CGEventType,
        source: CGEventSource,
        maxSteps: Int = 10,
        interval: TimeInterval = 0.015
    ) throws {
        let distance = hypot(target.x - start.x, target.y - start.y)
        let count = max(1, min(maxSteps, Int(distance / 8)))
        for step in 1...count {
            let t = Double(step) / Double(count)
            let point = CGPoint(
                x: start.x + (target.x - start.x) * t,
                y: start.y + (target.y - start.y) * t
            )
            try postMouse(type: mouseType, at: point, source: source)
            Thread.sleep(forTimeInterval: interval)
        }
    }
}
