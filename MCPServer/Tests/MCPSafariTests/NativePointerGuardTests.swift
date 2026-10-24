import CoreGraphics
import Testing
@testable import MCPSafari

/// A pointer event goes to whatever window is topmost at its point. These feed
/// the guard a made-up desktop, front to back, instead of reading the real one.
struct NativePointerGuardTests {
    private static let safari: pid_t = 100
    private static let finder: pid_t = 200

    private func window(
        _ owner: pid_t,
        _ name: String,
        _ bounds: CGRect,
        layer: Int = 0,
        alpha: Double = 1
    ) -> SafariMCPServer.NativeWindowInfo {
        .init(ownerProcessID: owner, ownerName: name, bounds: bounds, layer: layer, alpha: alpha)
    }

    private func refusal(_ point: CGPoint, _ windows: [SafariMCPServer.NativeWindowInfo]) -> ToolFailure? {
        do {
            try SafariMCPServer.ensurePointerIsOverSafari(at: point, windows: windows, safariProcessIDs: [Self.safari])
            return nil
        } catch let error as SafariMCPServer.NativeInputError {
            return error.failure
        } catch {
            return nil
        }
    }

    private let safariWindow = CGRect(x: 0, y: 0, width: 1000, height: 800)

    @Test func aPointInsideTheTopmostSafariWindowPasses() {
        let desktop = [window(Self.safari, "Safari", safariWindow), window(Self.finder, "Finder", safariWindow)]
        #expect(refusal(CGPoint(x: 500, y: 400), desktop) == nil)
    }

    @Test func anotherAppsWindowOnTopRefusesWithNothingSent() throws {
        let desktop = [
            window(Self.finder, "Finder", CGRect(x: 400, y: 300, width: 300, height: 300)),
            window(Self.safari, "Safari", safariWindow),
        ]

        let covered = try #require(refusal(CGPoint(x: 500, y: 400), desktop))

        #expect(covered.code == "native_input_focus_lost")
        #expect(covered.retryable == true)
        #expect(covered.recoveryAction == "ask_user")
        #expect(covered.message.contains("nothing was sent"))
        #expect(covered.message.contains("Finder"))
        // The same desktop leaves the uncovered part of Safari reachable.
        #expect(refusal(CGPoint(x: 50, y: 50), desktop) == nil)
    }

    @Test func aPointOutsideEveryWindowIsRefused() throws {
        let desktop = [window(Self.safari, "Safari", safariWindow)]
        let nowhere = try #require(refusal(CGPoint(x: 1500, y: 400), desktop))
        #expect(nowhere.message.contains("no window is at"))
        #expect(refusal(CGPoint(x: 1, y: 1), []) != nil)
    }

    // The Dock and the menu bar are not layer 0 and they do take the click, so
    // ignoring every other layer would let a click through to the Dock.
    @Test func theDockAndMenuBarCountBecauseTheyTakeClicks() throws {
        let desktop = [
            window(300, "Dock", CGRect(x: 0, y: 760, width: 1000, height: 40), layer: 20),
            window(400, "Window Server", CGRect(x: 0, y: 0, width: 1000, height: 24), layer: 24),
            window(Self.safari, "Safari", safariWindow),
        ]
        #expect(try #require(refusal(CGPoint(x: 500, y: 780), desktop)).message.contains("Dock"))
        #expect(refusal(CGPoint(x: 500, y: 10), desktop) != nil)
        #expect(refusal(CGPoint(x: 500, y: 400), desktop) == nil)
    }

    @Test func transparentWindowsAndTheCursorWindowDoNotCover() {
        let cursorLayer = Int(CGWindowLevelForKey(.cursorWindow))
        let desktop = [
            window(Self.finder, "Overlay", safariWindow, layer: 25, alpha: 0),
            window(400, "Window Server", CGRect(x: 480, y: 380, width: 32, height: 32), layer: cursorLayer),
            window(Self.safari, "Safari", safariWindow),
        ]
        #expect(refusal(CGPoint(x: 490, y: 390), desktop) == nil)
    }

    @Test func safariOwnedFloatingWindowsStillCount() {
        let desktop = [
            window(Self.safari, "Safari", CGRect(x: 100, y: 100, width: 200, height: 200), layer: 3),
            window(Self.safari, "Safari", safariWindow),
        ]
        #expect(refusal(CGPoint(x: 150, y: 150), desktop) == nil)
    }

    @Test func aWindowEdgeBelongsToTheWindowOnlyOnItsLeadingSide() {
        let desktop = [window(Self.safari, "Safari", safariWindow)]
        #expect(refusal(CGPoint(x: 0, y: 0), desktop) == nil)
        #expect(refusal(CGPoint(x: 1000, y: 800), desktop) != nil)
    }

    @Test func theInjectedListingDecidesWhetherAnyEventIsPosted() {
        // Safari is not frontmost on the machine running the suite, so the
        // frontmost guard refuses first. Either way nothing is posted, and a
        // listing that covers the target never gets as far as an event.
        let covered: SafariMCPServer.NativeWindowLister = { [] }
        var failure: ToolFailure?
        do {
            _ = try SafariMCPServer.moveNativePointer(to: CGPoint(x: 5, y: 5), windows: covered)
        } catch let error as SafariMCPServer.NativeInputError {
            failure = error.failure
        } catch {}
        #expect(failure?.code == "native_input_focus_lost")
    }
}
