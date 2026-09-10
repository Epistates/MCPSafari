import CoreGraphics
import Foundation
import ImageIO
import MCP
import Testing
import UniformTypeIdentifiers
@testable import MCPSafari

/// A 200x100 frame: red, with a blue bottom-right quadrant (image rows 50-99,
/// columns 100-199), so a crop's origin is checkable on both axes from one
/// pixel read.
private func twoToneFrame() throws -> Data {
    let context = try #require(CGContext(
        data: nil, width: 200, height: 100, bitsPerComponent: 8, bytesPerRow: 0,
        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ))
    context.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: 200, height: 100))
    // CGContext's origin is bottom-left, so this is the visual bottom-right.
    context.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1))
    context.fill(CGRect(x: 100, y: 0, width: 100, height: 50))
    let image = try #require(context.makeImage())
    let output = NSMutableData()
    let destination = try #require(CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil))
    CGImageDestinationAddImage(destination, image, nil)
    #expect(CGImageDestinationFinalize(destination))
    return output as Data
}

private struct Decoded {
    let width: Int
    let height: Int
    let pixels: [UInt8]

    init(_ png: Data) throws {
        let source = try #require(CGImageSourceCreateWithData(png as CFData, nil))
        let image = try #require(CGImageSourceCreateImageAtIndex(source, 0, nil))
        width = image.width
        height = image.height
        var buffer = [UInt8](repeating: 0, count: width * height * 4)
        let context = try #require(CGContext(
            data: &buffer, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        pixels = buffer
    }

    /// "red" or "blue" at an image-space pixel, top-left origin. A bitmap
    /// context stores its top row first.
    func tone(x: Int, y: Int) -> String {
        let offset = (y * width + x) * 4
        return pixels[offset] > pixels[offset + 2] ? "red" : "blue"
    }
}

struct ScreenshotRegionTests {
    @Test func cropUsesTopLeftImageCoordinates() throws {
        let bottomRight = try SafariMCPServer.renderCapture(
            twoToneFrame(), clip: CGRect(x: 150, y: 60, width: 40, height: 30), scale: 1
        )
        let decoded = try Decoded(bottomRight.png)
        #expect((decoded.width, decoded.height) == (40, 30))
        #expect(decoded.tone(x: 0, y: 0) == "blue")
        #expect(decoded.tone(x: 39, y: 29) == "blue")
        #expect(bottomRight.clip == CGRect(x: 150, y: 60, width: 40, height: 30))

        let topRight = try SafariMCPServer.renderCapture(
            twoToneFrame(), clip: CGRect(x: 150, y: 10, width: 40, height: 30), scale: 1
        )
        let topDecoded = try Decoded(topRight.png)
        #expect(topDecoded.tone(x: 0, y: 0) == "red")
        #expect(topDecoded.tone(x: 39, y: 29) == "red")
    }

    @Test func cropClampsToTheFrame() throws {
        let rendered = try SafariMCPServer.renderCapture(
            twoToneFrame(), clip: CGRect(x: -30, y: -10, width: 100, height: 200), scale: 1
        )
        #expect(rendered.clip == CGRect(x: 0, y: 0, width: 70, height: 100))
        let decoded = try Decoded(rendered.png)
        #expect(decoded.tone(x: 69, y: 50) == "red")
    }

