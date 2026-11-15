import Foundation
import Testing
@testable import MCPSafari

struct FileAttachmentTests {
    @Test func opensFilesAndInfersMimeTypeFromExtension() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let pngBytes = Data([137, 80, 78, 71])
        let png = root.appendingPathComponent("shot.png")
        try pngBytes.write(to: png)
        let unknown = root.appendingPathComponent("payload.unknown-extension")
        try Data([1, 2]).write(to: unknown)

        let files = try FileAttachmentLoader.open(paths: [png.path, unknown.path])
        defer { FileAttachmentLoader.close(files) }

        #expect(files.map(\.name) == ["shot.png", "payload.unknown-extension"])
        #expect(files.map(\.mimeType) == ["image/png", "application/octet-stream"])
        #expect(files.map(\.size) == [4, 2])
        #expect(try FileAttachmentLoader.chunk(of: files[0], at: 0) == pngBytes)
    }

    @Test func mimeTypeOverrideWins() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let file = root.appendingPathComponent("note.txt")
        try Data("hi".utf8).write(to: file)

        let files = try FileAttachmentLoader.open(paths: [file.path], mimeTypeOverride: "text/markdown")
        defer { FileAttachmentLoader.close(files) }

        #expect(files[0].mimeType == "text/markdown")
    }

    @Test func rejectsMissingPathsDirectoriesAndEmptyInput() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.open(paths: [])
        }
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.open(paths: [root.appendingPathComponent("nope.png").path])
        }
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.open(paths: [root.path])
        }
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.open(paths: ["   "])
        }
    }

    @Test func enforcesCountAndTotalSizeLimits() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let small = root.appendingPathComponent("small.bin")
        try Data([0]).write(to: small)
        let tooMany = Array(repeating: small.path, count: FileAttachmentLoader.maxFileCount + 1)
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.open(paths: tooMany)
        }

        let atLimit = try makeSparseFile(at: root.appendingPathComponent("at-limit.bin"), size: FileAttachmentLoader.maxTotalBytes)
        FileAttachmentLoader.close(try FileAttachmentLoader.open(paths: [atLimit.path]))

        let large = try makeSparseFile(at: root.appendingPathComponent("large.bin"), size: FileAttachmentLoader.maxTotalBytes + 1)
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.open(paths: [large.path])
        }
    }

    /// App Store Connect takes previews up to 500 MB, so a file that size has to
    /// fit in one call.
    @Test func theLimitFitsAnAppStorePreview() {
        #expect(FileAttachmentLoader.maxTotalBytes >= 500 * 1_000_000)
        // A chunk is sent as base64 inside one bridge message, and has to fit it.
        #expect((FileAttachmentLoader.chunkBytes + 2) / 3 * 4 < WebSocketBridge.maxMessageBytes / 2)
    }

    /// A FIFO never reaches EOF, so this hangs instead of failing if the loader ever
    /// opens a path before confirming it is a regular file.
    @Test func rejectsNonRegularFilesWithoutReadingThem() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let fifo = root.appendingPathComponent("pipe")
        #expect(mkfifo(fifo.path, 0o600) == 0)
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.open(paths: [fifo.path])
        }

        let link = root.appendingPathComponent("pipe-link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: fifo)
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.open(paths: [link.path])
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

        let files = try FileAttachmentLoader.open(paths: [link.path])
        defer { FileAttachmentLoader.close(files) }

        #expect(files[0].name == "latest.png")
        #expect(files[0].mimeType == "image/png")
    }

    /// Sparse files keep this fast: rejection has to come from the reported size, not
    /// from bytes already read.
    @Test func rejectsOversizedAndBudgetExceedingFilesByReportedSize() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let huge = try makeSparseFile(at: root.appendingPathComponent("huge.bin"), size: 4 * 1024 * 1024 * 1024)
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.open(paths: [huge.path])
        }

        // Two files that each fit but together exceed the per-call total.
        let half = FileAttachmentLoader.maxTotalBytes * 2 / 3
        let first = try makeSparseFile(at: root.appendingPathComponent("first.bin"), size: half)
        let second = try makeSparseFile(at: root.appendingPathComponent("second.bin"), size: half)
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.open(paths: [first.path, second.path])
        }
    }

    @Test func chunksCoverTheFileExactlyInOrder() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let size = FileAttachmentLoader.chunkBytes * 2 + 5
        let bytes = Data((0..<size).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ $0 >> 9) })
        let path = root.appendingPathComponent("movie.mp4")
        try bytes.write(to: path)

        let files = try FileAttachmentLoader.open(paths: [path.path])
        defer { FileAttachmentLoader.close(files) }
        #expect(files[0].mimeType == "video/mp4")

        var received = Data()
        var sizes: [Int] = []
        while received.count < files[0].size {
            let chunk = try FileAttachmentLoader.chunk(of: files[0], at: received.count)
            sizes.append(chunk.count)
            received.append(chunk)
        }
        try FileAttachmentLoader.confirmUnchanged(files[0])

        #expect(sizes == [FileAttachmentLoader.chunkBytes, FileAttachmentLoader.chunkBytes, 5])
        #expect(received == bytes)
    }

    @Test func readsTheFileItOpenedEvenAfterThePathIsReplaced() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let path = root.appendingPathComponent("file")
        try Data("original".utf8).write(to: path)

        let files = try FileAttachmentLoader.open(paths: [path.path])
        defer { FileAttachmentLoader.close(files) }
        try FileManager.default.removeItem(at: path)
        #expect(mkfifo(path.path, 0o600) == 0)

        #expect(try FileAttachmentLoader.chunk(of: files[0], at: 0) == Data("original".utf8))
        try FileAttachmentLoader.confirmUnchanged(files[0])
    }

    /// Sent short, the page would get a truncated file under the original name.
    @Test func aFileThatShrinksWhileItIsSentIsRefused() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }
        let path = root.appendingPathComponent("file.bin")
        try Data(repeating: 7, count: 1000).write(to: path)

        let files = try FileAttachmentLoader.open(paths: [path.path])
        defer { FileAttachmentLoader.close(files) }
        let writer = try FileHandle(forWritingTo: path)
        try writer.truncate(atOffset: 10)
        try writer.close()

        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.chunk(of: files[0], at: 0)
        }
    }

    /// Either would reach the page as a mix of two versions of the file.
    @Test func aFileThatGrowsOrIsRewrittenWhileItIsSentIsRefused() throws {
        let root = try makeDirectory()
        defer { try? FileManager.default.removeItem(at: root) }

        let grows = root.appendingPathComponent("grows.bin")
        try Data(repeating: 1, count: 100).write(to: grows)
        let rewritten = root.appendingPathComponent("rewritten.bin")
        try Data(repeating: 1, count: 100).write(to: rewritten)
        let files = try FileAttachmentLoader.open(paths: [grows.path, rewritten.path])
        defer { FileAttachmentLoader.close(files) }

        let appender = try FileHandle(forWritingTo: grows)
        try appender.seekToEnd()
        try appender.write(contentsOf: Data([2]))
        try appender.close()
        _ = try FileAttachmentLoader.chunk(of: files[0], at: 0)
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.confirmUnchanged(files[0])
        }

        // Same size, new contents: only the modification time gives it away.
        let writer = try FileHandle(forWritingTo: rewritten)
        try writer.write(contentsOf: Data(repeating: 9, count: 100))
        try writer.close()
        let later = Date(timeIntervalSinceNow: 5)
        try FileManager.default.setAttributes([.modificationDate: later], ofItemAtPath: rewritten.path)
        #expect(throws: FileAttachmentError.self) {
            try FileAttachmentLoader.confirmUnchanged(files[1])
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
