import Testing
@testable import MCPSafari

/// Losing Safari's focus means two different things depending on whether
/// anything was delivered, and the difference decides whether an agent is
/// invited to send the whole input a second time.
///
/// Driving this through `ensureSafariIsFrontmost` would test whichever
/// application happened to be frontmost on the machine running the suite, so
/// the decision itself is what gets exercised.
struct NativeFocusFailureTests {

    @Test func nothingSentIsACleanRefusalTheCallerCanRetry() {
        let failure = SafariMCPServer.nativeFocusFailure(eventsAlreadySent: false)

        #expect(failure.code == "native_input_focus_lost")
        #expect(failure.retryable == true)
        #expect(failure.recoveryAction == "ask_user")
        #expect(failure.message.contains("nothing was sent"))
        // The synthetic path needs no focus, and saying so saves a round trip.
        #expect(failure.message.contains("omit native"))
    }

    @Test func eventsAlreadySentIsNotRetryable() {
        let failure = SafariMCPServer.nativeFocusFailure(eventsAlreadySent: true)

        #expect(failure.code == "native_input_focus_lost")
        // The regression this guards: flattening this to `true` invites a retry
        // that sends a second keystroke stream into whatever is frontmost now,
        // which is the behaviour #94 was filed about.
        #expect(failure.retryable == false)
        #expect(failure.recoveryAction == "ask_user")
        #expect(failure.message.contains("retry sends the whole input again"))
    }

    @Test func theTwoCasesDoNotShareAMessage() {
        #expect(
            SafariMCPServer.nativeFocusFailure(eventsAlreadySent: true).message
                != SafariMCPServer.nativeFocusFailure(eventsAlreadySent: false).message
        )
    }
}
