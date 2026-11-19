import Foundation
import MCP
import Testing
@testable import MCPSafari

/// A page Safari isn't showing still answers most calls, but a web app on it may
/// not have drawn, so a result from one says so rather than looking stale for
/// no reason the agent can see.
struct PageVisibilityTests {
    private func response(_ json: String) throws -> BridgeResponse {
        try JSONDecoder().decode(BridgeResponse.self, from: Data(json.utf8))
    }

    @Test func theExtensionsHiddenReportIsReadAndAnOlderExtensionsSilenceIsNot() throws {
        let hidden = try response(#"{"id":"1","success":true,"data":"x","pageVisibility":"hidden"}"#)
        #expect(hidden.pageVisibility == "hidden")
        let older = try response(#"{"id":"2","success":true,"data":"x"}"#)
        #expect(older.pageVisibility == nil)
    }

    @Test func aHiddenPageIsReportedUnlessTheFailureAlreadySaysWhy() throws {
        let plain = SafariMCPServer.PageVisibilityReport()
        plain.record(try response(#"{"id":"1","success":true,"data":"x"}"#))
        #expect(!plain.sawHidden)
        plain.record(try response(#"{"id":"2","success":true,"data":"x","pageVisibility":"hidden"}"#))
        #expect(plain.sawHidden)

        // page_hidden and page_not_responding explain the hidden page in more
        // detail than the note, so the note isn't added on top.
        for code in ["page_hidden", "page_not_responding"] {
            let report = SafariMCPServer.PageVisibilityReport()
            report.record(try response(
                #"{"id":"3","success":false,"error":"hidden","errorCode":"\#(code)","pageVisibility":"hidden"}"#
            ))
            #expect(!report.sawHidden)
        }
    }

    @Test func theNoteFollowsTheTextAndTheFlagSitsBesideThePayload() {
        let result = CallTool.Result(
            content: [SafariMCPServer.textContent("page text")],
            structuredContent: .object(["page": .string("page text")])
        )
        let noted = SafariMCPServer.notingHiddenPage(result)
        #expect(noted.content.count == 2)
        guard case let .text(note, _, _) = noted.content[1] else {
            Issue.record("the note should be text")
            return
        }
        #expect(note.hasPrefix("Page visibility: hidden."))
        #expect(note.contains("select_tab"))
        #expect(noted.structuredContent == .object(["page": .string("page text"), "pageVisibility": .string("hidden")]))
        #expect(noted.isError == nil)

        let failure = SafariMCPServer.notingHiddenPage(SafariMCPServer.failureResult(
            ToolFailure(code: "target_not_found", message: "no", retryable: false, recoveryAction: "take_snapshot")
        ))
        #expect(failure.isError == true)
        #expect(failure.structuredContent?.objectValue?["pageVisibility"] == .string("hidden"))
        #expect(failure.structuredContent?.objectValue?["code"] == .string("target_not_found"))
    }
}
