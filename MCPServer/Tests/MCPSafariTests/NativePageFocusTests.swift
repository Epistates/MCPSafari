import Foundation
import Testing
@testable import MCPSafari

/// Safari's own controls can hold the keyboard while its window is in front,
/// and then no native key reaches the page. These cover moving the keyboard into
/// the page through Accessibility, only for the agent's own window, and saying
/// where the keyboard is when that can't be done.
struct NativePageFocusTests {
    private typealias Server = SafariMCPServer

    private static let address = "https://forms.example/apply"
    /// What the extension sends for that address, from Node's SHA-256.
    private static let addressDigest = "fbb7c5526aee5696b9af4a3c873d6a803163ff0ad4b6a80c8ac82995c8dfa155"
    private static let target = Server.NativeTarget(
        left: 40, top: 60, width: 1200, height: 900, title: "Nominations", urlDigest: addressDigest
    )
    private static let targetWindow = Server.NativeWindowSummary(
        frame: CGRect(x: 40, y: 60, width: 1200, height: 900),
        title: "Nominations",
        url: address
    )

    // MARK: Which window

    @Test func theAgentsWindowIsKnownByItsSizeTitleAndAddress() {
        #expect(Server.windowIsTarget(Self.targetWindow, Self.target))
        // The two sides round differently.
        let rounded = Server.NativeWindowSummary(
            frame: CGRect(x: 41, y: 59, width: 1201, height: 899), title: "Nominations", url: Self.address + "#dates"
        )
        #expect(Server.windowIsTarget(rounded, Self.target))
    }

    /// Safari puts a profile's name before the page title in that profile's
    /// windows, so an agent working in a second profile was refused in its own
    /// window (found at the 0.4.1 sitting).
    @Test func aWindowOfAnotherProfileIsKnownWithItsProfileNameInTheTitle() {
        let profiled = Server.NativeWindowSummary(
            frame: Self.targetWindow.frame, title: "mcpsafari_test \u{2014} Nominations", url: Self.address
        )
        #expect(Server.windowIsTarget(profiled, Self.target))
        // The name has to be the whole of what comes first: a title that merely
        // ends the same way is another page.
        let longer = Server.NativeWindowSummary(
            frame: Self.targetWindow.frame, title: "Late Nominations", url: Self.address
        )
        #expect(!Server.windowIsTarget(longer, Self.target))
        let otherTab = Server.NativeWindowSummary(
            frame: Self.targetWindow.frame, title: "mcpsafari_test \u{2014} Inbox", url: Self.address
        )
        #expect(!Server.windowIsTarget(otherTab, Self.target))
    }

    /// Safari measures a window's top from the top of its own display, so on a
    /// second display that isn't level with the main one the extension's
    /// position and Accessibility's differ (974 points on the sitting's Mac).
    @Test func theAgentsWindowIsKnownOnADisplayThatIsNotLevelWithTheMainOne() {
        let elsewhere = Server.NativeWindowSummary(
            frame: CGRect(x: 40, y: -914, width: 1200, height: 900), title: "Nominations", url: Self.address
        )
        #expect(Server.windowIsTarget(elsewhere, Self.target))
    }

    @Test func anotherWindowIsNotTheAgentsEvenWithTheSameTitleOrSize() {
        let resized = Server.NativeWindowSummary(
            frame: CGRect(x: 40, y: 60, width: 1000, height: 900), title: "Nominations", url: Self.address
        )
        #expect(!Server.windowIsTarget(resized, Self.target))
        // Same frame, another tab showing: the agent's tab isn't the one in front.
        let otherTab = Server.NativeWindowSummary(frame: Self.targetWindow.frame, title: "Inbox", url: Self.address)
        #expect(!Server.windowIsTarget(otherTab, Self.target))
        // Same frame and title, another page.
        let otherPage = Server.NativeWindowSummary(
            frame: Self.targetWindow.frame, title: "Nominations", url: "https://forms.example/apply/2"
        )
        #expect(!Server.windowIsTarget(otherPage, Self.target))
        // An address Accessibility won't give can't be confirmed.
        let unread = Server.NativeWindowSummary(frame: Self.targetWindow.frame, title: "Nominations")
        #expect(!Server.windowIsTarget(unread, Self.target))
    }

    // MARK: Where a pointer point is on screen

