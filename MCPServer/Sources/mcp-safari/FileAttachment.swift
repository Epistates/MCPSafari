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

    /// The checks on the list itself, before any file is touched. Shared with the
    /// pre-dispatch validation, which runs them without reading anything.
    static func validateCount(of paths: [String]) throws {
        guard !paths.isEmpty else {
            throw FileAttachmentError("Provide filePath or filePaths")
        }
        guard paths.count <= maxFileCount else {
            throw FileAttachmentError("Too many files: \(paths.count). Maximum is \(maxFileCount) per call.")
        }
    }

    /// Opens the file a caller named, refusing one that is missing, unreadable or
    /// protected. The caller owns the descriptor it gets back.
    ///
    /// Nonblocking open prevents a concurrently substituted FIFO from hanging.
    /// fstat and read use the same descriptor, even if the path is replaced.
    private static func open(_ path: String, protectedRoots: [String]) throws -> (descriptor: Int32, url: URL) {
        let trimmed = path.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { throw FileAttachmentError("File path must not be empty") }
        let url = URL(fileURLWithPath: (trimmed as NSString).expandingTildeInPath).standardizedFileURL
        let descriptor = Darwin.open(url.path, O_RDONLY | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { throw FileAttachmentError("Cannot open file: \(url.path)") }
        // Asked of the open descriptor, after resolving symlinks, so a link into
        // the token directory is refused as the file it is.
        guard !ProtectedPaths.isProtected(descriptor: descriptor, roots: protectedRoots) else {
            Darwin.close(descriptor)
            throw FileAttachmentError("Refusing to read \(url.path): it is in a directory where MCPSafari keeps its bridge token")
        }
        return (descriptor, url)
    }

    /// Everything `load` would refuse that does not need the contents: the list,
    /// each file opening, not being protected, being a regular file, and the
    /// sizes fitting the limit together. Run before a call acts, and for every
    /// step of a batch before the first one does. The files are read again when
    /// the step runs, so one that changes in between is still refused then.
    static func validate(
        paths: [String],
        protectedRoots: [String] = ProtectedPaths.defaultRoots
    ) throws {
        try validateCount(of: paths)
        var totalBytes = 0
        for path in paths {
            let (descriptor, url) = try open(path, protectedRoots: protectedRoots)
            defer { Darwin.close(descriptor) }
            var info = stat()
            guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
                throw FileAttachmentError("\(url.path) is not a readable regular file")
            }
            totalBytes += Int(info.st_size)
            guard totalBytes <= maxTotalBytes else {
                throw FileAttachmentError("Files exceed the \(maxTotalBytes / (1024 * 1024)) MB total limit for one call")
            }
        }
    }

    /// `protectedRoots` are directories no file may be read from, the bridge token
    /// roots by default. See `ProtectedPaths` for why.
    static func load(
        paths: [String],
        mimeTypeOverride: String? = nil,
        protectedRoots: [String] = ProtectedPaths.defaultRoots
    ) throws -> [FileAttachment] {
        try validateCount(of: paths)

        var attachments: [FileAttachment] = []
        var totalBytes = 0

        for path in paths {
            let (descriptor, url) = try open(path, protectedRoots: protectedRoots)
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
