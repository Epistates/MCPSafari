import Darwin
import Foundation
import Testing
@testable import MCPSafari

/// `screenshot`'s `filePath` used to overwrite any file the account could write.
/// A save is now limited to what a screenshot save is: a `.png`, replacing only
/// something that is already a PNG.
struct ScreenshotWriteTests {
    private let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])
    private let newer = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 9, 9])

    private func makeDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mcp-safari-write-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }

    private func refusal(_ png: Data, _ path: String, roots: [String] = []) -> String? {
        do {
            _ = try SafariMCPServer.writeCapture(png, to: path, protectedRoots: roots)
            return nil
        } catch let error as FileAttachmentError {
            return error.description
        } catch {
            return "unexpected \(error)"
        }
    }

    private func mode(_ url: URL) throws -> Int {
        let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
        return (attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1
    }

    // MARK: - Extension

    @Test func theDestinationMustBeNamedPng() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        for name in ["shot.png", "shot.PNG", "Shot.Png", "a.b.png"] {
            _ = try SafariMCPServer.writeCapture(png, to: root.appendingPathComponent(name).path, protectedRoots: [])
        }
        for name in ["shot.jpg", "shot", ".zshrc", "shot.png.sh", "png", "shot.png "] {
            let message = refusal(png, root.appendingPathComponent(name).path)
            #expect(message?.hasPrefix("filePath must end in .png") == true, "\(name) was accepted")
            #expect(!FileManager.default.fileExists(atPath: root.appendingPathComponent(name).path))
        }
    }

    @Test func tildePathsAreExpandedBeforeTheExtensionIsJudged() {
        #expect(refusal(png, "~/.zshrc")?.hasPrefix("filePath must end in .png") == true)
        #expect(refusal(png, "~/.ssh/authorized_keys")?.hasPrefix("filePath must end in .png") == true)
    }

    // MARK: - Existing targets

    @Test func anExistingFileThatIsNotAPngIsNeverOverwritten() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let notes = root.appendingPathComponent("notes.png")
        try Data("export SECRET=1\n".utf8).write(to: notes)
        #expect(refusal(png, notes.path)?.hasSuffix("it exists and is not a PNG image") == true)
        #expect(try Data(contentsOf: notes) == Data("export SECRET=1\n".utf8))

        let empty = root.appendingPathComponent("empty.png")
        try Data().write(to: empty)
        #expect(refusal(png, empty.path) != nil)

        // A signature cut short is not a signature.
        let truncated = root.appendingPathComponent("truncated.png")
        try Data([0x89, 0x50, 0x4E, 0x47]).write(to: truncated)
        #expect(refusal(png, truncated.path) != nil)
    }

    @Test func anExistingPngIsReplacedWholeAndKeepsItsMode() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let shot = root.appendingPathComponent("shot.png")
        try png.write(to: shot)
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: shot.path)

        _ = try SafariMCPServer.writeCapture(newer, to: shot.path, protectedRoots: [])

        #expect(try Data(contentsOf: shot) == newer)
        #expect(try mode(shot) == 0o644)
    }

    @Test func aSymlinkIsNotFollowedAndNotReplaced() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let target = root.appendingPathComponent("real.png")
        try png.write(to: target)
        let link = root.appendingPathComponent("link.png")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)

        #expect(refusal(newer, link.path)?.hasSuffix("it exists and is not a regular file") == true)
        #expect(try Data(contentsOf: target) == png)
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: link.path) == target.path)
    }

    @Test func aDirectoryNamedLikeAPngIsRefused() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let directory = root.appendingPathComponent("frames.png", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        #expect(refusal(png, directory.path)?.hasPrefix("filePath is a directory") == true)
    }

    // MARK: - New files

    @Test func aNewFileIsReadableByItsOwnerOnly() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let shot = root.appendingPathComponent("shot.png")
        _ = try SafariMCPServer.writeCapture(png, to: shot.path, protectedRoots: [])

        #expect(try mode(shot) == 0o600)
        #expect(try Data(contentsOf: shot) == png)
    }

    @Test func theWriteIsAtomicAndLeavesNothingBehind() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let shot = root.appendingPathComponent("shot.png")
        _ = try SafariMCPServer.writeCapture(png, to: shot.path, protectedRoots: [])
        _ = try SafariMCPServer.writeCapture(newer, to: shot.path, protectedRoots: [])

        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path) == ["shot.png"])
    }

    @Test func aFailedWriteLeavesTheOldFrameAndNoTemporaryFile() throws {
        let root = try makeDirectory()
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: root.path)
            try? FileManager.default.removeItem(at: root)
        }

        let shot = root.appendingPathComponent("shot.png")
        try png.write(to: shot)
        // No write permission on the directory: the temporary file cannot be created.
        try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: root.path)
        try #require(getuid() != 0, "root ignores directory permissions")

        #expect(refusal(newer, shot.path)?.hasPrefix("Cannot write screenshot to") == true)
        #expect(try Data(contentsOf: shot) == png)
        #expect(try FileManager.default.contentsOfDirectory(atPath: root.path) == ["shot.png"])
    }

    @Test func aMissingDirectoryStillFails() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        #expect(refusal(png, root.appendingPathComponent("missing/dir/shot.png").path)?.hasPrefix("Cannot write screenshot to") == true)
    }

    // MARK: - Token directories

    @Test func theTokenDirectoriesAreOffLimitsEvenForAPngName() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let tokenRoot = root.appendingPathComponent("MCPSafari", isDirectory: true)
        try FileManager.default.createDirectory(
            at: tokenRoot.appendingPathComponent("tokens", isDirectory: true),
            withIntermediateDirectories: true
        )
        let roots = ProtectedPaths.roots(for: [tokenRoot])

        let inside = tokenRoot.appendingPathComponent("tokens/8089.png")
        #expect(refusal(png, inside.path, roots: roots)?.hasPrefix("Refusing to write") == true)
        #expect(!FileManager.default.fileExists(atPath: inside.path))

        let link = root.appendingPathComponent("out", isDirectory: true)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: tokenRoot)
        #expect(refusal(png, link.appendingPathComponent("shot.png").path, roots: roots) != nil)

        #expect(refusal(png, root.appendingPathComponent("elsewhere.png").path, roots: roots) == nil)
    }

    @Test func theRealTokenDirectoriesAreRefusedByDefault() {
        let inside = WebSocketBridge.tokenDirectoryURL.appendingPathComponent("capture.png").path
        var refused = false
        do { _ = try SafariMCPServer.captureDestination(inside) } catch { refused = true }
        #expect(refused)
    }

    // MARK: - Before the extension is asked

    @Test func theDestinationIsCheckedBeforeAnythingIsScrolledIntoView() {
        for path in ["~/.zshrc", WebSocketBridge.tokenDirectoryURL.appendingPathComponent("x.png").path] {
            var refused = false
            do { try SafariMCPServer.preflight(tool: "screenshot", arguments: ["filePath": .string(path)]) }
            catch is SafariMCPServer.ToolInputError { refused = true } catch {}
            #expect(refused, "\(path) passed preflight")
        }
        #expect((try? SafariMCPServer.preflight(tool: "screenshot", arguments: ["filePath": 5])) == nil)
    }
}
