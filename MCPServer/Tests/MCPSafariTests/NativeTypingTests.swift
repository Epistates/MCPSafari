import ApplicationServices
import CoreGraphics
import Foundation
import MCP
import Testing
@testable import MCPSafari

struct NativeTypingTests {
    private static let qwerty: [String: SafariMCPServer.ResolvedCharacter] = [
        "a": .init(keyCode: 0, needsShift: false),
        "q": .init(keyCode: 12, needsShift: false),
    ]
    private static let azerty: [String: SafariMCPServer.ResolvedCharacter] = [
        "a": .init(keyCode: 12, needsShift: false),
        "q": .init(keyCode: 0, needsShift: false),
    ]

    private func plan(
        _ args: [String: Value],
        layout: [String: SafariMCPServer.ResolvedCharacter] = qwerty
    ) throws -> SafariMCPServer.NativeInputPlan {
        try SafariMCPServer.nativeInputPlan(args, layouts: .init(table: layout), permission: {})
    }

    // Select-all is Command plus a key, so it is read from the ASCII-capable
    // layout. A Russian layout has no `a` of its own, and clearFirst used to be
    // refused there although Command+A works in every app.
    @Test func clearFirstSelectsAllWithTheKeyShortcutsReadAsAOnARussianLayout() throws {
        let layouts = SafariMCPServer.KeyboardLayouts(typed: [:], shortcut: Self.qwerty)
        let plan = try SafariMCPServer.nativeInputPlan(["text": "x", "clearFirst": true], layouts: layouts, permission: {})
        #expect(plan.selectAllKeyCode == 0)
    }

    // clearFirst used to post Command plus keycode 0. That is `a` on QWERTY and
    // `q` on AZERTY, where it is Command-Q and quits Safari.
    @Test func clearFirstSelectsAllWithTheKeyTheLayoutCallsA() throws {
        #expect(try plan(["text": "x", "clearFirst": true]).selectAllKeyCode == 0)
        let french = try plan(["text": "x", "clearFirst": true], layout: Self.azerty)
        #expect(french.selectAllKeyCode == 12)
        #expect(french.selectAllKeyCode != 0)
    }

    @Test func noSelectAllKeyIsResolvedWithoutClearFirst() throws {
        #expect(try plan(["text": "x"]).selectAllKeyCode == nil)
        #expect(try plan(["text": "x", "clearFirst": false]).selectAllKeyCode == nil)
    }

    @Test func aLayoutWithoutAPlainAIsRefusedRatherThanGuessed() {
        for layout in [[:], ["a": SafariMCPServer.ResolvedCharacter(keyCode: 0, needsShift: true)]] {
            var failure: SafariMCPServer.ToolInputError?
            do {
                _ = try plan(["text": "x", "clearFirst": true], layout: layout)
            } catch let error as SafariMCPServer.ToolInputError {
                failure = error
            } catch {}
            #expect(failure?.description.hasPrefix("Native type_text cannot select the field's text first") == true)
        }
        // Without clearFirst the layout is never consulted, so typing still works.
        #expect((try? plan(["text": "x"], layout: [:])) != nil)
    }

    // MARK: - Length cap

    @Test func textBeyondTheCapIsRefusedBeforeAnythingIsSent() {
        let limit = SafariMCPServer.maxNativeTextCharacters
        #expect(limit == 1000)
        #expect((try? plan(["text": .string(String(repeating: "a", count: limit))])) != nil)

        var message: String?
        do {
            _ = try plan(["text": .string(String(repeating: "a", count: limit + 1))])
        } catch let error as SafariMCPServer.ToolInputError {
            message = error.description
        } catch {}
        #expect(message?.contains("Use type_text without native") == true)
        #expect(message?.contains("\(limit + 1)") == true)
    }

    @Test func theCapCountsCharactersTheWayTheLoopTypesThem() {
        // A flag emoji is one character typed in one event but many UTF-16 units.
        let flags = String(repeating: "\u{1F1FA}\u{1F1F8}", count: SafariMCPServer.maxNativeTextCharacters)
        #expect((try? plan(["text": .string(flags)])) != nil)
    }

    // MARK: - Typing loop

