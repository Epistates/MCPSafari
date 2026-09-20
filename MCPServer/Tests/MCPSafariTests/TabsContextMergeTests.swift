import Foundation
import Testing
@testable import MCPSafari

/// `tabs_context` is the only place handles are minted, so if it gets a profile
/// wrong every later call in the session goes to the wrong browser window.
struct TabsContextMergeTests {

    private func outcome(
        index: Int,
        id: String,
        tabs: [[String: Any]]
    ) throws -> WebSocketBridge.ProfileOutcome {
        // background.js stringifies anything that is not already a string, so a
        // listing reaches the server as JSON text rather than as JSON.
        let encoded = try JSONSerialization.data(withJSONObject: tabs)
        return WebSocketBridge.ProfileOutcome(
            index: index,
            profileID: id,
            reply: .answered(BridgeResponse(
                id: "req",
                success: true,
                data: AnyCodable(String(decoding: encoded, as: UTF8.self)),
                error: nil,
                errorCode: nil,
                retryable: nil,
                recoveryAction: nil
            ))
        )
    }

    private func handles(_ tabs: [AnyCodable]) -> [String] {
        tabs.compactMap { $0.objectValue?["id"]?.stringValue }
    }

    @Test func namesEveryTabByTheProfileItCameFrom() throws {
        // Both profiles have a tab 5, which is the whole reason a bare number
        // cannot name a tab: Safari numbers them per extension instance.
        let merged = SafariMCPServer.mergedTabListing([
            try outcome(index: 0, id: "default", tabs: [
                ["id": 5, "url": "https://example.com", "title": "Example", "active": true],
                ["id": 9, "url": "https://example.org", "title": "Org", "active": false],
            ]),
            try outcome(index: 1, id: "WORK-UUID", tabs: [
                ["id": 5, "url": "https://work.example", "title": "Work", "active": true],
            ]),
        ])

        #expect(merged.failures.isEmpty)
        #expect(handles(merged.tabs) == ["p0t5", "p0t9", "p1t5"])
        // Everything else the extension reported survives untouched.
        #expect(merged.tabs[2].objectValue?["url"]?.stringValue == "https://work.example")
        #expect(merged.tabs[0].objectValue?["active"]?.boolValue == true)
    }

    @Test func reportsAProfileThatCouldNotAnswerInsteadOfDroppingIt() throws {
        let merged = SafariMCPServer.mergedTabListing([
            try outcome(index: 0, id: "default", tabs: [["id": 1, "url": "https://example.com"]]),
            WebSocketBridge.ProfileOutcome(
                index: 1,
                profileID: "WORK-UUID",
                reply: .unreachable("Request to Safari extension timed out after 30 seconds.")
            ),
        ])

        // The tabs that did arrive are still returned, and the gap is named, so a
        // missing tab is not mistaken for a closed one.
        #expect(handles(merged.tabs) == ["p0t1"])
        #expect(merged.failures.count == 1)
        #expect(merged.failures[0].hasPrefix("p1 (WORK-UUID): Request to Safari extension timed out"))
    }

    @Test func reportsAProfileThatAnsweredWithAnError() {
        let merged = SafariMCPServer.mergedTabListing([
            WebSocketBridge.ProfileOutcome(
                index: 0,
                profileID: "default",
                reply: .answered(BridgeResponse(
                    id: "req", success: false, data: nil, error: "extension busy",
                    errorCode: nil, retryable: nil, recoveryAction: nil
                ))
            ),
        ])

        #expect(merged.tabs.isEmpty)
        #expect(merged.failures == ["p0 (default): extension busy"])
    }

    /// A refusal with no message used to be reported as "no response", which is
    /// the one thing it is not: the profile answered, it just did not say why.
    @Test func aRefusalWithNoMessageIsNotReportedAsSilence() {
        let merged = SafariMCPServer.mergedTabListing([
            WebSocketBridge.ProfileOutcome(
                index: 0,
                profileID: "default",
                reply: .answered(BridgeResponse(
                    id: "req", success: false, data: nil, error: nil,
                    errorCode: nil, retryable: nil, recoveryAction: nil
                ))
            ),
        ])

        #expect(merged.failures == ["p0 (default): no reason given"])
    }

    @Test func survivesAListingItCannotRead() {
        let merged = SafariMCPServer.mergedTabListing([
            WebSocketBridge.ProfileOutcome(
                index: 0,
                profileID: "default",
                reply: .answered(BridgeResponse(
                    id: "req", success: true, data: AnyCodable("not json"),
                    error: nil, errorCode: nil, retryable: nil, recoveryAction: nil
                ))
            ),
        ])

        #expect(merged.tabs.isEmpty)
        #expect(merged.failures == ["p0 (default): unreadable tab listing"])
    }

    @Test func leavesATabWithNoNumericIdAlone() throws {
        // Nothing in the extension produces this, but minting a handle from a
        // missing id would invent a tab that cannot be reached.
        let merged = SafariMCPServer.mergedTabListing([
            try outcome(index: 0, id: "default", tabs: [["url": "https://example.com"]]),
        ])

        #expect(merged.failures.isEmpty)
        #expect(merged.tabs.count == 1)
        #expect(merged.tabs[0].objectValue?["id"] == nil)
    }
}