    @Test func cropOutsideTheFrameIsAnInputError() throws {
        #expect(throws: (any Error).self) {
            try SafariMCPServer.renderCapture(
                twoToneFrame(), clip: CGRect(x: 500, y: 0, width: 10, height: 10), scale: 1
            )
        }
    }

    @Test func scaleShrinksTheWholeFrame() throws {
        let frame = try twoToneFrame()
        let rendered = try SafariMCPServer.renderCapture(frame, clip: nil, scale: 0.5)
        let decoded = try Decoded(rendered.png)
        #expect((decoded.width, decoded.height) == (100, 50))
        #expect(decoded.tone(x: 10, y: 40) == "red")
        #expect(decoded.tone(x: 90, y: 10) == "red")
        #expect(decoded.tone(x: 90, y: 40) == "blue")
        #expect(rendered.png.count < frame.count)
    }

    @Test func cropThenScaleComposes() throws {
        let rendered = try SafariMCPServer.renderCapture(
            twoToneFrame(), clip: CGRect(x: 100, y: 50, width: 100, height: 50), scale: 0.25
        )
        let decoded = try Decoded(rendered.png)
        #expect((decoded.width, decoded.height) == (25, 13))
        #expect(decoded.tone(x: 12, y: 6) == "blue")
    }

    @Test func clipAppliesPaddingAndDevicePixelRatio() throws {
        let capture: [String: AnyCodable] = [
            "devicePixelRatio": AnyCodable(2),
            "target": AnyCodable([
                "x": AnyCodable(100), "y": AnyCodable(50),
                "width": AnyCodable(40), "height": AnyCodable(20),
            ]),
        ]
        let defaultPadding = try SafariMCPServer.captureClip(["uid": .string("e1")], capture: capture, padding: 16)
        #expect(defaultPadding == CGRect(x: 168, y: 68, width: 144, height: 104))

        let noPadding = try SafariMCPServer.captureClip(["selector": .string("#row")], capture: capture, padding: 0)
        #expect(noPadding == CGRect(x: 200, y: 100, width: 80, height: 40))

        let untargeted = try SafariMCPServer.captureClip([:], capture: capture, padding: 0)
        #expect(untargeted == nil)
    }

    @Test func targetWithoutExtensionBoundsIsAnInputError() throws {
        #expect(throws: (any Error).self) {
            try SafariMCPServer.captureClip(["uid": .string("e1")], capture: ["devicePixelRatio": AnyCodable(2)], padding: 0)
        }
        #expect(throws: (any Error).self) {
            try SafariMCPServer.captureClip(["uid": .string("e1")], capture: nil, padding: 0)
        }
    }

    @Test func badPaddingAndScaleAreInputErrors() throws {
        #expect(throws: (any Error).self) { try SafariMCPServer.capturePadding(["padding": .int(-1)]) }
        #expect(throws: (any Error).self) { try SafariMCPServer.capturePadding(["padding": .string("8")]) }
        #expect(throws: (any Error).self) { try SafariMCPServer.capturePadding(["uid": .int(7)]) }
        let defaultPadding = try SafariMCPServer.capturePadding([:])
        #expect(defaultPadding == 16)
        #expect(throws: (any Error).self) { try SafariMCPServer.captureScale(["scale": .int(0)]) }
        #expect(throws: (any Error).self) { try SafariMCPServer.captureScale(["scale": .double(1.5)]) }
        #expect(throws: (any Error).self) { try SafariMCPServer.captureScale(["scale": .string("half")]) }
        let unset = try SafariMCPServer.captureScale([:])
        #expect(unset == 1)
        let half = try SafariMCPServer.captureScale(["scale": .double(0.5)])
        #expect(half == 0.5)
    }

    @Test func renderNoteMapsThePngBackToCssPixels() throws {
        let rendered = SafariMCPServer.RenderedCapture(
            png: Data(), width: 72, height: 52, clip: CGRect(x: 168, y: 68, width: 144, height: 104)
        )
        let note = SafariMCPServer.renderNote(
            rendered, args: ["selector": .string("#row")], capture: ["devicePixelRatio": AnyCodable(2)], scale: 0.5
        )
        #expect(note == """
        Cropped to selector #row: the PNG covers viewport CSS px (84, 34) to (156, 86), 144x104 device px. \
        Scaled by 0.5 from device px: the PNG is 72x52 px.
        """)

        // Fractional CSS origins round rather than truncate: device x 1 at 1.5x is CSS 0.67.
        let fractional = SafariMCPServer.renderNote(
            SafariMCPServer.RenderedCapture(png: Data(), width: 3, height: 3, clip: CGRect(x: 1, y: 1, width: 3, height: 3)),
            args: ["uid": .string("e1"), "selector": .string("#ignored")],
            capture: ["devicePixelRatio": AnyCodable(1.5)], scale: 1
        )
        #expect(fractional == "Cropped to uid e1: the PNG covers viewport CSS px (1, 1) to (3, 3), 3x3 device px.")

        // A scale that shrinks the frame to one pixel must not trap in formatting.
        let tiny = try SafariMCPServer.renderCapture(twoToneFrame(), clip: nil, scale: 1e-20)
        #expect((tiny.width, tiny.height) == (1, 1))
        #expect(SafariMCPServer.renderNote(tiny, args: [:], capture: nil, scale: 1e-20).hasPrefix("Scaled by 1e-20"))
    }
}
