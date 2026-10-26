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
        try SafariMCPServer.nativeInputPlan(args, resolveCharacter: { layout[$0] }, permission: {})
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
        let loseFocusOnCheck: Int?
        let onText: (@Sendable (Int) -> Void)?

        init(loseFocusOnCheck: Int? = nil, onText: (@Sendable (Int) -> Void)? = nil) {
            self.loseFocusOnCheck = loseFocusOnCheck
            self.onText = onText
        }

        var posted: [String] { lock.withLock { events } }
        var checks: Int { lock.withLock { focusChecks } }

        var keyboard: SafariMCPServer.NativeKeyboard {
            .init(
                safariIsFrontmost: { [self] in
                    lock.withLock {
                        focusChecks += 1
                        return focusChecks != loseFocusOnCheck
                    }
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
}
