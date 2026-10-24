import CoreGraphics
import Darwin
import Foundation
import ImageIO
import MCP
import UniformTypeIdentifiers

// MARK: - Screenshot Capture

/// Server-side image work for `screenshot`: writing a capture to disk, and
/// clipping, scaling and describing it.
///
/// This lives on the server rather than in the extension because only the
/// server can reach the filesystem, and because a full-resolution frame does
/// not fit back through the client inline. All of it is pure: nothing here
/// touches the bridge or any other actor state, which is why the tests drive
/// these functions directly.
extension SafariMCPServer {
    /// Writes a capture to the caller's path. A batch of full-resolution frames
    /// does not fit through the client inline, and only the server can reach
    /// the filesystem, so the write happens here rather than in the extension.
    ///
    /// The destination is held to what a screenshot save is for. It must be named
    /// `.png`, it may replace only a regular file that already begins with the PNG
    /// signature, and it may not be inside the bridge token directories. Without
    /// that, `filePath` was a way to overwrite any file the account could write:
    /// `~/.zshrc`, a SSH key, a LaunchAgent. The write is a rename of a finished
    /// file, so a failure part way leaves the old frame in place, and a new file
    /// is created readable by its owner only, since the page may be showing
    /// anything.
    static func writeCapture(
        _ png: Data,
        to path: String,
        protectedRoots: [String] = ProtectedPaths.defaultRoots
    ) throws -> URL {
        let url = try captureDestination(path, protectedRoots: protectedRoots)
        var existing = stat()
        let mode = lstat(url.path, &existing) == 0 ? existing.st_mode & 0o7777 : 0o600
        do {
            try writeAtomically(png, to: url, mode: mode)
        } catch {
            throw FileAttachmentError("Cannot write screenshot to \(url.path) (\(error.localizedDescription))")
        }
        return url
    }

    /// Where a capture may be saved, or why not. Separate from the write so the
    /// call can be refused before the extension scrolls anything into view.
    static func captureDestination(
        _ path: String,
        protectedRoots: [String] = ProtectedPaths.defaultRoots
    ) throws -> URL {
        guard !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw FileAttachmentError("filePath must not be empty")
        }
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL
        guard url.pathExtension.lowercased() == "png" else {
            throw FileAttachmentError("filePath must end in .png, because the capture is a PNG: \(url.path)")
        }
        guard !ProtectedPaths.isProtected(url.path, roots: protectedRoots) else {
            throw FileAttachmentError("Refusing to write \(url.path): it is in a directory where MCPSafari keeps its bridge token")
        }