    /// The agent's window on the sitting's second display, which sits 974 points
    /// above the main one: Safari's screenY put the click 974 points low.
    private static let lgWindow = Server.NativeWindowSummary(
        frame: CGRect(x: -2497, y: -872, width: 1200, height: 900),
        title: "Nominations",
        url: address,
        page: CGRect(x: -2497, y: -820, width: 1185, height: 7711)
    )

    private func pointerTargets(page from: CGPoint, guess: CGPoint = CGPoint(x: -2317, y: 214)) -> Server.NativePointerTargets {
        Server.NativePointerTargets(from: guess, to: nil, pageFrom: from, pageTo: nil, target: Self.target)
    }

    @Test func aPointerPointIsPlacedFromWhereAccessibilityShowsThePage() throws {
        let placed = try Server.placedPointerTargets(pointerTargets(page: CGPoint(x: 180, y: 60)), windows: [Self.lgWindow])
        #expect(placed.from == CGPoint(x: -2317, y: -760))
        #expect(placed.window == Self.lgWindow.frame)
    }

    @Test func aScrolledPageIsPlacedFromItsMovedOrigin() throws {
        // Scrolled 500: the web area's origin moves up 500, the page point down 500.
        var scrolled = Self.lgWindow
        scrolled.page = CGRect(x: -2497, y: -1320, width: 1185, height: 7711)
        let placed = try Server.placedPointerTargets(pointerTargets(page: CGPoint(x: 180, y: 560)), windows: [scrolled])
        #expect(placed.from == CGPoint(x: -2317, y: -760))
    }

    @Test func aDragsBothEndsArePlaced() throws {
        let targets = Server.NativePointerTargets(
            from: .zero, to: .zero, pageFrom: CGPoint(x: 10, y: 20), pageTo: CGPoint(x: 110, y: 220), target: Self.target
        )
        let placed = try Server.placedPointerTargets(targets, windows: [Self.lgWindow])
        #expect(placed.from == CGPoint(x: -2487, y: -800))
        #expect(placed.to == CGPoint(x: -2387, y: -600))
    }

    @Test func anOlderExtensionsPointsAreUsedAsTheyCame() throws {
        let old = Server.NativePointerTargets(from: CGPoint(x: 160, y: 290), to: nil)
        let placed = try Server.placedPointerTargets(old, windows: [Self.lgWindow])
        #expect(placed.from == CGPoint(x: 160, y: 290))
        #expect(placed.window == nil)
    }

    @Test func aPointerPointWithNoWindowOrTwoWindowsToPlaceItInIsRefused() {
        let failure = { (windows: [Server.NativeWindowSummary]) -> ToolFailure? in
            do {
                _ = try Server.placedPointerTargets(self.pointerTargets(page: CGPoint(x: 180, y: 60)), windows: windows)
                return nil
            } catch let error as Server.NativeInputError {
                return error.failure
            } catch {
                return nil
            }
        }
        #expect(failure([])?.code == "native_input_focus_failed")
        var pageless = Self.lgWindow
        pageless.page = nil
        #expect(failure([pageless])?.code == "native_input_focus_failed")
        #expect(failure([Self.lgWindow, Self.lgWindow])?.message.contains("same") == true)
    }

    @Test func theAddressDigestMatchesTheExtensionsAndIgnoresTheFragment() {
        #expect(Server.urlDigest(Self.address) == Self.addressDigest)
        #expect(Server.urlDigest(Self.address + "#section") == Self.addressDigest)
    }

    @Test func aTabWithNoTitleYetIsMatchedByFrameAlone() {
        let untitled = Server.NativeTarget(left: 40, top: 60, width: 1200, height: 900, title: "", urlDigest: "")
        let window = Server.NativeWindowSummary(frame: Self.targetWindow.frame, title: "Loading")
        #expect(Server.windowIsTarget(window, untitled))
    }

    // MARK: Who has the keyboard

    private static func safari(
        role: String = "AXTextField",
        description: String? = nil,
        placeholder: String? = nil,
        window: Server.NativeWindowSummary? = targetWindow,
        inPage: Bool = false
    ) -> Server.FocusedElementSummary {
        var summary = Server.FocusedElementSummary(applicationIsSafari: true, applicationName: "Safari")
        summary.role = role
        summary.description = description
        summary.placeholder = placeholder
        summary.window = window
        summary.inPage = inPage
        return summary
    }