    /// Stands in for the keyboard and for Safari's focus. Counts how often focus
    /// was asked about and records what would have been typed.
    private final class FakeKeyboard: @unchecked Sendable {
        private let lock = NSLock()
        private var events: [String] = []
        private var focusChecks = 0
        private var pageChecks = 0
        let loseFocusOnCheck: Int?
        let onText: (@Sendable (Int) -> Void)?
        /// What Accessibility says about keyboard focus at each check, counted from
        /// one; nil, the default, is Accessibility being unable to say.
        let pageFocus: @Sendable (Int) -> Bool?

        init(
            loseFocusOnCheck: Int? = nil,
            pageFocus: @escaping @Sendable (Int) -> Bool? = { _ in nil },
            onText: (@Sendable (Int) -> Void)? = nil
        ) {
            self.loseFocusOnCheck = loseFocusOnCheck
            self.pageFocus = pageFocus
            self.onText = onText
        }

        var posted: [String] { lock.withLock { events } }
        var checks: Int { lock.withLock { focusChecks } }
        var pageFocusChecks: Int { lock.withLock { pageChecks } }

        var keyboard: SafariMCPServer.NativeKeyboard {
            .init(
                safariIsFrontmost: { [self] in
                    lock.withLock {
                        focusChecks += 1
                        return focusChecks != loseFocusOnCheck
                    }
                },
                focusIsInPage: { [self] in
                    let check = lock.withLock { () -> Int in
                        pageChecks += 1
                        return pageChecks
                    }
                    return pageFocus(check)
                },
                postText: { [self] text in
                    let count = lock.withLock { () -> Int in
                        events.append(text)
                        return events.count
                    }
                    onText?(count)
                },
                postKey: { [self] code, flags in
                    lock.withLock { events.append("key:\(code):\(flags.rawValue)") }
                }
            )
        }
    }

    private func failure(_ body: () async throws -> String) async -> ToolFailure? {
        do {
            _ = try await body()
            return nil
        } catch let error as SafariMCPServer.NativeInputError {
            return error.failure
        } catch {
            return nil
        }
    }

    @Test func typesEveryCharacterThenSubmits() async throws {
        let fake = FakeKeyboard()
        let input = try plan(["text": "héllo", "clearFirst": true, "submitKey": "Enter"], layout: Self.azerty)

        let message = try await SafariMCPServer.typeNativeText(input, keyboard: fake.keyboard)

        let selectAll = "key:12:\(CGEventFlags.maskCommand.rawValue)"
        #expect(fake.posted == [selectAll, "key:51:0", "h", "é", "l", "l", "o", "key:36:0"])
        #expect(message == "Typed 5 character(s) with native input then pressed Enter")
    }

    @Test func safariLosingFocusMidTextStopsTheTypingAndSaysHowMuchWentOut() async throws {
        // Checks: once before typing, then before characters 16, 32 and so on.
        let fake = FakeKeyboard(loseFocusOnCheck: 3)
        let input = try plan(["text": .string(String(repeating: "x", count: 100))])

        let failed = await failure { try await SafariMCPServer.typeNativeText(input, keyboard: fake.keyboard) }

        #expect(fake.posted.count == 32)
        #expect(failed?.code == "native_input_focus_lost")
        #expect(failed?.retryable == false)
        #expect(failed?.message.contains("Delivered 32 of 100 characters") == true)
    }

    @Test func focusIsCheckedEverySixteenCharactersAndOnceAtEachEnd() async throws {
        let fake = FakeKeyboard()
        let input = try plan(["text": .string(String(repeating: "x", count: 40))])

        _ = try await SafariMCPServer.typeNativeText(input, keyboard: fake.keyboard)

        // Before typing, before characters 16 and 32, and after the last one.
        #expect(fake.checks == 4)
    }

    @Test func focusMissingUpFrontSendsNothingAndCanBeRetried() async throws {
        let fake = FakeKeyboard(loseFocusOnCheck: 1)
        let input = try plan(["text": "hello"])

        let failed = await failure { try await SafariMCPServer.typeNativeText(input, keyboard: fake.keyboard) }

        #expect(fake.posted.isEmpty)
        #expect(failed?.retryable == true)
        #expect(failed?.message.contains("nothing was sent") == true)
    }

