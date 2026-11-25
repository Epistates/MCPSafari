import Foundation
import Testing
@testable import MCPSafari

/// Native input takes over the keyboard and pointer, so it waits for a person to
/// stop using them. macOS counts the events a server posts as input as well, so
/// only input newer than the servers' own counts as a person's.
struct UserActivityTests {
    private func refusal(any: Double, own: Double?) -> ToolFailure? {
        do {
            try UserActivity.ensureIdle(secondsSinceAnyInput: any, secondsSinceOwnInput: own)
            return nil
        } catch let error as SafariMCPServer.NativeInputError {
            return error.failure
        } catch {
            return nil
        }
    }

    @Test func recentInputFromAPersonRefusesWithNothingSent() {
        let refused = refusal(any: 1, own: nil)
        #expect(refused?.code == "native_input_user_active")
        #expect(refused?.retryable == true)
        #expect(refused?.recoveryAction == "retry")
        #expect(refused?.message.contains("nothing was sent") == true)
    }

    @Test func inputAfterAServersOwnTypingIsAPersons() {
        // A server finished typing three seconds ago; someone moved the mouse since.
        #expect(refusal(any: 0.2, own: 3)?.code == "native_input_user_active")
    }

    @Test func aServersOwnLatestEventsAreNotAPerson() {
        // The latest input is the server's own, as an agent clicking a field and
        // then typing into it a second later sees.
        #expect(refusal(any: 1, own: 1) == nil)
        // Posting returns a little before macOS stamps the last event.
        #expect(refusal(any: 1, own: 1.4) == nil)
    }

    @Test func aKeyboardAndPointerLeftAloneLongEnoughAllowNativeInput() {
        #expect(refusal(any: UserActivity.quietSeconds, own: nil) == nil)
        #expect(refusal(any: 60, own: 2) == nil)
    }

    @Test func theRecordSaysHowLongAgoAServerLastPosted() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("native-input.last")
        let posted = Date(timeIntervalSince1970: 1_800_000_000)

        #expect(UserActivity.secondsSinceOwnInput(at: url, now: posted) == nil)
        UserActivity.recordOwnInput(at: url, now: posted)
        let since = try #require(UserActivity.secondsSinceOwnInput(at: url, now: posted.addingTimeInterval(2)))
        #expect(abs(since - 2) < 0.01)
    }

    @Test func theRecordLivesBesideTheNativeInputLock() {
        #expect(UserActivity.recordURL.deletingLastPathComponent().standardizedFileURL
            == NativeInputLock.defaultURL.deletingLastPathComponent().standardizedFileURL)
    }
}