    @Test func theAddressBarIsNamedAsSuch() {
        #expect(Server.keyboardHolder(Self.safari(description: "Smart Search Field"), target: Self.target) == .addressBar)
        #expect(Server.keyboardHolder(
            Self.safari(placeholder: "Search or enter website name"), target: Self.target
        ) == .addressBar)
    }

    @Test func theFindBarIsNamedAsSuch() {
        #expect(Server.keyboardHolder(Self.safari(role: "AXSearchField", description: "Find"), target: Self.target) == .findBar)
    }

    @Test func anotherApplicationOrWindowIsNamedAsSuch() {
        let terminal = Server.FocusedElementSummary(applicationIsSafari: false, applicationName: "Terminal")
        #expect(Server.keyboardHolder(terminal, target: Self.target) == .otherApplication("Terminal"))

        let elsewhere = Server.NativeWindowSummary(frame: CGRect(x: 0, y: 0, width: 600, height: 400), title: "Inbox")
        #expect(Server.keyboardHolder(
            Self.safari(description: "Smart Search Field", window: elsewhere), target: Self.target
        ) == .otherSafariWindow(title: "Inbox"))
    }

    @Test func aControlInThePageIsThePage() {
        #expect(Server.keyboardHolder(Self.safari(description: "Email", inPage: true), target: Self.target) == .page)
    }

    @Test func otherControlsAreNamedAsAccessibilityDescribesThem() {
        #expect(Server.keyboardHolder(Self.safari(role: "AXButton", description: "Sidebar"), target: Self.target)
            == .safariControl("Sidebar"))
        #expect(Server.keyboardHolder(nil, target: Self.target) == .unknown)
    }

    // MARK: What the caller is told

    @Test func theRefusalSaysWhereTheKeyboardIsAndWhatTheUserShouldDo() {
        let failure = Server.pageFocusFailure(.addressBar, keyboard: true)
        #expect(failure.code == "native_input_focus_failed")
        #expect(failure.recoveryAction == "ask_user")
        #expect(failure.retryable)
        #expect(failure.message.hasPrefix("Safari's address bar has the keyboard, not the page, so nothing was sent."))
        #expect(failure.message.contains("click in the page"))
        #expect(failure.message.contains("click and native: true"))

        // A click is itself the way into the page, so it isn't told to click first.
        #expect(!Server.pageFocusFailure(.addressBar, keyboard: false).message.contains("native: true"))
        #expect(Server.pageFocusFailure(.otherSafariWindow(title: "Inbox"), keyboard: true).message
            .hasPrefix("Another Safari window (\"Inbox\") has the keyboard"))
    }

    // MARK: The whole step

    private final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var prepared: [Bool] = []
        private var focused = 0
        func prepare(_ verified: Bool) { lock.withLock { prepared.append(verified) } }
        func focus() { lock.withLock { focused += 1 } }
        var preparations: [Bool] { lock.withLock { prepared } }
        var focusRequests: Int { lock.withLock { focused } }
    }

    private static func response(_ success: Bool, target: Server.NativeTarget? = Self.target, code: String = "native_input_focus_failed") -> BridgeResponse {
        let data = target.map { t in
            AnyCodable(#"{"nativeTarget":{"left":\#(t.left),"top":\#(t.top),"width":\#(t.width),"height":\#(t.height),"title":"\#(t.title ?? "")","urlDigest":"\#(t.urlDigest ?? "")"}}"#)
        }
        return BridgeResponse(
            id: "r1",
            success: success,
            data: success ? AnyCodable("Safari is ready for native input") : data,
            error: success ? nil : "The page does not have focus",
            errorCode: success ? nil : code,
            retryable: success ? nil : true,
            recoveryAction: success ? nil : "retry",
            resolvedTabId: 7,
            profileIndex: 0
        )
    }

    private static func focus(
        _ calls: Calls,
        front: Server.NativeWindowSummary? = targetWindow,
        others: [Server.NativeWindowSummary] = [],
        moves: Bool = true,
        holder: Server.FocusedElementSummary? = safari(description: "Smart Search Field")
    ) -> Server.NativePageFocus {
        Server.NativePageFocus(
            frontWindow: { front },
            windows: { (front.map { [$0] } ?? []) + others },
            focusPage: { calls.focus(); return moves },
            focusedElement: { holder },
            settle: {}
        )
    }

    @Test func aPageThatHasTheKeyboardIsPreparedOnceAndAccessibilityIsntAsked() async throws {
        let calls = Calls()
        let result = try await Server.prepareNativeInput(pointer: false, pageFocus: Self.focus(calls)) { verified in
            calls.prepare(verified)
            return Self.response(true)
        }
        #expect(result.success)
        #expect(calls.preparations == [false])
        #expect(calls.focusRequests == 0)
    }

    @Test func theKeyboardIsMovedIntoTheAgentsPageAndThePageIsAskedAgain() async throws {
        let calls = Calls()
        let result = try await Server.prepareNativeInput(pointer: false, pageFocus: Self.focus(calls)) { verified in
            calls.prepare(verified)
            return Self.response(calls.preparations.count > 1)
        }
        #expect(result.success)
        #expect(calls.preparations == [false, false])
        #expect(calls.focusRequests == 1)
    }

    /// The safety rule: with another window in front, focusing "the page in
    /// front" would hand the keyboard to a page the user has open.
    @Test func nothingIsFocusedWhenTheWindowInFrontIsntTheAgents() async throws {
        for front in [Server.NativeWindowSummary(frame: CGRect(x: 0, y: 0, width: 800, height: 600), title: "Mail"), nil] {
            let calls = Calls()
            await #expect {
                _ = try await Server.prepareNativeInput(pointer: false, pageFocus: Self.focus(calls, front: front)) { verified in
                    calls.prepare(verified)
                    return Self.response(false)
                }
            } throws: { error in
                (error as? Server.NativeInputError)?.failure.message
                    .hasPrefix("The Safari window in front isn't the one holding the agent's tab") == true
            }
            #expect(calls.focusRequests == 0)
            #expect(calls.preparations == [false])
        }
    }

    /// Two maximized windows on the same page agree on frame, title and address,
    /// and then there's no telling which is the agent's.
    @Test func nothingIsFocusedWhenAnotherWindowLooksJustLikeTheAgents() async throws {
        let calls = Calls()
        await #expect {
            _ = try await Server.prepareNativeInput(
                pointer: true,
                pageFocus: Self.focus(calls, others: [Self.targetWindow])
            ) { verified in
                calls.prepare(verified)
                return Self.response(false)
            }
        } throws: { error in
            (error as? Server.NativeInputError)?.failure.message
                .hasPrefix("More than one Safari window shows the agent's page") == true
        }
        #expect(calls.focusRequests == 0)
        #expect(calls.preparations == [false])
    }

    @Test func keysAreRefusedWithWhereTheKeyboardIsWhenItWontMove() async throws {
        let calls = Calls()
        await #expect {
            _ = try await Server.prepareNativeInput(pointer: false, pageFocus: Self.focus(calls, moves: false)) { verified in
                calls.prepare(verified)
                return Self.response(false)
            }
        } throws: { error in
            (error as? Server.NativeInputError)?.failure.message
                .hasPrefix("Safari's address bar has the keyboard, not the page") == true
        }
        // Keys never go on without the page holding the keyboard.
        #expect(calls.preparations == [false])
    }

    @Test func aClickGoesOnInTheAgentsWindowWhenTheKeyboardWontMove() async throws {
        let calls = Calls()
        let result = try await Server.prepareNativeInput(pointer: true, pageFocus: Self.focus(calls, moves: false)) { verified in
            calls.prepare(verified)
            return Self.response(verified)
        }
        #expect(result.success)
        #expect(calls.preparations == [false, true])
    }

    @Test func aPageThatHasTheKeyboardButStillRefusesKeepsItsOwnReason() async throws {
        let calls = Calls()
        let result = try await Server.prepareNativeInput(
            pointer: false,
            pageFocus: Self.focus(calls, holder: Self.safari(description: "Email", inPage: true))
        ) { verified in
            calls.prepare(verified)
            return Self.response(false)
        }
        #expect(!result.success)
        #expect(result.error == "The page does not have focus")
        #expect(calls.preparations == [false, false])
    }

    /// An older extension attaches no window, so its refusal stands as before.
    @Test func aRefusalWithoutTheWindowStandsAsItWas() async throws {
        let calls = Calls()
        let result = try await Server.prepareNativeInput(pointer: false, pageFocus: Self.focus(calls)) { verified in
            calls.prepare(verified)
            return Self.response(false, target: nil)
        }
        #expect(!result.success)
        #expect(calls.focusRequests == 0)
        #expect(calls.preparations == [false])
    }
}
