import CoreGraphics
import Testing
@testable import MCPSafari

struct NativeKeyComboTests {
    private func combo(_ key: String) throws -> SafariMCPServer.NativeKeyCombo {
        try SafariMCPServer.nativeKeyCombo(key)
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
            _ = try SafariMCPServer.nativeKeyCombo(key)
            return nil
        } catch {
            return String(describing: error)
        }
    }

    @Test func keepsOriginalLabel() throws {
        #expect(try combo("Meta+Shift+z").label == "Meta+Shift+z")
    }
}
