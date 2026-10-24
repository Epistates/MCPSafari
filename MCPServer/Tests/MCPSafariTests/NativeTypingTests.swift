import CoreGraphics
import MCP
import Testing
@testable import MCPSafari

struct NativeTypingTests {
    private static let qwerty: [String: SafariMCPServer.ResolvedCharacter] = [
        "a": .init(keyCode: 0, needsShift: false),
        "q": .init(keyCode: 12, needsShift: false),
    ]
    private static let azerty: [String: SafariMCPServer.ResolvedCharacter] = [
        "a": .init(keyCode: 12, needsShift: false),
        "q": .init(keyCode: 0, needsShift: false),
    ]

    private func plan(
        _ args: [String: Value],
        layout: [String: SafariMCPServer.ResolvedCharacter] = qwerty
    ) throws -> SafariMCPServer.NativeInputPlan {
        try SafariMCPServer.nativeInputPlan(args, resolveCharacter: { layout[$0] }, permission: {})
    }

    // clearFirst used to post Command plus keycode 0. That is `a` on QWERTY and
    // `q` on AZERTY, where it is Command-Q and quits Safari.
    @Test func clearFirstSelectsAllWithTheKeyTheLayoutCallsA() throws {
        #expect(try plan(["text": "x", "clearFirst": true]).selectAllKeyCode == 0)
        let french = try plan(["text": "x", "clearFirst": true], layout: Self.azerty)
        #expect(french.selectAllKeyCode == 12)
        #expect(french.selectAllKeyCode != 0)
    }

    @Test func noSelectAllKeyIsResolvedWithoutClearFirst() throws {
        #expect(try plan(["text": "x"]).selectAllKeyCode == nil)
        #expect(try plan(["text": "x", "clearFirst": false]).selectAllKeyCode == nil)
    }

    @Test func aLayoutWithoutAPlainAIsRefusedRatherThanGuessed() {
        for layout in [[:], ["a": SafariMCPServer.ResolvedCharacter(keyCode: 0, needsShift: true)]] {
            var failure: SafariMCPServer.ToolInputError?
            do {
                _ = try plan(["text": "x", "clearFirst": true], layout: layout)
            } catch let error as SafariMCPServer.ToolInputError {
                failure = error
            } catch {}
            #expect(failure?.description.hasPrefix("Native type_text cannot select the field's text first") == true)
        }
        // Without clearFirst the layout is never consulted, so typing still works.
        #expect((try? plan(["text": "x"], layout: [:])) != nil)
    }
}
