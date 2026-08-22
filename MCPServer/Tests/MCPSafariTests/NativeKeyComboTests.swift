import CoreGraphics
import Testing
@testable import MCPSafari

struct NativeKeyComboTests {
    // Stand-in for a QWERTY layout, so these tests do not depend on whatever
    // layout the machine running them happens to have selected.
    private static let qwerty: [String: SafariMCPServer.ResolvedCharacter] = [
        "a": .init(keyCode: 0, needsShift: false),
        "z": .init(keyCode: 6, needsShift: false),
        "q": .init(keyCode: 12, needsShift: false),
        "c": .init(keyCode: 8, needsShift: false),
        "r": .init(keyCode: 15, needsShift: false),
        "0": .init(keyCode: 29, needsShift: false),
        "?": .init(keyCode: 44, needsShift: true),
    ]

    private func combo(_ key: String) throws -> SafariMCPServer.NativeKeyCombo {
        try SafariMCPServer.nativeKeyCombo(key) { Self.qwerty[$0] }
    }

    @Test func mapsNamedKeys() throws {
        #expect(try combo("Enter").keyCode == 36)
        #expect(try combo("Escape").keyCode == 53)
        #expect(try combo("Tab").keyCode == 48)
        #expect(try combo("Space").keyCode == 49)
        #expect(try combo("Backspace").keyCode == 51)
        #expect(try combo("Delete").keyCode == 117)
        #expect(try combo("ArrowDown").keyCode == 125)
        #expect(try combo("ArrowUp").keyCode == 126)
        #expect(try combo("ArrowLeft").keyCode == 123)
        #expect(try combo("ArrowRight").keyCode == 124)
        #expect(try combo("Home").keyCode == 115)
        #expect(try combo("End").keyCode == 119)
        #expect(try combo("PageUp").keyCode == 116)
        #expect(try combo("PageDown").keyCode == 121)
        #expect(try combo("F5").keyCode == 96)
    }

    @Test func mapsSingleCharactersToPhysicalKeys() throws {
        #expect(try combo("a").keyCode == 0)
        #expect(try combo("z").keyCode == 6)
        #expect(try combo("0").keyCode == 29)
        #expect(try combo("A").keyCode == 0)
        #expect(try combo("A").flags == [])
    }

    @Test func parsesModifiers() throws {
        #expect(try combo("Meta+a").flags == .maskCommand)
        #expect(try combo("cmd+a").flags == .maskCommand)
        #expect(try combo("Control+c").flags == .maskControl)
        #expect(try combo("Shift+Tab").flags == .maskShift)
        #expect(try combo("Alt+ArrowLeft").flags == .maskAlternate)
        #expect(try combo("Control+Shift+r").flags == [.maskControl, .maskShift])
        #expect(try combo("Enter").flags == [])
    }

    @Test func rejectsUnknownKeysAndModifiers() {
        #expect(errorMessage("") == "press_key requires a non-empty key such as Enter, Tab, or Meta+a")
        #expect(errorMessage("F13")?.hasPrefix("Native press_key does not support F13") == true)
        #expect(errorMessage("Hyper+a") == "Unknown modifier Hyper. Use Control, Shift, Alt, or Meta.")
        #expect(errorMessage("MediaPlayPause")?.hasPrefix("Native press_key does not support MediaPlayPause") == true)
    }

    private func errorMessage(_ key: String) -> String? {
        do {
            _ = try SafariMCPServer.nativeKeyCombo(key) { Self.qwerty[$0] }
            return nil
        } catch {
            return String(describing: error)
        }
    }

    // Keycode 0 is `a` on QWERTY and `q` on AZERTY. Resolving `Meta+a` against a
    // fixed ANSI table would post Command-Q — Quit Safari — for a French user.
    @Test func characterKeysFollowTheActiveLayout() throws {
        let azerty: [String: SafariMCPServer.ResolvedCharacter] = [
            "a": .init(keyCode: 12, needsShift: false),
            "q": .init(keyCode: 0, needsShift: false),
        ]
        let combo = try SafariMCPServer.nativeKeyCombo("Meta+a") { azerty[$0] }

        // Not keycode 0, which is Q — and therefore Quit — on this layout.
        #expect(combo.keyCode == 12)
        #expect(combo.flags == .maskCommand)
        #expect(try SafariMCPServer.nativeKeyCombo("Meta+q") { azerty[$0] }.keyCode == 0)
    }

    @Test func namedKeysIgnoreTheLayout() throws {
        // Physical positions, so they resolve without consulting a layout at all.
        let noCharacters: (String) -> SafariMCPServer.ResolvedCharacter? = { _ in nil }
        #expect(try SafariMCPServer.nativeKeyCombo("Tab", resolveCharacter: noCharacters).keyCode == 48)
        #expect(try SafariMCPServer.nativeKeyCombo("Escape", resolveCharacter: noCharacters).keyCode == 53)
        #expect(try SafariMCPServer.nativeKeyCombo("ArrowUp", resolveCharacter: noCharacters).keyCode == 126)
    }

    @Test func refusesCharactersTheLayoutCannotProduce() {
        // Better to fail than to post whichever key happens to sit at that code.
        let cyrillicOnly: (String) -> SafariMCPServer.ResolvedCharacter? = { _ in nil }
        var message: String?
        do {
            _ = try SafariMCPServer.nativeKeyCombo("Meta+a", resolveCharacter: cyrillicOnly)
        } catch {
            message = String(describing: error)
        }
        #expect(message?.hasPrefix("Native press_key cannot type a") == true)
    }

    @Test func addsShiftForCharactersThatNeedIt() throws {
        let combo = try combo("?")
        #expect(combo.keyCode == 44)
        #expect(combo.flags == .maskShift)
    }

    @Test func readsTheRealKeyboardLayout() throws {
        // The live path the tool actually uses; every Mac layout can produce
        // some character from the main block.
        #expect(SafariMCPServer.currentLayoutKeyCode(for: "\u{1F600}") == nil)
        if SafariMCPServer.currentKeyboardLayoutName() != nil {
            #expect(SafariMCPServer.currentLayoutKeyCode(for: " ") != nil)
        }
    }

    // HIToolbox calls abort() when the Text Input Sources API is entered from
    // two threads at once. mcp-safari serves several clients concurrently and
    // resolves keys off the main thread, so an unserialized read takes the
    // whole server down rather than failing one call.
    @Test func readsTheLayoutFromManyThreadsWithoutAborting() async {
        await withTaskGroup(of: Bool.self) { group in
            for _ in 0..<32 {
                group.addTask { SafariMCPServer.currentLayoutKeyCode(for: " ") != nil }
                group.addTask { SafariMCPServer.currentKeyboardLayoutName() != nil }
            }
            var results: [Bool] = []
            for await resolved in group { results.append(resolved) }
            #expect(results.count == 64)
            #expect(Set(results).count == 1, "every concurrent read agrees")
        }
    }

    @Test func keepsOriginalLabel() throws {
        #expect(try combo("Meta+Shift+z").label == "Meta+Shift+z")
    }
}
