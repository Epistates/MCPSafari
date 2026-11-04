import Foundation
import Testing
@testable import MCPSafari

/// Two servers share one keyboard, so their native input must not overlap. A
/// second open of the lock file conflicts with the first exactly as another
/// process's would: `flock` belongs to the open file description, not to the
/// process.
struct NativeInputLockTests {
    private actor Log {
        private(set) var entries: [String] = []
        func add(_ entry: String) { entries.append(entry) }
    }

    private func makeURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .appendingPathComponent("native-input.lock")
    }

    private func failure(_ body: () async throws -> Void) async -> ToolFailure? {
        do {
            try await body()
            return nil
        } catch let error as SafariMCPServer.NativeInputError {
            return error.failure
        } catch {
            return nil
        }
    }

    @Test func aSecondHolderWaitsForTheFirstToFinish() async throws {
        let url = makeURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let log = Log()
        let (gate, open) = AsyncStream<Void>.makeStream()
        let (entered, signalEntered) = AsyncStream<Void>.makeStream()

        let first = Task {
            try await NativeInputLock.withLock(at: url, timeout: 10) {
                await log.add("first in")
                signalEntered.yield()
                for await _ in gate { break }
                await log.add("first out")
            }
        }
        for await _ in entered { break }

        let second = Task {
            try await NativeInputLock.withLock(at: url, timeout: 10) { await log.add("second in") }
        }
        // Long enough for a second holder that was not held back to have got in.
        try await Task.sleep(for: .milliseconds(150))
        open.yield()
        try await first.value
        try await second.value

        #expect(await log.entries == ["first in", "first out", "second in"])
    }

    @Test func aHolderThatDoesNotFinishInTimeIsRefusedWithNothingSent() async throws {
        let url = makeURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let (gate, open) = AsyncStream<Void>.makeStream()
        let (entered, signalEntered) = AsyncStream<Void>.makeStream()
        let holder = Task {
            try await NativeInputLock.withLock(at: url, timeout: 10) {
                signalEntered.yield()
                for await _ in gate { break }
            }
        }
        for await _ in entered { break }

        let ran = OSAllocatedFlag()
        let refused = await failure {
            try await NativeInputLock.withLock(at: url, timeout: 0.2) { ran.set() }
        }
        open.yield()
        try await holder.value

        #expect(refused?.code == "native_input_busy")
        #expect(refused?.retryable == true)
        #expect(refused?.message.contains("nothing was sent") == true)
        #expect(!ran.value)
    }

    @Test func theLockIsFreeAgainAfterABodyThrows() async throws {
        struct Boom: Error {}
        let url = makeURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }

        await #expect(throws: Boom.self) {
            try await NativeInputLock.withLock(at: url, timeout: 1) { throw Boom() }
        }
        // A lock left held would be refused here after the timeout.
        let ran = OSAllocatedFlag()
        try await NativeInputLock.withLock(at: url, timeout: 1) { ran.set() }
        #expect(ran.value)
    }

    @Test func aCancelledWaiterStopsWaitingAtOnce() async throws {
        let url = makeURL()
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        let (gate, open) = AsyncStream<Void>.makeStream()
        let (entered, signalEntered) = AsyncStream<Void>.makeStream()
        let holder = Task {
            try await NativeInputLock.withLock(at: url, timeout: 10) {
                signalEntered.yield()
                for await _ in gate { break }
            }
        }
        for await _ in entered { break }

        let waiter = Task { try await NativeInputLock.withLock(at: url, timeout: 60) {} }
        try await Task.sleep(for: .milliseconds(60))
        waiter.cancel()
        var cancelled = false
        do { try await waiter.value } catch is CancellationError { cancelled = true }
        open.yield()
        try await holder.value

        #expect(cancelled, "a cancelled call kept waiting for the lock")
    }

    @Test func theLockFileLivesBesideTheTokens() {
        #expect(NativeInputLock.defaultURL.deletingLastPathComponent().standardizedFileURL
            == WebSocketBridge.applicationSupportDirectoryURL.standardizedFileURL)
    }
}

/// A flag a non-isolated closure can set.
private final class OSAllocatedFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var flag = false
    func set() { lock.withLock { flag = true } }
    var value: Bool { lock.withLock { flag } }
}
