import Darwin
import Foundation

// MARK: - Native Input Lock

/// Keeps two mcp-safari processes from posting native input at the same time.
///
/// Several servers can run side by side, one per MCP client, and they share the
/// one keyboard and pointer. The focus lock orders calls inside a process; this
/// orders them between processes. Two servers typing at once would interleave
/// their keystrokes into one stream, and one's focus preparation would move the
/// focus the other's characters depend on. An advisory `flock` on a file beside
/// the tokens is enough: the kernel drops it when the holder exits, however it
/// exits, so a killed server cannot leave the others waiting.
enum NativeInputLock {
    static var defaultURL: URL {
        WebSocketBridge.applicationSupportDirectoryURL.appendingPathComponent("native-input.lock")
    }

    /// How long a call waits for another server to finish. Typing the longest
    /// allowed text takes a few seconds, so this outlasts any one holder.
    static let defaultTimeout: Double = 30

    /// Runs `body` holding the lock, giving up with a retryable refusal once
    /// `timeout` seconds have passed. Waits by polling and suspending, not by
    /// blocking a thread, so a cancelled call stops waiting at once and other
    /// calls keep running.
    static func withLock<T>(
        at url: URL = defaultURL,
        timeout: Double = defaultTimeout,
        isolation: isolated (any Actor)? = #isolation,
        _ body: () async throws -> T
    ) async throws -> T {
        let descriptor = try await acquire(url, timeout: timeout)
        defer {
            flock(descriptor, LOCK_UN)
            close(descriptor)
        }
        return try await body()
    }

    private static func acquire(_ url: URL, timeout: Double) async throws -> Int32 {
        do {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            throw unavailable("it could not create \(url.deletingLastPathComponent().path) (\(error.localizedDescription))")
        }
        let descriptor = open(url.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else {
            throw unavailable("it could not open \(url.path) (\(String(cString: strerror(errno))))")
        }

        let deadline = ProcessInfo.processInfo.systemUptime + timeout
        do {
            while true {
                try Task.checkCancellation()
                if flock(descriptor, LOCK_EX | LOCK_NB) == 0 { return descriptor }
                let reason = errno
                guard reason == EWOULDBLOCK || reason == EINTR else {
                    throw unavailable("it could not lock \(url.path) (\(String(cString: strerror(reason))))")
                }
                guard ProcessInfo.processInfo.systemUptime < deadline else { throw busy }
                try await Task.sleep(for: .milliseconds(25))
            }
        } catch {
            close(descriptor)
            throw error
        }
    }

    private static var busy: SafariMCPServer.NativeInputError {
        SafariMCPServer.NativeInputError(failure: ToolFailure(
            code: "native_input_busy",
            message: "Another mcp-safari server is sending native input and did not finish in time, so nothing was sent. The keyboard and pointer are shared, and two servers using them at once would mix their input. Retry in a moment.",
            retryable: true,
            recoveryAction: "retry"
        ))
    }

    private static func unavailable(_ reason: String) -> SafariMCPServer.NativeInputError {
        SafariMCPServer.NativeInputError(failure: ToolFailure(
            code: "native_input_unavailable",
            message: "Native input is not available because \(reason). The lock that keeps two servers from typing at once lives there.",
            retryable: false,
            recoveryAction: "inspect_error"
        ))
    }
}
