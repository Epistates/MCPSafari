import Foundation
import Testing
import os
@testable import MCPSafari

/// The server holds this from a tool's prepare step through its act step. What
/// matters is that two such tools never interleave, because the second one's
/// prepare would move the focus the first one's act depends on.
struct AsyncFIFOLockTests {
    private actor Log {
        private(set) var entries: [String] = []
        func add(_ entry: String) { entries.append(entry) }
    }

    @Test func twoCallsNeverInterleave() async throws {
        let lock = AsyncFIFOLock()
        let log = Log()

        try await withThrowingTaskGroup(of: Void.self) { group in
            for call in 0..<12 {
                group.addTask {
                    try await lock.withLock {
                        await log.add("prepare \(call)")
                        // Suspension points inside the section, where an actor
                        // would let another call in.
                        try await Task.sleep(for: .milliseconds(5))
                        await log.add("act \(call)")
                    }
                }
            }
            try await group.waitForAll()
        }

        let entries = await log.entries
        #expect(entries.count == 24)
        // Each prepare is followed by its own act, never by another prepare.
        for pair in stride(from: 0, to: entries.count, by: 2) {
            let call = entries[pair].split(separator: " ").last
            #expect(entries[pair].hasPrefix("prepare"))
            #expect(entries[pair + 1] == "act \(call ?? "")")
        }
    }

    @Test func withoutTheLockTheSameCallsDoInterleave() async throws {
        // Guards the test above: it would pass vacuously if the calls could not
        // interleave in the first place.
        let log = Log()
        await withTaskGroup(of: Void.self) { group in
            for call in 0..<12 {
                group.addTask {
                    await log.add("prepare \(call)")
                    try? await Task.sleep(for: .milliseconds(5))
                    await log.add("act \(call)")
                }
            }
        }
        let entries = await log.entries
        let strictlyPaired = stride(from: 0, to: entries.count, by: 2).allSatisfy {
            entries[$0].hasPrefix("prepare") && entries[$0 + 1] == "act " + (entries[$0].split(separator: " ").last ?? "")
        }
        #expect(!strictlyPaired)
    }

    /// Waits for something the lock reports about itself rather than for a
    /// guessed interval, so the ordering below holds on a slow machine too.
    private func waitUntil(
        _ what: String,
        _ condition: () -> Bool,
        sourceLocation: SourceLocation = #_sourceLocation
    ) async throws {
        let deadline = ContinuousClock.now + .seconds(10)
        while !condition() {
            guard ContinuousClock.now < deadline else {
                Issue.record("Timed out waiting for \(what)", sourceLocation: sourceLocation)
                throw CancellationError()
            }
            try await Task.sleep(for: .milliseconds(1))
        }
    }

    @Test func waitersAreServedInArrivalOrder() async throws {
        let lock = AsyncFIFOLock()
        let log = Log()
        let (gate, open) = AsyncStream<Void>.makeStream()

        let holder = Task {
            try await lock.withLock {
                for await _ in gate { break }
            }
        }
        try await waitUntil("the holder to take the lock") { lock.isHeld }

        var waiters: [Task<Void, any Error>] = []
        for call in 0..<6 {
            waiters.append(Task { try await lock.withLock { await log.add("call \(call)") } })
            // Let each one reach the queue before the next arrives.
            try await waitUntil("waiter \(call) to queue") { lock.queuedCount == call + 1 }
        }
        open.yield()
        try await holder.value
        for waiter in waiters { try await waiter.value }

        #expect(await log.entries == (0..<6).map { "call \($0)" })
    }

