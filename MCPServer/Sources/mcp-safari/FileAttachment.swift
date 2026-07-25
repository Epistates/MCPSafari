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
            let (url, name, reportedSize) = try resolve(path)
            // Reject on the reported size before reading so an oversized path cannot be
            // loaded into memory first.
            guard reportedSize <= maxTotalBytes - totalBytes else {
                throw FileAttachmentError(
                    "Files exceed the \(maxTotalBytes / (1024 * 1024)) MB total limit for one call"
                )
            }

            let data: Data
            do {
                data = try Data(contentsOf: url)
            } catch {
                throw FileAttachmentError("Cannot read file: \(url.path) (\(error.localizedDescription))")
            }

            // Re-check after reading in case the file grew between the two checks.
            totalBytes += data.count
            guard totalBytes <= maxTotalBytes else {
                throw FileAttachmentError(
                    "Files exceed the \(maxTotalBytes / (1024 * 1024)) MB total limit for one call"
                )
            }

            attachments.append(
                FileAttachment(
                    name: name,
                    mimeType: mimeTypeOverride ?? mimeType(forName: name),
                    base64: data.base64EncodedString()
                )
            )
        }

        return attachments
    }

    /// Resolves a caller path to a regular file, its attachment name, and its reported size.
    ///
    /// Checks and reads follow symlinks so they describe the file that is actually read,
    /// while the attachment keeps the name the caller asked for. Only regular files are
    /// accepted: a FIFO, socket, or device path would otherwise block or stream without
    /// end once `Data(contentsOf:)` opened it.
    private static func resolve(_ path: String) throws -> (url: URL, name: String, size: Int) {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw FileAttachmentError("File path must not be empty")
        }

        let expanded = (trimmed as NSString).expandingTildeInPath
        let requested = URL(fileURLWithPath: expanded).standardizedFileURL
        let url = requested.resolvingSymlinksInPath()

        let values: URLResourceValues
        do {
            values = try url.resourceValues(forKeys: [.isRegularFileKey, .isDirectoryKey, .fileSizeKey])
        } catch {
            throw FileAttachmentError("Cannot access file: \(url.path) (\(error.localizedDescription))")
        }

        if values.isDirectory == true {
            throw FileAttachmentError("Path is a directory, not a file: \(url.path)")
        }
        guard values.isRegularFile == true else {
            throw FileAttachmentError("Path is not a regular file: \(url.path)")
        }
        guard let size = values.fileSize else {
            throw FileAttachmentError("Cannot determine file size: \(url.path)")
        }
        return (url, requested.lastPathComponent, size)
    }

    private static func mimeType(forName name: String) -> String {
        UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }
}
