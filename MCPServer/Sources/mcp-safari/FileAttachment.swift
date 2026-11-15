import Darwin
import Foundation
import UniformTypeIdentifiers

/// One caller-provided local file, opened and checked, whose bytes are read a
/// chunk at a time as they are sent to the page. Its descriptor stays open until
/// `FileAttachmentLoader.close` is called, so every chunk comes from the file the
/// checks were made on, even if the path is replaced in the meantime.
struct OpenedFile: Sendable {
    let name: String
    let mimeType: String
    let size: Int
    let descriptor: Int32
    /// When the file was last modified as of opening, so a file rewritten in place
    /// while it is being sent is caught even when its size does not change.
    let modified: FileStamp
}

struct FileStamp: Equatable, Sendable {
    let size: Int
    let seconds: Int
    let nanoseconds: Int

    init(_ info: stat) {
        size = Int(info.st_size)
        seconds = info.st_mtimespec.tv_sec
        nanoseconds = info.st_mtimespec.tv_nsec
    }
}

struct FileAttachmentError: Error, CustomStringConvertible {
    let description: String

    init(_ description: String) {
        self.description = description
    }
}

/// Opens explicit caller-provided paths and reads them out in chunks for the
/// extension bridge.
///
/// Only paths named by the caller are read. A file once travelled whole, as one
/// base64 string in one bridge message, which capped a call at 10 MB. It now
/// travels in chunks, so the limit is set by what a page can be handed rather
/// than by what one message can carry.
enum FileAttachmentLoader {
    static let maxFileCount = 10
    /// App Store Connect takes app previews of up to 500 MB, the largest file
    /// anything driving it is asked to attach, so the limit sits just above that.
    /// The page holds what it is given in memory until it uploads it.
    static let maxTotalBytes = 512 * 1024 * 1024
    /// The bytes one `file_chunk` message carries. As base64 that is 5.6 MB of
    /// text: far under the bridge's 32 MiB message limit and the 64 MB Safari
    /// allows one extension message, and small enough that the content script
    /// decodes one at a time without holding much.
    static let chunkBytes = 4 * 1024 * 1024

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
    /// fstat and every read use the same descriptor, even if the path is replaced.
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

    /// Everything that does not need the contents: the list, each file opening,
    /// not being protected, being a regular file, and the sizes fitting the limit
    /// together. Run before a call acts, and for every step of a batch before the
    /// first one does. The files are opened again when the step runs, so one that
    /// changes in between is still refused then.
    static func validate(
        paths: [String],
        protectedRoots: [String] = ProtectedPaths.defaultRoots
    ) throws {
        close(try open(paths: paths, protectedRoots: protectedRoots))
    }

    /// Opens and checks every file before any is sent, so a bad path or a total
    /// over the limit is refused before the page is asked for anything. The
    /// descriptors stay open for `chunk(of:at:)`; pass the result to `close`.
    ///
    /// `protectedRoots` are directories no file may be read from, the bridge token
    /// roots by default. See `ProtectedPaths` for why.
    static func open(
        paths: [String],
        mimeTypeOverride: String? = nil,
        protectedRoots: [String] = ProtectedPaths.defaultRoots
    ) throws -> [OpenedFile] {
        try validateCount(of: paths)

        var files: [OpenedFile] = []
        var totalBytes = 0
        do {
            for path in paths {
                let (descriptor, url) = try open(path, protectedRoots: protectedRoots)
                var info = stat()
                guard fstat(descriptor, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else {
                    Darwin.close(descriptor)
                    throw FileAttachmentError("\(url.path) is not a readable regular file")
                }
                let name = url.lastPathComponent
                files.append(OpenedFile(
                    name: name,
                    mimeType: mimeTypeOverride ?? mimeType(forName: name),
                    size: Int(info.st_size),
                    descriptor: descriptor,
                    modified: FileStamp(info)
                ))
                totalBytes += Int(info.st_size)
                guard totalBytes <= maxTotalBytes else { throw limitError }
            }
        } catch {
            close(files)
            throw error
        }
        return files
    }

    static func close(_ files: [OpenedFile]) {
        for file in files { Darwin.close(file.descriptor) }
    }

    /// The next chunk of `file` from `offset`: `chunkBytes`, or what is left of
    /// the size it had when it was opened. A file that ends sooner than that has
    /// changed since, and is refused rather than sent short.
    static func chunk(of file: OpenedFile, at offset: Int) throws -> Data {
        let length = min(chunkBytes, file.size - offset)
        guard offset >= 0, length > 0 else { return Data() }
        var data = Data(count: length)
        var filled = 0
        try data.withUnsafeMutableBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            while filled < length {
                let count = pread(file.descriptor, base + filled, length - filled, off_t(offset + filled))
                if count < 0 {
                    if errno == EINTR { continue }
                    throw FileAttachmentError("Cannot read file: \(String(cString: strerror(errno)))")
                }
                guard count > 0 else { throw changedError(file) }
                filled += count
            }
        }
        return data
    }

    /// Called once every chunk of `file` has been read. A file that grew, shrank or
    /// was rewritten while it was being sent would reach the page as a mix of two
    /// versions, so it is refused instead.
    static func confirmUnchanged(_ file: OpenedFile) throws {
        var info = stat()
        guard fstat(file.descriptor, &info) == 0, FileStamp(info) == file.modified else {
            throw changedError(file)
        }
        var extra: UInt8 = 0
        guard pread(file.descriptor, &extra, 1, off_t(file.size)) == 0 else { throw changedError(file) }
    }

    private static var limitError: FileAttachmentError {
        FileAttachmentError("Files exceed the \(maxTotalBytes / (1024 * 1024)) MB total limit for one call")
    }

    private static func changedError(_ file: OpenedFile) -> FileAttachmentError {
        FileAttachmentError("\(file.name) changed while it was being sent. Try again once nothing is writing to it.")
    }

    private static func mimeType(forName name: String) -> String {
        UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType ?? "application/octet-stream"
    }
}
