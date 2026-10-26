import Foundation
import Testing
@testable import MCPSafari

/// The bridge token sits in the same account the file tools run as, so a path
/// the caller names must never reach it: not directly, not through a symlink,
/// and not through a `~/.config` that is itself a symlink.
struct ProtectedPathsTests {
    /// A made-up token root, with a token file in it, and a sibling that merely
    /// shares its name as a prefix.
    private struct Fixture {
        let base: URL
        let root: URL
        let token: URL
        let sibling: URL
        let neighbour: URL
    }

    private func makeFixture() throws -> Fixture {
        let base = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
            .resolvingSymlinksInPath()
        let root = base.appendingPathComponent("MCPSafari", isDirectory: true)
        let tokens = root.appendingPathComponent("tokens", isDirectory: true)
        try FileManager.default.createDirectory(at: tokens, withIntermediateDirectories: true)
        let token = tokens.appendingPathComponent("8089")
        try "00000000-token".write(to: token, atomically: true, encoding: .utf8)

        let sibling = base.appendingPathComponent("MCPSafari-notes", isDirectory: true)
        try FileManager.default.createDirectory(at: sibling, withIntermediateDirectories: true)
        let neighbour = sibling.appendingPathComponent("notes.txt")
        try "not a token".write(to: neighbour, atomically: true, encoding: .utf8)
        return Fixture(base: base, root: root, token: token, sibling: sibling, neighbour: neighbour)
    }

    private func refusal(_ path: String, roots: [String]) -> String? {
        do {
            _ = try FileAttachmentLoader.load(paths: [path], protectedRoots: roots)
            return nil
        } catch let error as FileAttachmentError {
            return error.description
        } catch {
            return "unexpected \(error)"
        }
    }

    // MARK: - upload_file and drop_file

    @Test func theTokenFileIsRefusedAndAFileBesideTheRootIsNot() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        let roots = ProtectedPaths.roots(for: [fixture.root])

