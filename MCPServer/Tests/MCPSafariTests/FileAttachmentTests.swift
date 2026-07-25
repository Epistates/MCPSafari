import Foundation
import Testing
@testable import MCPSafari

struct FileAttachmentTests {
    @Test func readsFilesAndInfersMimeTypeFromExtension() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let pngBytes = Data([137, 80, 78, 71])
        let png = root.appendingPathComponent("shot.png")
        try pngBytes.write(to: png)
        let unknown = root.appendingPathComponent("payload.unknown-extension")
        try Data([1, 2]).write(to: unknown)

        let attachments = try FileAttachmentLoader.load(paths: [png.path, unknown.path])

        #expect(attachments.count == 2)
        #expect(
            attachments[0] == FileAttachment(
                name: "shot.png",
                mimeType: "image/png",
                base64: pngBytes.base64EncodedString()
            )
        )
        #expect(attachments[1].mimeType == "application/octet-stream")
    }

    @Test func mimeTypeOverrideWins() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let file = root.appendingPathComponent("note.txt")
        try Data("hi".utf8).write(to: file)

        let attachments = try FileAttachmentLoader.load(paths: [file.path], mimeTypeOverride: "text/markdown")

        #expect(attachments[0].mimeType == "text/markdown")
    }

    @Test func rejectsMissingPathsDirectoriesAndEmptyInput() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.load(paths: [])
        }
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.load(paths: [root.appendingPathComponent("nope.png").path])
        }
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.load(paths: [root.path])
        }
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.load(paths: ["   "])
        }
    }

    @Test func enforcesCountAndTotalSizeLimits() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let small = root.appendingPathComponent("small.bin")
        try Data([0]).write(to: small)
        let tooMany = Array(repeating: small.path, count: FileAttachmentLoader.maxFileCount + 1)
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.load(paths: tooMany)
        }

        let large = root.appendingPathComponent("large.bin")
        try Data(count: FileAttachmentLoader.maxTotalBytes + 1).write(to: large)
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.load(paths: [large.path])
        }
    }

    /// A FIFO never reaches EOF, so this hangs instead of failing if the loader ever
    /// opens a path before confirming it is a regular file.
    @Test func rejectsNonRegularFilesWithoutReadingThem() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let fifo = root.appendingPathComponent("pipe")
        #expect(mkfifo(fifo.path, 0o600) == 0)
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.load(paths: [fifo.path])
        }

        let link = root.appendingPathComponent("pipe-link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: fifo)
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.load(paths: [link.path])
        }
    }

    /// The page should see the name the caller asked for, even when that path is a link.
    @Test func keepsTheRequestedNameWhenThePathIsASymlink() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let target = root.appendingPathComponent("generated-1234.png")
        try Data([137, 80, 78, 71]).write(to: target)
        let link = root.appendingPathComponent("latest.png")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)

        let attachments = try FileAttachmentLoader.load(paths: [link.path])

        #expect(attachments[0].name == "latest.png")
        #expect(attachments[0].mimeType == "image/png")
    }

    /// Sparse files keep this fast: rejection has to come from the reported size, not
    /// from bytes already loaded into memory.
    @Test func rejectsOversizedAndBudgetExceedingFilesByReportedSize() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let huge = try makeSparseFile(at: root.appendingPathComponent("huge.bin"), size: 4 * 1024 * 1024 * 1024)
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.load(paths: [huge.path])
        }

        // Two files that each fit but together exceed the per-call total.
        let half = FileAttachmentLoader.maxTotalBytes * 2 / 3
        let first = try makeSparseFile(at: root.appendingPathComponent("first.bin"), size: half)
        let second = try makeSparseFile(at: root.appendingPathComponent("second.bin"), size: half)
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.load(paths: [first.path, second.path])
        }
    }

    private func makeSparseFile(at url: URL, size: Int) throws -> URL {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.truncate(atOffset: UInt64(size))
        return url
    }

    private func makeDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}
