import Foundation
import Network
import Testing
@testable import MCPSafari

/// A bind attempt that never settles used to hang `start()`, and with it
/// `initialize`. Provoking `.waiting` from a real listener is not something a test
/// can arrange, so these drive the states a listener would report.
struct ListenerAttemptTests {
    @Test func everyStateThatEndsAnAttemptIsAVerdict() {
        #expect(ListenerAttempt.verdict(for: .ready) == true)
        #expect(ListenerAttempt.verdict(for: .failed(.posix(.EADDRINUSE))) == false)
        #expect(ListenerAttempt.verdict(for: .cancelled) == false)
        // The one that used to fall through to `default` and wait forever.
        #expect(ListenerAttempt.verdict(for: .waiting(.posix(.EADDRINUSE))) == false)
        #expect(ListenerAttempt.verdict(for: .setup) == nil)
    }

    @Test func aWaitingListenerFailsTheAttemptInsteadOfStallingIt() async throws {
        let (verdicts, report) = AsyncStream<Bool>.makeStream()
        if let verdict = ListenerAttempt.verdict(for: .waiting(.posix(.EADDRINUSE))) {
            report.yield(verdict)
        }

        // A generous deadline: the answer has to come from the verdict, not from
        // the clock running out.
        let started = ContinuousClock.now
        let bound = await ListenerAttempt.outcome(of: verdicts, timeout: .seconds(30))
        #expect(bound == false)
        #expect(ContinuousClock.now - started < .seconds(5))
    }

    @Test func aListenerThatSaysNothingFailsAtTheDeadline() async {
        let (verdicts, report) = AsyncStream<Bool>.makeStream()
        defer { report.finish() }

        let started = ContinuousClock.now
        let bound = await ListenerAttempt.outcome(of: verdicts, timeout: .milliseconds(100))
        #expect(bound == false)
        #expect(ContinuousClock.now - started >= .milliseconds(100))
    }

    @Test func theFirstVerdictWins() async {
        let (verdicts, report) = AsyncStream<Bool>.makeStream()
        report.yield(true)
        report.yield(false)
        #expect(await ListenerAttempt.outcome(of: verdicts, timeout: .seconds(30)))
    }

    @Test func aStreamThatEndsWithoutAVerdictIsAFailure() async {
        let (verdicts, report) = AsyncStream<Bool>.makeStream()
        report.finish()
        #expect(await ListenerAttempt.outcome(of: verdicts, timeout: .seconds(30)) == false)
    }
}