    @Test func aCancelledWaiterLeavesTheQueueWithoutTakingATurn() async throws {
        let lock = AsyncFIFOLock()
        let log = Log()
        let (gate, open) = AsyncStream<Void>.makeStream()

        let holder = Task {
            try await lock.withLock {
                for await _ in gate { break }
            }
        }
        try await waitUntil("the holder to take the lock") { lock.isHeld }

        let abandoned = Task { try await lock.withLock { await log.add("abandoned") } }
        try await waitUntil("the first waiter to queue") { lock.queuedCount == 1 }
        let patient = Task { try await lock.withLock { await log.add("patient") } }
        try await waitUntil("the second waiter to queue") { lock.queuedCount == 2 }

        abandoned.cancel()
        // It leaves the queue at once, without waiting for the holder.
        try await waitUntil("the cancelled waiter to leave the queue") { lock.queuedCount == 1 }
        open.yield()
        try await holder.value
        try await patient.value

        var cancelled = false
        do { try await abandoned.value } catch is CancellationError { cancelled = true }
        #expect(cancelled)
        #expect(await log.entries == ["patient"])
    }

    /// Between the check that a caller is not cancelled and the moment it is
    /// queued there is a window, and a cancellation that lands in it ran the
    /// handler against an empty queue. The caller then queued anyway and sat
    /// behind a holder it had given up on, until that holder finished.
    @Test func aCancellationThatLandsAsTheCallerQueuesIsNotLost() async throws {
        // The first caller, the holder, is left alone; the second is cancelled
        // at the moment it is about to queue.
        let callers = OSAllocatedUnfairLock(initialState: 0)
        let lock = AsyncFIFOLock(beforeQueueing: {
            let caller = callers.withLock { count -> Int in
                count += 1
                return count
            }
            if caller == 2 { withUnsafeCurrentTask { $0?.cancel() } }
        })
        let (gate, open) = AsyncStream<Void>.makeStream()

        let holder = Task {
            try await lock.withLock {
                for await _ in gate { break }
            }
        }
        try await waitUntil("the holder to take the lock") { lock.isHeld }

        let ran = Flag()
        let waiter = Task { try await lock.withLock { await ran.set() } }

        let outcome = try await withThrowingTaskGroup(of: String.self) { group in
            group.addTask {
                do { try await waiter.value; return "ran" } catch is CancellationError { return "cancelled" }
            }
            group.addTask {
                try await Task.sleep(for: .seconds(5))
                return "still waiting"
            }
            let first = try await group.next() ?? "none"
            // Let the holder go before the group waits for its children, or a
            // caller left queued would keep the group, and the test, hanging.
            open.yield()
            group.cancelAll()
            return first
        }
        try await holder.value

        #expect(outcome == "cancelled", "the cancelled caller was left queued behind the holder")
        #expect(await ran.value == false)
    }

    /// The same window with the lock free: the caller must not run its section
    /// after it was cancelled just because nobody was in its way.
    @Test func aCancellationThatLandsAsTheCallerQueuesDoesNotRunAFreeLockSection() async throws {
        let lock = AsyncFIFOLock(beforeQueueing: { withUnsafeCurrentTask { $0?.cancel() } })
        let ran = Flag()

        let task = Task { try await lock.withLock { await ran.set() } }
        var cancelled = false
        do { try await task.value } catch is CancellationError { cancelled = true }

        #expect(cancelled)
        #expect(await ran.value == false)
        // And the lock it never took is free for the next caller.
        #expect(!lock.isHeld)
    }

    private actor Flag {
        private(set) var value = false
        func set() { value = true }
    }

    @Test func aThrowingSectionStillReleasesTheLock() async throws {
        struct Boom: Error {}
        let lock = AsyncFIFOLock()

        await #expect(throws: Boom.self) {
            try await lock.withLock { throw Boom() }
        }

        // A lock left held would hang here; the timeout is the failure.
        let ran = try await withThrowingTaskGroup(of: Bool.self) { group in
            group.addTask { try await lock.withLock { true } }
            group.addTask {
                try await Task.sleep(for: .seconds(5))
                return false
            }
            let first = try await group.next() ?? false
            group.cancelAll()
            return first
        }
        #expect(ran)
    }
}
