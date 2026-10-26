import Foundation
import Testing
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

    @Test func waitersAreServedInArrivalOrder() async throws {
        let lock = AsyncFIFOLock()
        let log = Log()
        let (gate, open) = AsyncStream<Void>.makeStream()

        let holder = Task {
            try await lock.withLock {
                for await _ in gate { break }
            }
        }
        try await Task.sleep(for: .milliseconds(30))

        var waiters: [Task<Void, any Error>] = []
        for call in 0..<6 {
            waiters.append(Task { try await lock.withLock { await log.add("call \(call)") } })
            // Let each one reach the queue before the next arrives.
            try await Task.sleep(for: .milliseconds(15))
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
        try await Task.sleep(for: .milliseconds(30))

        let abandoned = Task { try await lock.withLock { await log.add("abandoned") } }
        try await Task.sleep(for: .milliseconds(15))
        let patient = Task { try await lock.withLock { await log.add("patient") } }
        try await Task.sleep(for: .milliseconds(15))

        abandoned.cancel()
        open.yield()
        try await holder.value
        try await patient.value

        var cancelled = false
        do { try await abandoned.value } catch is CancellationError { cancelled = true }
        #expect(cancelled)
        #expect(await log.entries == ["patient"])
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
