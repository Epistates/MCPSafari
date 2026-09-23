import Darwin
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
            let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { throw FileAttachmentError("File path must not be empty") }
            let url = URL(fileURLWithPath: (trimmed as NSString).expandingTildeInPath).standardizedFileURL
            // Nonblocking open prevents a concurrently substituted FIFO from hanging.
            // fstat and read use the same descriptor, even if the path is replaced.
            let descriptor = Darwin.open(url.path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
            guard descriptor >= 0 else { throw FileAttachmentError("Cannot open file: \(url.path)") }
            let data: Data
            do {
                defer { Darwin.close(descriptor) }
                data = try read(descriptor: descriptor, budget: maxTotalBytes - totalBytes)
            }
            let name = url.lastPathComponent
            totalBytes += data.count

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

    /// The descriptor stays owned by the caller. Reads never allocate more than the
    /// remaining budget plus one detection byte, including when a file grows.
    static func read(descriptor: Int32, budget: Int) throws -> Data {
        var info = stat()
        guard fstat(descriptor, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFREG else {
            throw FileAttachmentError("Path is not a readable regular file")
        }
        let limitError = FileAttachmentError("Files exceed the \(maxTotalBytes / (1024 * 1024)) MB total limit for one call")
        guard budget >= 0, info.st_size <= budget else { throw limitError }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let count = Darwin.read(descriptor, &buffer, min(buffer.count, budget - data.count + 1))
            if count == 0 { return data }
            if count < 0 {
                if errno == EINTR { continue }
                throw FileAttachmentError("Cannot read file: \(String(cString: strerror(errno)))")
            }
            guard count <= budget - data.count else { throw limitError }
            data.append(contentsOf: buffer.prefix(count))
        }
    }

    private static func mimeType(forName name: String) -> String {
        UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }
}
