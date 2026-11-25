import CoreGraphics
import Foundation

// MARK: - User Activity

/// Keeps native input from starting while someone is using the Mac.
///
/// Native input takes over the one keyboard and pointer: it brings Safari and
/// the agent's window to the front, and a person typing at the same time gets
/// their keys mixed with the agent's. So a native call is refused while the
/// keyboard or pointer has been used in the last few seconds.
///
/// macOS counts the events a server posts as input too, so each server records
/// when it last finished posting, in a file beside the native input lock, and
/// only input newer than that counts as a person's. Every server writes the same
/// file while it holds the lock, so one agent's typing isn't mistaken for a
/// person by the next.
enum UserActivity {
    /// How long the keyboard and pointer must have been left alone.
    static let quietSeconds: Double = 5

    /// How much later than a server's own last event the latest input must be to
    /// count as a person's. Posting returns a little before macOS stamps the
    /// event, so a server's own last keystroke can look that much newer.
    static let ownInputSlack: Double = 0.5

    static var recordURL: URL {
        WebSocketBridge.applicationSupportDirectoryURL.appendingPathComponent("native-input.last")
    }

    /// The input a person makes: keys, clicks, pointer moves and scrolls.
    private static let inputEventTypes: [CGEventType] = [
        .keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown,
        .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel,
    ]

    /// Seconds since the last keyboard or pointer event, posted or real.
    static func secondsSinceAnyInput() -> Double {
        inputEventTypes
            .map { CGEventSource.secondsSinceLastEventType(.hidSystemState, eventType: $0) }
            .min() ?? .infinity
    }

    /// Notes that this server has just posted native input. Called while holding
    /// the native input lock, so it never races another server's note.
    static func recordOwnInput(at url: URL = recordURL, now: Date = Date()) {
        let manager = FileManager.default
        if !manager.fileExists(atPath: url.path) {
            manager.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        try? manager.setAttributes([.modificationDate: now], ofItemAtPath: url.path)
    }

    /// Seconds since any server last posted native input, or nil if none has.
    static func secondsSinceOwnInput(at url: URL = recordURL, now: Date = Date()) -> Double? {
        guard let posted = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.modificationDate] as? Date
        else { return nil }
        return now.timeIntervalSince(posted)
    }

    /// Refuses when the latest input is recent and isn't a server's own.
    static func ensureIdle(
        secondsSinceAnyInput: Double = secondsSinceAnyInput(),
        secondsSinceOwnInput: Double? = secondsSinceOwnInput()
    ) throws {
        guard secondsSinceAnyInput < quietSeconds else { return }
        if let own = secondsSinceOwnInput, secondsSinceAnyInput + ownInputSlack >= own { return }
        throw SafariMCPServer.NativeInputError(failure: ToolFailure(
            code: "native_input_user_active",
            message: "Someone used the keyboard or mouse in the last \(Int(quietSeconds)) seconds, so nothing was sent. Native input takes over both and brings Safari to the front, and their keys would mix with these. Retry once they've stopped, or omit native to use synthetic input, which works alongside them.",
            retryable: true,
            recoveryAction: "retry"
        ))
    }
}