        var info = stat()
        guard lstat(url.path, &info) == 0 else { return url }
        switch info.st_mode & S_IFMT {
        case S_IFDIR:
            throw FileAttachmentError("filePath is a directory, not a file: \(url.path)")
        case S_IFREG:
            guard fileBeginsWithPNGSignature(url) else {
                throw FileAttachmentError("Refusing to overwrite \(url.path): it exists and is not a PNG image")
            }
        default:
            throw FileAttachmentError("Refusing to overwrite \(url.path): it exists and is not a regular file")
        }
        return url
    }

    private static let pngSignature: [UInt8] = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

    private static func fileBeginsWithPNGSignature(_ url: URL) -> Bool {
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { return false }
        defer { Darwin.close(descriptor) }
        var info = stat()
        guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return false }
        var head = [UInt8](repeating: 0, count: pngSignature.count)
        var filled = 0
        while filled < head.count {
            let count = head.withUnsafeMutableBytes {
                Darwin.read(descriptor, $0.baseAddress! + filled, $0.count - filled)
            }
            if count < 0, errno == EINTR { continue }
            guard count > 0 else { return false }
            filled += count
        }
        return head == pngSignature
    }

    /// Writes beside the destination and renames over it, so the destination is
    /// either the old file or the whole new one. The temporary file is created
    /// exclusively and without following a link, then given its final mode.
    private static func writeAtomically(_ data: Data, to url: URL, mode: mode_t) throws {
        let temporary = url.deletingLastPathComponent()
            .appendingPathComponent(".mcpsafari-\(UUID().uuidString).tmp")
        let descriptor = Darwin.open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw posixError() }
        var renamed = false
        defer {
            Darwin.close(descriptor)
            if !renamed { unlink(temporary.path) }
        }

        try data.withUnsafeBytes { buffer in
            var written = 0
            while written < buffer.count {
                let count = Darwin.write(descriptor, buffer.baseAddress! + written, buffer.count - written)
                if count < 0, errno == EINTR { continue }
                guard count > 0 else { throw posixError() }
                written += count
            }
        }
        guard fchmod(descriptor, mode) == 0, fsync(descriptor) == 0 else { throw posixError() }
        guard rename(temporary.path, url.path) == 0 else { throw posixError() }
        renamed = true
    }

    private static func posixError() -> NSError {
        NSError(domain: NSPOSIXErrorDomain, code: Int(errno), userInfo: [
            NSLocalizedDescriptionKey: String(validatingCString: strerror(errno)) ?? "error \(errno)",
        ])
    }

    struct RenderedCapture {
        let png: Data
        let width: Int
        let height: Int
        /// Device-pixel rect of the source frame that the PNG covers.
        let clip: CGRect
    }

    static func capturePadding(_ args: [String: Value]) throws -> Double {
        for key in ["uid", "selector"] where args[key] != nil && args[key]?.stringValue == nil {
            throw ToolInputError("\(key) must be a string")
        }
        guard let value = args["padding"] else { return 16 }
        guard let padding = numberValue(value), padding >= 0, padding.isFinite else {
            throw ToolInputError("padding must be a number of CSS px, 0 or more")
        }
        return padding
    }

    /// Device-pixel rect around the requested element, or nil for the whole
    /// frame. The extension measures the element in CSS px after scrolling
    /// it into view; padding and devicePixelRatio are applied here.
    static func captureClip(_ args: [String: Value], capture: [String: AnyCodable]?, padding: Double) throws -> CGRect? {
        guard args["uid"]?.stringValue != nil || args["selector"]?.stringValue != nil else { return nil }
        guard let target = capture?["target"]?.objectValue,
              let x = number(target["x"]), let y = number(target["y"]),
              let width = number(target["width"]), let height = number(target["height"]) else {
            throw ToolInputError(
                "This MCPSafari extension does not report element bounds for screenshot; update the extension or drop uid/selector"
            )
        }
        let ratio = number(capture?["devicePixelRatio"]) ?? 1
        return CGRect(x: x - padding, y: y - padding, width: width + 2 * padding, height: height + 2 * padding)
            .applying(CGAffineTransform(scaleX: ratio, y: ratio))
    }

    static func captureScale(_ args: [String: Value]) throws -> Double {
        guard let value = args["scale"] else { return 1 }
        guard let scale = numberValue(value), scale > 0, scale <= 1 else {
            throw ToolInputError("scale must be a number above 0 and at most 1")
        }
        return scale
    }

    /// Crops the frame to `clip` (device px, clamped to the frame) and scales
    /// the result. Both happen on the server because the extension only has
    /// captureVisibleTab, which returns the whole viewport at device scale.
    static func renderCapture(_ png: Data, clip: CGRect?, scale: Double) throws -> RenderedCapture {
        guard let source = CGImageSourceCreateWithData(png as CFData, nil),
              var image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            throw FileAttachmentError("Safari returned a PNG that cannot be decoded")
        }
        let frame = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        var region = frame
        if let clip {
            region = clip.integral.intersection(frame)
            guard !region.isNull, region.width >= 1, region.height >= 1 else {
                throw ToolInputError("The element lies outside the captured viewport; scroll it into view or capture without uid/selector")
            }
            guard let cropped = image.cropping(to: region) else {
                throw FileAttachmentError("Cannot crop the capture to \(region)")
            }
            image = cropped
        }
        if scale < 1 {
            let width = max(1, Int((Double(image.width) * scale).rounded()))
            let height = max(1, Int((Double(image.height) * scale).rounded()))
            guard let context = CGContext(
                data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
            ) else {
                throw FileAttachmentError("Cannot allocate a \(width)x\(height) bitmap")
            }
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            guard let scaled = context.makeImage() else {
                throw FileAttachmentError("Cannot scale the capture to \(width)x\(height)")
            }
            image = scaled
        }
        let output = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(output, UTType.png.identifier as CFString, 1, nil) else {
            throw FileAttachmentError("Cannot encode the capture as PNG")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw FileAttachmentError("Cannot encode the capture as PNG")
        }
        return RenderedCapture(png: output as Data, width: image.width, height: image.height, clip: region)
    }

    /// Tells the caller which part of the viewport the PNG covers, since the
    /// frame note above no longer holds. With the viewport size from that
    /// note, the PNG size is enough to map image px back to CSS px.
    static func renderNote(
        _ rendered: RenderedCapture, args: [String: Value], capture: [String: AnyCodable]?, scale: Double
    ) -> String {
        let ratio = number(capture?["devicePixelRatio"]) ?? 1
        var parts: [String] = []
        let target = args["uid"]?.stringValue.map { "uid \($0)" }
            ?? args["selector"]?.stringValue.map { "selector \($0)" }
        if let target {
            let clip = rendered.clip
            let css = clip.applying(CGAffineTransform(scaleX: 1 / ratio, y: 1 / ratio))
            let at = { (value: CGFloat) in String(Int(value.rounded())) }
            parts.append(
                "Cropped to \(target): the PNG covers viewport CSS px "
                + "(\(at(css.minX)), \(at(css.minY))) to (\(at(css.maxX)), \(at(css.maxY))), "
                + "\(Int(clip.width))x\(Int(clip.height)) device px."
            )
        }
        if scale < 1 {
            parts.append("Scaled by \(scale) from device px: the PNG is \(rendered.width)x\(rendered.height) px.")
        }
        return parts.joined(separator: " ")
    }

    /// Safari resolves a failed capture to an empty or non-image payload, and
    /// the extension forwards whatever it gets. Emitting that as base64 image
    /// content makes the whole tool result unparseable for the client, which
    /// reads as "this tool is broken" rather than as a recoverable failure.
    static func captureFailure(_ image: String) -> ToolFailure? {
        // Every extension version asks captureVisibleTab for PNG, so anything
        // without the signature is a failed capture rather than another format.
        let bytes = Data(base64Encoded: image)
        if let bytes, bytes.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
            return nil
        }

        // debugDescription quotes and escapes the prefix, so an HTML or data-URL
        // payload cannot break the error message across lines.
        let head = String(image.prefix(48)).debugDescription
        let payload: String
        if image.isEmpty {
            payload = "an empty payload"
        } else if bytes == nil {
            payload = "\(image.utf8.count) bytes that are not base64: \(head)"
        } else {
            payload = "\(image.utf8.count) base64 bytes with no PNG signature: \(head)"
        }
        return ToolFailure(
            code: "internal_error",
            message: "Safari returned \(payload) instead of PNG image data. "
                + "Re-enable the MCPSafari extension for this page in Safari Settings > "
                + "Extensions, or relaunch Safari, then retry.",
            retryable: false,
            recoveryAction: "inspect_error"
        )
    }

    /// The extension serializes non-string tool data, so a capture arrives as
    /// JSON text. Base64 image data never parses as JSON.
    static func decodeCapture(_ raw: String) -> [String: AnyCodable]? {
        guard raw.hasPrefix("{"), let data = raw.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode([String: AnyCodable].self, from: data)
    }

    /// Describes the captured frame: pixel space, and what state Safari withheld
    /// from a page it was not presenting when the capture was taken.
    static func captureNote(_ capture: [String: AnyCodable]) -> String? {
        var parts: [String] = []
        if let viewport = capture["viewport"]?.objectValue,
           let width = number(viewport["width"]),
           let height = number(viewport["height"]) {
            let scale = number(capture["devicePixelRatio"]) ?? 1
            parts.append(
                "Viewport \(Int(width))x\(Int(height)) CSS px, devicePixelRatio \(formatScale(scale)). "
                + "The PNG is in device pixels; click(x, y) takes CSS pixels."
            )
        }
        if capture["visible"]?.boolValue == false {
            // A hidden page is also unfocused, so the focus note would add noise.
            parts.append(
                "Page visibility: hidden. Safari does not repaint an occluded page or run its "
                + "requestAnimationFrame callbacks, so this frame may predate your last action "
                + "and any rAF-scheduled work has not run. Ask the user before bringing Safari "
                + "to the front unless they have already allowed it."
            )
        } else if capture["hasFocus"]?.boolValue == false {
            parts.append(
                "Window not focused. Safari does not match :focus or :focus-within while its "
                + "window is not key, so focus states are missing from this frame even though "
                + "document.activeElement is set. Ask the user before bringing Safari to the front "
                + "unless they have already allowed it."
            )
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }

    /// JSON numbers arrive as Int or Double depending on the value.
    private static func number(_ value: AnyCodable?) -> Double? {
        value?.doubleValue ?? value?.intValue.map(Double.init)
    }

    private static func formatScale(_ scale: Double) -> String {
        scale == scale.rounded() ? String(Int(scale)) : String(scale)
    }
}
