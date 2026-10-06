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
        let submitKey: String?
        let submitKeyCode: CGKeyCode?
    }

    nonisolated static func nativeInputPlan(_ args: [String: Value]) throws -> NativeInputPlan {
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
        try ensureNativeInputPermission()

        return NativeInputPlan(
            text: text,
            clearFirst: args["clearFirst"]?.boolValue == true,
            submitKey: submitKey,
            submitKeyCode: submitKeyCode
        )
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

    nonisolated static func typeNativeText(
        _ input: NativeInputPlan,
        deadline: Double? = nil
    ) throws -> String {
        func checkDeadline() throws {
            try checkNativeDeadline(deadline)
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
        try ensureSafariIsFrontmost(eventsAlreadySent: true)

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

    /// What losing Safari's focus means, which depends entirely on whether
    /// anything has been delivered yet.
    ///
    /// `eventsAlreadySent` rather than `afterTyping`: the guard runs after
    /// `press_key`, `hover`, and `drag` too, and in every case the question is
    /// the same one. Nothing sent is a clean refusal the caller can retry.
    /// Something sent is not retryable, because a retry is not a recovery, it is
    /// a second stream of input into whatever is frontmost now.
    nonisolated static func nativeFocusFailure(eventsAlreadySent: Bool) -> ToolFailure {
        ToolFailure(
            code: "native_input_focus_lost",
            message: eventsAlreadySent
                ? "Safari lost focus during native input, so some events may have gone to another application. Tell the user before retrying: a retry sends the whole input again."
                : "Safari is not the frontmost application, so nothing was sent. Native input takes over the user's keyboard and mouse, so ask the user before bringing Safari to the front unless they have already allowed it, or omit native to use synthetic input, which does not need focus.",
            retryable: !eventsAlreadySent,
            recoveryAction: "ask_user"
        )
    }

    private nonisolated static func ensureSafariIsFrontmost(eventsAlreadySent: Bool = false) throws {
        // NSWorkspace.frontmostApplication freezes at first touch in this
        // run-loop-less process; a fresh fetch reads current state.
        let safariIsActive = NSRunningApplication
            .runningApplications(withBundleIdentifier: "com.apple.Safari")
            .contains { $0.isActive }
        guard safariIsActive else {
            throw NativeInputError(failure: nativeFocusFailure(eventsAlreadySent: eventsAlreadySent))
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
            return NativeKeyCombo(keyCode: code, flags: flags, label: keyString)
        }

        guard normalized.count == 1 else {
            throw ToolInputError("Native press_key does not support \(key). Use Enter, Tab, Escape, Space, Backspace, Delete, arrows, Home, End, PageUp, PageDown, F1-F12, or a single character.")
        }
        guard let resolved = resolveCharacter(normalized) else {
            let layout = currentKeyboardLayoutName().map { " on \($0)" } ?? ""
            throw ToolInputError("Native press_key cannot type \(key)\(layout). Switch the keyboard layout, or use a named key such as Enter, Tab, or the arrows.")
        }
        if resolved.needsShift { flags.insert(.maskShift) }
        return NativeKeyCombo(keyCode: resolved.keyCode, flags: flags, label: keyString)
    }

    nonisolated static func pressNativeKey(_ combo: NativeKeyCombo, deadline: Double? = nil) throws -> String {
        let source = try nativeEventSource(deadline: deadline)
        try postKey(code: combo.keyCode, flags: combo.flags, source: source)
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

    nonisolated static func moveNativePointer(to target: CGPoint, deadline: Double? = nil) throws -> String {
        let source = try nativeEventSource(deadline: deadline)
        let start = CGEvent(source: nil)?.location ?? target
        try postPointerPath(from: start, to: target, mouseType: .mouseMoved, source: source)
        try ensureSafariIsFrontmost(eventsAlreadySent: true)
        return "Moved pointer to (\(Int(target.x)), \(Int(target.y))) with native input"
    }

    nonisolated static func dragNativePointer(from start: CGPoint, to target: CGPoint, deadline: Double? = nil) throws -> String {
        let source = try nativeEventSource(deadline: deadline)
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
