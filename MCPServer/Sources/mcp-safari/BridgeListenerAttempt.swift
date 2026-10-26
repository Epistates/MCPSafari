import Foundation
import Network

// MARK: - Listener Attempt

/// How one try at binding a port turns out.
///
/// An `NWListener` reports progress through a state handler, and a bind attempt has
/// to turn that stream into a single yes or no. Every state that settles the
/// question is listed here, and a deadline covers the ones that never arrive, so
/// `start()` cannot wait on a listener that has stopped talking.
enum ListenerAttempt {
    /// How long a port gets to become ready before the sweep moves on.
    static let deadline: Duration = .seconds(2)

    /// Whether `state` settles the attempt: true for bound, false for given up,
    /// nil for still in progress.
    ///
    /// `.waiting` is a failure here, not a pause. It is what a listener reports when
    /// it cannot bind yet and is retrying on its own schedule, which is no use to a
    /// sweep that has nine other ports to try, and it never resolves to `.ready` or
    /// `.failed` on a timescale `initialize` can wait for. `.cancelled` is terminal
    /// too: a `stop()` that lands mid-sweep produces it.
    static func verdict(for state: NWListener.State) -> Bool? {
        switch state {
        case .ready: true
        case .failed, .cancelled, .waiting: false
        case .setup: nil
        @unknown default: nil
        }
    }

    /// The first verdict `verdicts` yields, or false if none arrives within `timeout`.
    static func outcome(of verdicts: AsyncStream<Bool>, timeout: Duration = deadline) async -> Bool {
        await withTaskGroup(of: Bool.self) { group in
            group.addTask {
                for await verdict in verdicts { return verdict }
                return false
            }
            group.addTask {
                try? await Task.sleep(for: timeout)
                return false
            }
            let first = await group.next() ?? false
            group.cancelAll()
            return first
        }
    }
}