    // MARK: - Focus in the page

    // Safari staying frontmost says nothing about where the keyboard is: Command-L
    // mid-text, or a field that gave up focus, leaves the address bar holding it, and
    // up to fifteen characters and the submit Enter went there.

    @Test func focusAlreadyInTheAddressBarSendsNothingAndCanBeRetried() async throws {
        let fake = FakeKeyboard(pageFocus: { _ in false })
        let input = try plan(["text": "hello", "clearFirst": true])

        let failed = await failure { try await SafariMCPServer.typeNativeText(input, keyboard: fake.keyboard) }

        #expect(fake.posted.isEmpty, "select-all and Backspace went to the address bar")
        #expect(failed?.code == "native_input_focus_lost")
        #expect(failed?.retryable == true)
        #expect(failed?.message.contains("Keyboard focus is not in the page") == true)
        #expect(failed?.message.contains("nothing was sent") == true)
    }

    @Test func focusLeavingThePageMidTextStopsAtTheNextCheckAndSaysHowMuchWentOut() async throws {
        // In the page at the first key, out of it at the check before character 16.
        let fake = FakeKeyboard(pageFocus: { $0 >= 2 ? false : true })
        let input = try plan(["text": .string(String(repeating: "x", count: 100))])

        let failed = await failure { try await SafariMCPServer.typeNativeText(input, keyboard: fake.keyboard) }

        #expect(fake.posted.count == 16)
        #expect(failed?.code == "native_input_focus_lost")
        #expect(failed?.retryable == false)
        #expect(failed?.message.contains("Keyboard focus left the page") == true)
        #expect(failed?.message.contains("Delivered 16 of 100 characters") == true)
    }

    @Test func theSubmitKeyIsNotSentOnAStaleCheck() async throws {
        // Fewer than sixteen characters, so the loop never rechecks. The check before
        // the Enter is what catches focus that left the page while typing.
        let fake = FakeKeyboard(pageFocus: { $0 >= 2 ? false : true })
        let input = try plan(["text": "hello", "submitKey": "Enter"])

        let failed = await failure { try await SafariMCPServer.typeNativeText(input, keyboard: fake.keyboard) }

        #expect(fake.posted == ["h", "e", "l", "l", "o"], "Enter was sent: \(fake.posted)")
        #expect(failed?.retryable == false)
        #expect(failed?.message.contains("Delivered 5 of 5 characters") == true)
    }

    @Test func whenAccessibilityCannotAnswerTypingGoesAheadAsItDidBefore() async throws {
        let fake = FakeKeyboard(pageFocus: { _ in nil })
        let input = try plan(["text": .string(String(repeating: "x", count: 40)), "submitKey": "Enter"])

        let message = try await SafariMCPServer.typeNativeText(input, keyboard: fake.keyboard)

        #expect(fake.posted.count == 41)
        #expect(message == "Typed 40 character(s) with native input then pressed Enter")
        #expect(fake.pageFocusChecks > 0, "the question was never asked")
    }

    @Test func safariNotBeingFrontmostIsStillReportedAsThat() async throws {
        let fake = FakeKeyboard(loseFocusOnCheck: 1, pageFocus: { _ in false })
        let input = try plan(["text": "hello"])

        let failed = await failure { try await SafariMCPServer.typeNativeText(input, keyboard: fake.keyboard) }

        #expect(failed?.message.contains("not the frontmost application") == true)
    }

    // The live answer needs Safari and a grant, which a test run has neither of; what
    // can be pinned is that asking without the grant says nothing rather than "no".
    @Test func withoutAccessibilityTheLiveCheckCannotAnswer() {
        if !AXIsProcessTrusted() {
            #expect(SafariMCPServer.focusedElementIsInWebArea() == nil)
        }
    }