        #expect(refusal(fixture.token.path, roots: roots)?.hasPrefix("Refusing to read") == true)
        // Same prefix as the root, different directory.
        #expect(refusal(fixture.neighbour.path, roots: roots) == nil)
        #expect(try FileAttachmentLoader.load(paths: [fixture.neighbour.path], protectedRoots: roots).count == 1)
    }

    @Test func aSymlinkIntoTheTokenDirectoryIsRefusedAsTheFileItPointsAt() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        let roots = ProtectedPaths.roots(for: [fixture.root])

        let fileLink = fixture.sibling.appendingPathComponent("innocent.txt")
        try FileManager.default.createSymbolicLink(at: fileLink, withDestinationURL: fixture.token)
        let directoryLink = fixture.sibling.appendingPathComponent("tokens-link")
        try FileManager.default.createSymbolicLink(
            at: directoryLink,
            withDestinationURL: fixture.root.appendingPathComponent("tokens")
        )

        #expect(refusal(fileLink.path, roots: roots) != nil)
        #expect(refusal(directoryLink.appendingPathComponent("8089").path, roots: roots) != nil)
        // Dot segments that walk back into the directory are the same file.
        let walked = fixture.sibling.path + "/../MCPSafari/tokens/8089"
        #expect(refusal(walked, roots: roots) != nil)
    }

    // `~/.config` is commonly a symlink into a dotfiles repository. The token then
    // lives under a path that never mentions the directory the root is named by.
    @Test func aSymlinkedRootIsProtectedUnderBothItsNames() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        let dotfiles = fixture.base.appendingPathComponent("dotfiles/mcp-safari", isDirectory: true)
        try FileManager.default.createDirectory(
            at: dotfiles.appendingPathComponent("tokens", isDirectory: true),
            withIntermediateDirectories: true
        )
        try "token".write(to: dotfiles.appendingPathComponent("tokens/8089"), atomically: true, encoding: .utf8)
        let configRoot = fixture.base.appendingPathComponent("config-mcp-safari")
        try FileManager.default.createSymbolicLink(at: configRoot, withDestinationURL: dotfiles)
        let roots = ProtectedPaths.roots(for: [configRoot])

        #expect(refusal(configRoot.appendingPathComponent("tokens/8089").path, roots: roots) != nil)
        #expect(refusal(dotfiles.appendingPathComponent("tokens/8089").path, roots: roots) != nil)
    }

    @Test func spellingTheDirectoryInADifferentCaseDoesNotGetAround() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        let roots = ProtectedPaths.roots(for: [fixture.root])

        let shouted = fixture.token.path.replacingOccurrences(of: "MCPSafari", with: "mcpsafari")
        try #require(shouted != fixture.token.path)
        // Only meaningful on a case-insensitive volume, which is the macOS default;
        // on a case-sensitive one the other spelling is simply a different path.
        if FileManager.default.fileExists(atPath: shouted) {
            #expect(refusal(shouted, roots: roots) != nil)
        }
        #expect(ProtectedPaths.isProtected(shouted, roots: roots) || !FileManager.default.fileExists(atPath: shouted))
    }

    @Test func protectionNeedsADirectoryBoundaryNotJustAPrefix() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        let roots = ProtectedPaths.roots(for: [fixture.root])

        #expect(ProtectedPaths.isProtected(fixture.root.path, roots: roots))
        #expect(ProtectedPaths.isProtected(fixture.root.path + "/", roots: roots))
        #expect(ProtectedPaths.isProtected(fixture.token.path, roots: roots))
        #expect(!ProtectedPaths.isProtected(fixture.sibling.path, roots: roots))
        #expect(!ProtectedPaths.isProtected(fixture.base.path, roots: roots))
    }

    @Test func aTokenThatDoesNotExistYetIsStillUnderTheRoot() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        let roots = ProtectedPaths.roots(for: [fixture.root])

        #expect(ProtectedPaths.isProtected(fixture.root.path + "/tokens/9999", roots: roots))
        #expect(ProtectedPaths.isProtected(fixture.root.path + "/not/created/yet/file", roots: roots))
    }

    @Test func theDefaultRootsAreTheRealTokenRoots() {
        let defaults = ProtectedPaths.defaultRoots
        let root = WebSocketBridge.applicationSupportDirectoryURL
        #expect(defaults.contains(root.standardizedFileURL.path.lowercased()))
        #expect(ProtectedPaths.isProtected(WebSocketBridge.tokenDirectoryURL.appendingPathComponent("8089").path))
    }

    // The bridge may stop writing the legacy ~/.config/mcp-safari token, but a
    // file left there is still a credential, so the protection does not follow
    // whatever the bridge currently writes to.
    @Test func bothHistoricRootsStayProtectedWhateverTheBridgeWrites() {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let appSupport = home.appendingPathComponent("Library/Application Support/MCPSafari")
        let legacy = home.appendingPathComponent(".config/mcp-safari")
        let known = ProtectedPaths.roots(for: ProtectedPaths.knownTokenRoots)

        for path in [
            appSupport.appendingPathComponent("tokens/8089").path,
            legacy.appendingPathComponent("tokens/8089").path,
            legacy.appendingPathComponent("token").path,
            legacy.path,
        ] {
            #expect(ProtectedPaths.isProtected(path, roots: known), "\(path) is not protected")
            #expect(ProtectedPaths.isProtected(path), "\(path) is not protected by default")
        }
        #expect(!ProtectedPaths.isProtected(home.appendingPathComponent(".config/other-tool/token").path, roots: known))
    }

    // MARK: - file: URLs

    @Test func fileURLsIntoTheTokenDirectoriesAreRefused() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.base) }
        let roots = ProtectedPaths.roots(for: [fixture.root])
        func accepted(_ url: String) -> Bool {
            (try? SafariMCPServer.validatedNavigationURL(url, protectedRoots: roots)) != nil
        }

        #expect(!accepted(fixture.token.absoluteString))
        #expect(!accepted("file://localhost" + fixture.token.path))
        #expect(!accepted(fixture.root.absoluteString))
        #expect(!accepted("FILE://" + fixture.token.path))
        #expect(!accepted(fixture.token.absoluteString + "?x=1#y"))
        #expect(!accepted("file://" + fixture.sibling.path + "/../MCPSafari/tokens/8089"))

        let link = fixture.sibling.appendingPathComponent("link.txt")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: fixture.token)
        #expect(!accepted(link.absoluteString))

        // Everything else under file: still opens.
        #expect(accepted(fixture.neighbour.absoluteString))
        #expect(accepted("file:///tmp/page.html"))
        #expect(accepted("https://example.com/MCPSafari/tokens/8089"))
    }

    @Test func bothNavigationToolsApplyTheFileRule() throws {
        let tokenURL = WebSocketBridge.tokenDirectoryURL.appendingPathComponent("8089").absoluteString
        for tool in ["navigate", "tabs_create"] {
            var refused = false
            do { try SafariMCPServer.preflight(tool: tool, arguments: ["url": .string(tokenURL)]) }
            catch is SafariMCPServer.ToolInputError { refused = true }
            #expect(refused, "\(tool) accepted a file: URL for the token")
        }
    }
}
