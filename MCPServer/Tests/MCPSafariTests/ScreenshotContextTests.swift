import Foundation
import Testing
@testable import MCPSafari

struct ScreenshotContextTests {
    @Test func captureNoteReportsPixelSpaceForIntegerAndFractionalScales() throws {
        let integerScale = SafariMCPServer.captureNote([
            "viewport": AnyCodable(["width": AnyCodable(1200), "height": AnyCodable(828)]),
            "devicePixelRatio": AnyCodable(2),
            "visible": AnyCodable(true),
        ])
        #expect(integerScale == """
        Viewport 1200x828 CSS px, devicePixelRatio 2. \
        The PNG is in device pixels; click(x, y) takes CSS pixels.
        """)

        let fractionalScale = SafariMCPServer.captureNote([
            "viewport": AnyCodable(["width": AnyCodable(800), "height": AnyCodable(600)]),
            "devicePixelRatio": AnyCodable(1.5),
            "visible": AnyCodable(true),
        ])
        #expect(fractionalScale?.contains("devicePixelRatio 1.5") == true)
    }

    @Test func captureNoteWarnsWhenThePageWasHidden() throws {
        let note = SafariMCPServer.captureNote([
            "viewport": AnyCodable(["width": AnyCodable(1200), "height": AnyCodable(828)]),
            "devicePixelRatio": AnyCodable(2),
            "visible": AnyCodable(false),
            "hasFocus": AnyCodable(false),
        ])
        #expect(note?.contains("Page visibility: hidden") == true)
        #expect(note?.contains("may predate your last action") == true)
        #expect(note?.contains("requestAnimationFrame") == true)
        // A hidden page is unfocused by definition; one warning is enough.
        #expect(note?.contains("Window not focused") == false)
    }

    @Test func captureNoteWarnsWhenTheWindowWasNotKey() throws {
        let note = SafariMCPServer.captureNote([
            "viewport": AnyCodable(["width": AnyCodable(1200), "height": AnyCodable(828)]),
            "devicePixelRatio": AnyCodable(2),
            "visible": AnyCodable(true),
            "hasFocus": AnyCodable(false),
        ])
        #expect(note?.contains("Window not focused") == true)
        #expect(note?.contains(":focus-within") == true)
        #expect(note?.contains("Page visibility: hidden") == false)
    }

    @Test func captureNoteStaysQuietForAVisibleFocusedPage() throws {
        let note = SafariMCPServer.captureNote([
            "viewport": AnyCodable(["width": AnyCodable(1200), "height": AnyCodable(828)]),
            "devicePixelRatio": AnyCodable(2),
            "visible": AnyCodable(true),
            "hasFocus": AnyCodable(true),
        ])
        #expect(note?.contains("Viewport 1200x828") == true)
        #expect(note?.contains("not focused") == false)
        #expect(note?.contains("hidden") == false)
    }

    @Test func captureNoteIsOmittedWhenThePageContextIsUnavailable() throws {
        #expect(SafariMCPServer.captureNote([:]) == nil)
    }

    @Test func captureDecodingSeparatesSerializedCapturesFromLegacyImages() throws {
        let capture = SafariMCPServer.decodeCapture(
            #"{"image":"AAAB","visible":false,"viewport":{"width":1200,"height":828},"devicePixelRatio":2}"#
        )
        #expect(capture?["image"]?.stringValue == "AAAB")
        #expect(SafariMCPServer.captureNote(capture ?? [:])?.contains("hidden") == true)

        // A base64 PNG from an older extension is not JSON.
        #expect(SafariMCPServer.decodeCapture("iVBORw0KGgoAAAANSUhEUg==") == nil)
    }

    @Test func writeCaptureSavesBytesToTheRequestedPath() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mcp-safari-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])
        let url = try SafariMCPServer.writeCapture(png, to: root.appendingPathComponent("shot.png").path)

        #expect(url.lastPathComponent == "shot.png")
        #expect(try Data(contentsOf: url) == png)

        // A second capture to the same path replaces the first frame.
        let next = Data([0x89, 0x50, 0x4E, 0x47, 9])
        _ = try SafariMCPServer.writeCapture(next, to: url.path)
        #expect(try Data(contentsOf: url) == next)

        // A trailing space is part of the filename, not something to strip
        // before picking the destination.
        let spaced = try SafariMCPServer.writeCapture(png, to: url.path + " ")
        #expect(spaced.lastPathComponent == "shot.png ")
        #expect(try Data(contentsOf: url) == next)
    }

    @Test func writeCaptureRejectsEmptyDirectoryAndUnwritablePaths() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("mcp-safari-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }

        let png = Data([0x89, 0x50, 0x4E, 0x47])
        #expect(throws: FileAttachmentError.self) {
            try SafariMCPServer.writeCapture(png, to: "   ")
        }
        #expect(throws: FileAttachmentError.self) {
            try SafariMCPServer.writeCapture(png, to: root.path)
        }
        #expect(throws: FileAttachmentError.self) {
            try SafariMCPServer.writeCapture(png, to: root.appendingPathComponent("missing/dir/shot.png").path)
        }
    }

    @Test func captureFailureAcceptsDecodableImageData() throws {
        #expect(SafariMCPServer.captureFailure("iVBORw0KGgoAAAANSUhEUg==") == nil)
    }

    @Test func captureFailureRejectsAnEmptyImageInsideAValidCapture() throws {
        // Path A of issue #38: the capture object decodes and `image` is a
        // non-nil empty string, so a stringValue check alone lets it through.
        let capture = SafariMCPServer.decodeCapture(
            #"{"image":"","visible":true,"viewport":{"width":1200,"height":828},"devicePixelRatio":2}"#
        )
        let failure = try #require(
            SafariMCPServer.captureFailure(capture?["image"]?.stringValue ?? "")
        )
        #expect(failure.code == "internal_error")
        #expect(failure.retryable == false)
        #expect(failure.message.contains("an empty payload"))
    }

    // Path B of issue #38 and its neighbours: a payload that is not JSON reaches
    // the legacy branch, which used to forward it verbatim as base64. Foundation
    // decodes "====" to one garbage byte, and a truncated capture decodes
    // cleanly too, so base64 validity alone is not enough.
    @Test(arguments: [
        ("data:text/html;base64,PGh0bWw+", "not base64"),
        ("<!DOCTYPE html>\n<html>\n", "not base64"),
        ("====", "no PNG signature"),
    ])
    func captureFailureRejectsPayloadsThatAreNotPNGImages(
        payload: String,
        expected: String
    ) throws {
        let failure = try #require(SafariMCPServer.captureFailure(payload))
        #expect(failure.code == "internal_error")
        #expect(failure.message.contains(expected))
        // The first bytes tell a caller which payload Safari sent, on one line.
        #expect(failure.message.contains(payload.prefix(12)))
        #expect(failure.message.contains("\n") == false)
    }
}