    // The extension is not asked to focus or scroll for input that will be refused.
    @Test func nativeInputIsRefusedBeforeAnythingIsPreparedWhenSafariIsNotInFront() {
        var permissionAsked = false
        var failure: ToolFailure?
        do {
            try SafariMCPServer.ensureNativeInputReady(
                permission: { permissionAsked = true },
                safariIsFrontmost: { false }
            )
        } catch let error as SafariMCPServer.NativeInputError {
            failure = error.failure
        } catch {}
        #expect(permissionAsked)
        #expect(failure?.code == "native_input_focus_lost")
        #expect(failure?.retryable == true)

        // And without the grant the permission is what is reported, whatever is in front.
        var reported: ToolFailure?
        do {
            try SafariMCPServer.ensureNativeInputReady(
                permission: {
                    throw SafariMCPServer.NativeInputError(failure: ToolFailure(
                        code: "native_input_permission_required", message: "", retryable: false, recoveryAction: ""
                    ))
                },
                safariIsFrontmost: { false }
            )
        } catch let error as SafariMCPServer.NativeInputError {
            reported = error.failure
        } catch {}
        #expect(reported?.code == "native_input_permission_required")

        #expect((try? SafariMCPServer.ensureNativeInputReady(permission: {}, safariIsFrontmost: { true })) != nil)
    }

    @Test func aCancelledCallStopsTypingAndReportsWhatWasDelivered() async throws {
        let fake = FakeKeyboard(onText: { count in
            if count == 5 { withUnsafeCurrentTask { $0?.cancel() } }
        })
        let input = try plan(["text": .string(String(repeating: "x", count: 100))])

        let failed = await failure { try await SafariMCPServer.typeNativeText(input, keyboard: fake.keyboard) }

        #expect(fake.posted.count == 5)
        #expect(failed?.code == "native_input_cancelled")
        #expect(failed?.message.contains("5 of 100 characters") == true)
    }

    @Test func anExpiredBatchDeadlineSendsNothing() async throws {
        let fake = FakeKeyboard()
        let input = try plan(["text": "hello"])

        let failed = await failure {
            try await SafariMCPServer.typeNativeText(input, deadline: 0, keyboard: fake.keyboard)
        }

        #expect(fake.posted.isEmpty)
        #expect(failed?.code == "batch_timeout")
    }

    @Test func typingDoesNotHoldTheCallersActor() async throws {
        let fake = FakeKeyboard()
        let input = try plan(["text": .string(String(repeating: "x", count: 60))])
        let probe = Probe()

        // The probe is an actor of its own, standing in for the server actor: if
        // typing ran on it, this call would not return until typing finished.
        let typing = Task { try await probe.type(input, keyboard: fake.keyboard) }
        try await Task.sleep(for: .milliseconds(30))
        let answeredWhileTyping = await probe.ping()
        let typedByThen = fake.posted.count
        _ = try await typing.value

        #expect(answeredWhileTyping)
        #expect(typedByThen < 60, "the ping was answered before typing finished")
    }

    private actor Probe {
        func type(_ input: SafariMCPServer.NativeInputPlan, keyboard: SafariMCPServer.NativeKeyboard) async throws {
            _ = try await SafariMCPServer.typeNativeText(input, keyboard: keyboard)
        }

        func ping() -> Bool { true }
    }

    // MARK: - Modifier leakage

    @Test func typedTextCarriesNoModifierFlags() throws {
        let source = try #require(CGEventSource(stateID: .hidSystemState))
        let events = try SafariMCPServer.textKeyEvents("q", source: source)

        // Whatever the user is holding down, typed text is never a shortcut.
        #expect(events.down.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty)
        #expect(events.up.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty)
        var length = 0
        var buffer = [UniChar](repeating: 0, count: 4)
        events.down.keyboardGetUnicodeString(maxStringLength: 4, actualStringLength: &length, unicodeString: &buffer)
        #expect(String(utf16CodeUnits: buffer, count: length) == "q")
    }

    // The same source reports the user's held modifiers on mouse events, and a
    // hover or drag with Command down is a different gesture. This can only
    // fail on a machine where a modifier is physically held while it runs.
    @Test func pointerEventsCarryNoModifierFlags() throws {
        let source = try #require(CGEventSource(stateID: .hidSystemState))
        for type in [CGEventType.mouseMoved, .leftMouseDown, .leftMouseDragged, .leftMouseUp] {
            let event = try SafariMCPServer.mouseEvent(type: type, at: CGPoint(x: 10, y: 20), source: source)
            #expect(event.flags.intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift]).isEmpty)
            #expect(event.location == CGPoint(x: 10, y: 20))
        }
    }
}
