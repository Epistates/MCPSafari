import Foundation
import os

// MARK: - Async FIFO Lock

/// A mutual-exclusion lock that can be held across `await`, handing itself to
/// waiters in the order they arrived.
///
/// The server needs one because some tools have a prepare step and an act step
/// that must not be separated. The extension focuses a tab or an element, and
/// only then are the native events posted or the frame captured. The swift-sdk
/// runs every request in its own task and the server is an actor, so another
/// call can run at either `await` in between and move focus somewhere else.
/// Actor isolation does not help: it is released at every suspension point,
/// which is the very thing that has to be bridged.
///
/// Waiting honours cancellation. A task cancelled while queued leaves the queue
/// and throws, so it never takes a turn it has already given up on.
final class AsyncFIFOLock: Sendable {
    private struct Waiter {
        let id: Int
        let continuation: CheckedContinuation<Void, any Error>
    }

    private struct State {
        var isLocked = false
        var nextWaiterID = 0
        var waiters: [Waiter] = []
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    /// Runs `body` while holding the lock, releasing it however `body` exits.
    func withLock<T>(
        isolation: isolated (any Actor)? = #isolation,
        _ body: () async throws -> T
    ) async throws -> T {
        try await acquire()
        defer { release() }
        return try await body()
    }

    private func acquire() async throws {
        try Task.checkCancellation()
        let id = state.withLock { state -> Int in
            defer { state.nextWaiterID += 1 }
            return state.nextWaiterID
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                let acquired = state.withLock { state -> Bool in
                    if !state.isLocked {
                        state.isLocked = true
                        return true
                    }
                    state.waiters.append(Waiter(id: id, continuation: continuation))
                    return false
                }
                if acquired { continuation.resume() }
            }
        } onCancel: {
            let abandoned = state.withLock { state -> CheckedContinuation<Void, any Error>? in
                guard let index = state.waiters.firstIndex(where: { $0.id == id }) else { return nil }
                return state.waiters.remove(at: index).continuation
            }
            abandoned?.resume(throwing: CancellationError())
        }
    }

    /// Passes the lock straight to the longest waiter, so it never reads as free
    /// while somebody is queued for it.
    private func release() {
        let next = state.withLock { state -> CheckedContinuation<Void, any Error>? in
            guard !state.waiters.isEmpty else {
                state.isLocked = false
                return nil
            }
            return state.waiters.removeFirst().continuation
        }
        next?.resume()
    }
}
