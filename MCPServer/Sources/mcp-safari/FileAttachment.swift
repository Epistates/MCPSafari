import Foundation
import UniformTypeIdentifiers

/// One caller-provided local file, staged for delivery to the page as a browser `File`.
struct FileAttachment: Equatable, Sendable {
    let name: String
    let mimeType: String
    let base64: String
}

struct FileAttachmentError: Error, CustomStringConvertible {
    let description: String

    init(_ description: String) {
        self.description = description
    }
}

/// Reads explicit caller-provided paths into base64 payloads for the extension bridge.
///
/// Only paths named by the caller are read. Limits are conservative because the whole
/// payload travels as one JSON WebSocket message to the extension.
enum FileAttachmentLoader {
    static let maxFileCount = 10
    static let maxTotalBytes = 10 * 1024 * 1024

    static func load(paths: [String], mimeTypeOverride: String? = nil) throws -> [FileAttachment] {
        guard !paths.isEmpty else {
            throw FileAttachmentError("Provide filePath or filePaths")
        }
        guard paths.count <= maxFileCount else {
            throw FileAttachmentError("Too many files: \(paths.count). Maximum is \(maxFileCount) per call.")
        }

        var attachments: [FileAttachment] = []
        var totalBytes = 0

        for path in paths {
            let url = try resolve(path)
            let data: Data
            do {
                data = try Data(contentsOf: url)
            } catch {
                throw FileAttachmentError("Cannot read file: \(url.path) (\(error.localizedDescription))")
            }

            totalBytes += data.count
            guard totalBytes <= maxTotalBytes else {
                throw FileAttachmentError(
                    "Files exceed the \(maxTotalBytes / (1024 * 1024)) MB total limit for one call"
                )
            }

            attachments.append(
                FileAttachment(
                    name: url.lastPathComponent,
                    mimeType: mimeTypeOverride ?? mimeType(for: url),
                    base64: data.base64EncodedString()
                )
            )
        }

        return attachments
    }

    private static func resolve(_ path: String) throws -> URL {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw FileAttachmentError("File path must not be empty")
        }

        let expanded = (trimmed as NSString).expandingTildeInPath
        let url = URL(fileURLWithPath: expanded).standardizedFileURL

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            throw FileAttachmentError("File not found: \(url.path)")
        }
        guard !isDirectory.boolValue else {
            throw FileAttachmentError("Path is a directory, not a file: \(url.path)")
        }
        return url
    }

    private static func mimeType(for url: URL) -> String {
        UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }
}
