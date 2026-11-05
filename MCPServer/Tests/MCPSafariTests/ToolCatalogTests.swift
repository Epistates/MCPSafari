import MCP
import Testing
@testable import MCPSafari

/// The annotations are what the focus lock is decided by, so they have to be
/// honest: a tool that can change something must not call itself read-only.
struct ToolCatalogTests {
    private func properties(of tool: Tool) -> [String: Value] {
        tool.inputSchema.objectValue?["properties"]?.objectValue ?? [:]
    }

    @Test func theReadOnlyToolsAreTheOnesThatOnlyRead() {
        #expect(SafariMCPServer.readOnlyTools == ["status", "tabs_context", "snapshot", "read_page", "find", "wait"])
    }

    // read_console and read_network are readOnlyHint true until `clear` was noticed
    // to empty the buffer they read.
    @Test func noReadOnlyToolTakesAnArgumentThatClearsOrChangesAnything() {
        let mutating: Set<String> = ["clear", "bringToFront", "force", "native", "filePath", "filePaths", "text", "key"]
        for tool in SafariMCPServer.toolDefinitions where SafariMCPServer.readOnlyTools.contains(tool.name) {
            let offending = Set(properties(of: tool).keys).intersection(mutating)
            // `text` is a match filter for find and wait, not input.
            let real = offending.subtracting(["text"])
            #expect(real.isEmpty, "\(tool.name) is read-only but takes \(real.sorted())")
        }
    }

    @Test func toolsWithAClearArgumentAreNotReadOnly() {
        for name in ["read_console", "read_network"] {
            let tool = SafariMCPServer.toolDefinitions.first { $0.name == name }
            #expect(tool?.annotations.readOnlyHint == false, "\(name) clears a buffer")
            #expect(properties(of: tool!)["clear"] != nil)
        }
    }

    // `native` was missing from `click`, so a site that ignores synthetic events
    // could be read and typed into but not clicked.
    @Test func everyToolWithARealPointerOrKeyboardPathOffersNative() {
        for name in ["click", "hover", "drag", "press_key", "type_text"] {
            let tool = SafariMCPServer.toolDefinitions.first { $0.name == name }
            let native = tool.flatMap { properties(of: $0)["native"]?.objectValue }
            #expect(native?["type"]?.stringValue == "boolean", "\(name) should declare native")
        }
    }

    // It removes what cannot be put back, so it runs under the focus lock and
    // says it is destructive.
    @Test func clearCookiesIsDestructiveAndNeedsADomain() {
        let tool = SafariMCPServer.toolDefinitions.first { $0.name == "clear_cookies" }
        #expect(tool?.annotations.readOnlyHint == false)
        #expect(tool?.annotations.destructiveHint == true)
        #expect(tool?.inputSchema.objectValue?["required"] == .array([.string("domain")]))
    }

    @Test func everyToolIsDefinedOnce() {
        let names = SafariMCPServer.toolDefinitions.map(\.name)
        #expect(names.count == Set(names).count)
        #expect(SafariMCPServer.readOnlyTools.isSubset(of: Set(names)))
    }
}
