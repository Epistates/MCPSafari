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

    private func makeDirectory() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}
