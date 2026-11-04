import CoreGraphics
import Testing
@testable import MCPSafari

extension SafariMCPServer.KeyboardLayouts {
    /// A made-up keyboard that is both the layout in use and the one shortcuts
    /// read, so tests do not depend on the layouts of the machine running them.
    init(table: [String: SafariMCPServer.ResolvedCharacter]) {
        self.init(typed: table, shortcut: table)
    }

    /// Different layouts for typing and for shortcuts, as on a Russian keyboard.
    /// The reverse lookup is derived from the shortcut table, and answers with
    /// the ASCII character when a key has more than one, as the real layout
    /// would.
    init(typed: [String: SafariMCPServer.ResolvedCharacter], shortcut: [String: SafariMCPServer.ResolvedCharacter]) {
        self.init(
            typed: { typed[$0] },
            shortcut: { shortcut[$0] },
            shortcutCharacter: { code in
                shortcut.first {
                    $0.value.keyCode == code && !$0.value.needsShift && $0.key.unicodeScalars.allSatisfy(\.isASCII)
                }?.key
            }
        )
    }
}

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
        try SafariMCPServer.nativeKeyCombo(key, layouts: .init(table: Self.qwerty))
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
            _ = try SafariMCPServer.nativeKeyCombo(key, layouts: .init(table: Self.qwerty))
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
        let layouts = SafariMCPServer.KeyboardLayouts(table: azerty)
        let combo = try SafariMCPServer.nativeKeyCombo("Meta+a", layouts: layouts)

        // Not keycode 0, which is Q — and therefore Quit — on this layout.
        #expect(combo.keyCode == 12)
        #expect(combo.flags == .maskCommand)
        // Meta+q is refused outright now; q itself still lands on keycode 0.
        #expect(try SafariMCPServer.nativeKeyCombo("Control+q", layouts: layouts).keyCode == 0)
    }

    @Test func namedKeysIgnoreTheLayout() throws {
        // Physical positions, so they resolve without consulting a layout at all.
        let nothing = SafariMCPServer.KeyboardLayouts(table: [:])
        #expect(try SafariMCPServer.nativeKeyCombo("Tab", layouts: nothing).keyCode == 48)
        #expect(try SafariMCPServer.nativeKeyCombo("Escape", layouts: nothing).keyCode == 53)
        #expect(try SafariMCPServer.nativeKeyCombo("ArrowUp", layouts: nothing).keyCode == 126)
    }

    @Test func refusesCharactersTheLayoutCannotProduce() {
        // Better to fail than to post whichever key happens to sit at that code.
        var message: String?
        do {
            _ = try SafariMCPServer.nativeKeyCombo("Meta+a", layouts: .init(table: [:]))
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

    // A real key event is the user's own as far as macOS can tell, so these end
    // the session rather than acting on the page.
    @Test(arguments: [
        "Meta+q", "Command+Q", "cmd+q", "Meta+w", "Command+Shift+W", "Command+Alt+w",
        "Meta+Tab", "Meta+Shift+Tab", "Meta+Space", "Control+Space", "Control+Alt+Space",
        "Meta+Shift+q", "Meta+Alt+Shift+q", "Control+Meta+q", "Meta+Alt+Escape",
        "Meta+h", "Meta+m", "Meta+Shift+Delete", "Meta+Shift+Backspace",
    ])
    func refusesCombosThatQuitCloseHideOrLeaveSafari(_ key: String) {
        let message = errorMessage(key)
        #expect(message?.hasPrefix("Native press_key does not send \(key)") == true, "\(key) was sent")
    }

    @Test(arguments: [
        "Meta+a", "Meta+c", "Meta+v", "Meta+Shift+z", "Control+c", "Control+Tab", "Shift+Tab",
        "Tab", "Space", "Escape", "Shift+Space", "Enter", "Meta+ArrowLeft", "Meta+Alt+i",
        "Meta+Escape", "Meta+Delete", "Alt+Backspace", "q", "w", "h", "m",
    ])
    func stillSendsOrdinaryShortcutsAndBareKeys(_ key: String) throws {
        // `q`, `w`, `h` and `m` alone are text, not shortcuts.
        let letters: [String: SafariMCPServer.ResolvedCharacter] = [
            "a": .init(keyCode: 0, needsShift: false), "c": .init(keyCode: 8, needsShift: false),
            "v": .init(keyCode: 9, needsShift: false), "z": .init(keyCode: 6, needsShift: false),
            "i": .init(keyCode: 34, needsShift: false), "q": .init(keyCode: 12, needsShift: false),
            "w": .init(keyCode: 13, needsShift: false), "h": .init(keyCode: 4, needsShift: false),
            "m": .init(keyCode: 46, needsShift: false),
        ]
        let combo = try SafariMCPServer.nativeKeyCombo(key, layouts: .init(table: letters))
        #expect(combo.label == key)
    }

    // AZERTY puts q where QWERTY puts a. The guard follows the character the
    // caller named, so the remapped keycode cannot slip a quit past it.
    @Test func theGuardFollowsTheCharacterNotTheKeycode() throws {
        let azerty: [String: SafariMCPServer.ResolvedCharacter] = [
            "a": .init(keyCode: 12, needsShift: false),
            "q": .init(keyCode: 0, needsShift: false),
        ]
        let layouts = SafariMCPServer.KeyboardLayouts(table: azerty)
        #expect(try SafariMCPServer.nativeKeyCombo("Meta+a", layouts: layouts).keyCode == 12)
        #expect(throws: SafariMCPServer.ToolInputError.self) {
            try SafariMCPServer.nativeKeyCombo("Meta+q", layouts: layouts)
        }
        // And on QWERTY, where keycode 12 is q.
        #expect(throws: SafariMCPServer.ToolInputError.self) {
            try SafariMCPServer.nativeKeyCombo("Meta+q", layouts: .init(table: Self.qwerty))
        }
    }

    @Test func theRefusalListIsSmallAndNamed() {
        let names = SafariMCPServer.blockedNativeCombos.map(\.name)
        #expect(names.count == Set(names).count)
        #expect(names.count <= 24)
        #expect(names.contains("Command+Q"))
    }

    // MARK: - Command shortcuts follow the ASCII-capable layout

    // On a Russian layout the key that types `й` is the one that is Q on QWERTY,
    // and macOS reads a Command shortcut from the ASCII-capable layout, so
    // Command plus that key is Command-Q. `c` has no key of its own on the
    // Russian layout, or sits somewhere else on a transliterating one.
    private static let russianTyping: [String: SafariMCPServer.ResolvedCharacter] = [
        "й": .init(keyCode: 12, needsShift: false),
        "c": .init(keyCode: 38, needsShift: false), // where QWERTY has `j`
    ]

    @Test func commandShortcutsAreResolvedOnTheAsciiCapableLayoutNotTheOneInUse() throws {
        let layouts = SafariMCPServer.KeyboardLayouts(typed: Self.russianTyping, shortcut: Self.qwerty)

        let copy = try SafariMCPServer.nativeKeyCombo("Meta+c", layouts: layouts)
        // Keycode 8 is c on the layout macOS reads shortcuts from. 38 is J, so
        // posting it would have pressed Command-J.
        #expect(copy.keyCode == 8)
        #expect(copy.flags == .maskCommand)

        // Without Command the layout in use still decides what is typed.
        #expect(try SafariMCPServer.nativeKeyCombo("Control+c", layouts: layouts).keyCode == 38)
    }

    @Test func aKeycodeThatReadsAsQuitIsRefusedWhateverTheCallerCalledIt() {
        // A shortcut layout that maps the Cyrillic letter onto the Q key, as a
        // resolver that followed the layout in use would. The caller never said
        // `q`, but the key that is posted is Command-Q.
        var shortcut = Self.qwerty
        shortcut["й"] = .init(keyCode: 12, needsShift: false)
        let layouts = SafariMCPServer.KeyboardLayouts(typed: Self.russianTyping, shortcut: shortcut)

        #expect(errorMessage(for: "Meta+й", layouts)?.hasPrefix("Native press_key does not send Meta+й") == true)
        // The modifiers that will be held count too: Shift is added for `#`.
        var withHash = Self.qwerty
        withHash["#"] = .init(keyCode: 20, needsShift: true)
        withHash["3"] = .init(keyCode: 20, needsShift: false)
        #expect(errorMessage(for: "Meta+#", .init(table: withHash))?.hasPrefix("Native press_key does not send Meta+#") == true)
    }

    @Test func aLayoutWithNoAsciiKeyForTheLetterRefusesInsteadOfGuessing() {
        let layouts = SafariMCPServer.KeyboardLayouts(typed: Self.russianTyping, shortcut: [:])
        #expect(errorMessage(for: "Meta+c", layouts)?.hasPrefix("Native press_key cannot type c") == true)
    }

    private func errorMessage(for key: String, _ layouts: SafariMCPServer.KeyboardLayouts) -> String? {
        do {
            _ = try SafariMCPServer.nativeKeyCombo(key, layouts: layouts)
            return nil
        } catch {
            return String(describing: error)
        }
    }

    // The live ASCII-capable lookup is the one the tool actually uses.
    @Test func theLiveShortcutLayoutAgreesWithItself() {
        guard let resolved = SafariMCPServer.shortcutLayoutKeyCode(for: "c") else { return }
        #expect(SafariMCPServer.shortcutLayoutCharacter(forKeyCode: resolved.keyCode) == "c")
    }

    // MARK: - Further shortcuts that leave the page

    @Test(arguments: [
        "Control+ArrowLeft", "Control+ArrowRight", "Control+ArrowUp", "Control+ArrowDown",
        "Control+Shift+ArrowLeft", "F3", "F11", "Shift+F3",
        "Meta+Shift+3", "Meta+Shift+4", "Meta+Shift+5", "Meta+Alt+Shift+4",
        "Meta+o", "Meta+s", "Meta+p", "Meta+Shift+s", "Command+P",
    ])
    func refusesShortcutsThatSwitchSpacesCaptureTheScreenOrOpenSheets(_ key: String) {
        let message = errorMessage(key)
        #expect(message?.hasPrefix("Native press_key does not send \(key)") == true, "\(key) was sent")
    }

    @Test(arguments: [
        "ArrowLeft", "Alt+ArrowLeft", "Meta+ArrowLeft", "Shift+ArrowUp", "F4", "F12", "Meta+3", "Meta+Shift+z", "o", "s", "p",
    ])
    func stillSendsTheNeighboursOfThoseShortcuts(_ key: String) throws {
        let letters: [String: SafariMCPServer.ResolvedCharacter] = [
            "3": .init(keyCode: 20, needsShift: false), "z": .init(keyCode: 6, needsShift: false),
            "o": .init(keyCode: 31, needsShift: false), "s": .init(keyCode: 1, needsShift: false),
            "p": .init(keyCode: 35, needsShift: false),
        ]
        #expect(try SafariMCPServer.nativeKeyCombo(key, layouts: .init(table: letters)).label == key)
    }

    @Test func keepsOriginalLabel() throws {
        #expect(try combo("Meta+Shift+z").label == "Meta+Shift+z")
    }
}
