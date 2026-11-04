import CoreGraphics
import Foundation
import os
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

    /// Stands in for the pointer. Records what would have been posted and lets a
    /// test decide who is in front and where Safari's windows are.
    private final class FakePointer: @unchecked Sendable {
        private let lock = NSLock()
        private var events: [String] = []
        private var fronts = 0
        let loseFrontOnCheck: Int?
        let onPost: (@Sendable (Int) -> Void)?

        init(loseFrontOnCheck: Int? = nil, onPost: (@Sendable (Int) -> Void)? = nil) {
            self.loseFrontOnCheck = loseFrontOnCheck
            self.onPost = onPost
        }

        var posted: [String] { lock.withLock { events } }

        var pointer: SafariMCPServer.NativePointer {
            .init(
                safariIsFrontmost: { [self] in
                    lock.withLock {
                        fronts += 1
                        return fronts != loseFrontOnCheck
                    }
                },
                safariProcessIDs: { [NativePointerGuardTests.safari] },
                location: { CGPoint(x: 0, y: 0) },
                post: { [self] type, point in
                    let count = lock.withLock { () -> Int in
                        events.append("\(type.rawValue):\(Int(point.x)),\(Int(point.y))")
                        return events.count
                    }
                    onPost?(count)
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

    private var overSafari: SafariMCPServer.NativeWindowLister {
        let window = SafariMCPServer.NativeWindowInfo(
            ownerProcessID: Self.safari, ownerName: "Safari",
            bounds: CGRect(x: 0, y: 0, width: 1000, height: 800), layer: 0, alpha: 1
        )
        return { [window] }
    }

    @Test func theInjectedListingDecidesWhetherAnyEventIsPosted() async {
        // A listing that covers the target never gets as far as an event.
        let fake = FakePointer()
        let covered: SafariMCPServer.NativeWindowLister = { [] }
        let failed = await failure {
            try await SafariMCPServer.moveNativePointer(to: CGPoint(x: 5, y: 5), windows: covered, pointer: fake.pointer)
        }
        #expect(failed?.code == "native_input_focus_lost")
        #expect(fake.posted.isEmpty)
    }

    @Test func safariNotInFrontSendsNothing() async {
        let fake = FakePointer(loseFrontOnCheck: 1)
        let failed = await failure {
            try await SafariMCPServer.dragNativePointer(
                from: CGPoint(x: 10, y: 10), to: CGPoint(x: 200, y: 200),
                windows: overSafari, pointer: fake.pointer
            )
        }
        #expect(failed?.message.contains("not the frontmost application") == true)
        #expect(fake.posted.isEmpty)
    }

    @Test func aDragPressesMovesAndReleases() async throws {
        let fake = FakePointer()
        let message = try await SafariMCPServer.dragNativePointer(
            from: CGPoint(x: 10, y: 10), to: CGPoint(x: 90, y: 10),
            windows: overSafari, pointer: fake.pointer
        )
        let down = CGEventType.leftMouseDown.rawValue
        let up = CGEventType.leftMouseUp.rawValue
        #expect(fake.posted.first == "\(CGEventType.mouseMoved.rawValue):10,10")
        #expect(fake.posted[1] == "\(down):10,10")
        #expect(fake.posted.last == "\(up):90,10")
        #expect(fake.posted.filter { $0.hasPrefix("\(CGEventType.leftMouseDragged.rawValue):") }.count == 10)
        #expect(message == "Dragged from (10, 10) to (90, 10) with native input")
    }

    // A drag waits about six tenths of a second between its events. If that wait
    // blocked the caller's actor, every other call on the server would wait too.
    @Test func aDragDoesNotHoldTheCallersActor() async throws {
        let fake = FakePointer()
        let probe = Probe()

        let dragging = Task {
            try await probe.drag(
                SafariMCPServer.NativeWindowInfo(
                    ownerProcessID: Self.safari, ownerName: "Safari",
                    bounds: CGRect(x: 0, y: 0, width: 1000, height: 800), layer: 0, alpha: 1
                ),
                pointer: fake.pointer
            )
        }
        try await Task.sleep(for: .milliseconds(100))
        let answeredWhileDragging = await probe.ping()
        let postedByThen = fake.posted.count
        _ = try await dragging.value

        #expect(answeredWhileDragging)
        #expect(postedByThen < fake.posted.count, "the ping was answered before the drag finished")
    }

    private actor Probe {
        func drag(_ window: SafariMCPServer.NativeWindowInfo, pointer: SafariMCPServer.NativePointer) async throws {
            _ = try await SafariMCPServer.dragNativePointer(
                from: CGPoint(x: 10, y: 10), to: CGPoint(x: 600, y: 10),
                windows: { [window] }, pointer: pointer
            )
        }

        func ping() -> Bool { true }
    }

    // Never leave the OS button down, even when the call is cancelled mid-drag.
    @Test func aCancelledDragStillReleasesTheButton() async throws {
        let fake = FakePointer()
        let task = Task {
            try await SafariMCPServer.dragNativePointer(
                from: CGPoint(x: 10, y: 10), to: CGPoint(x: 600, y: 10),
                windows: overSafari, pointer: fake.pointer
            )
        }
        try await Task.sleep(for: .milliseconds(120))
        task.cancel()
        var cancelled = false
        do { _ = try await task.value } catch is CancellationError { cancelled = true }

        #expect(cancelled)
        #expect(fake.posted.contains { $0.hasPrefix("\(CGEventType.leftMouseDown.rawValue):") })
        #expect(fake.posted.last?.hasPrefix("\(CGEventType.leftMouseUp.rawValue):") == true)
    }

    @Test func pressingAKeyDoesNotBlockAndReportsFocusLostAfterwards() async {
        let combo = SafariMCPServer.NativeKeyCombo(keyCode: 36, flags: [], label: "Enter")
        let sent = OSAllocatedUnfairLock(initialState: [CGKeyCode]())
        let checks = OSAllocatedUnfairLock(initialState: 0)
        let keyboard = SafariMCPServer.NativeKeyboard(
            safariIsFrontmost: { checks.withLock { $0 += 1; return $0 == 1 } },
            postText: { _ in },
            postKey: { code, _ in sent.withLock { $0.append(code) } }
        )
        let failed = await failure { try await SafariMCPServer.pressNativeKey(combo, keyboard: keyboard) }

        #expect(sent.withLock { $0 } == [36])
        #expect(failed?.message.contains("some events may have gone to another application") == true)
    }
}
