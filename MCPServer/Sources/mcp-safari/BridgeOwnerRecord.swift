import Darwin
import Foundation

/// The `<port>.pid` file that says which process owns a token, and the lock that
/// says whether that process is still there.
///
/// A pid alone cannot settle that. Reading one and deleting what it guards are two
/// steps, and a server that starts in between rewrites the file and publishes a
/// token of its own, which the second step then deletes. So a live server holds an
/// exclusive `flock` on its record for as long as it runs, and the sweep that
/// removes a dead server's files does so only while holding that lock itself. The
/// kernel drops the lock when its holder dies, however it dies, so a held lock is
/// the one answer that is never out of date.
enum BridgeOwnerRecord {
    /// Writes `pid` into the record at `url` and returns a descriptor that keeps it
    /// locked. The caller closes the descriptor to release the lock.
    ///
    /// The file is opened and rewritten in place rather than replaced. Replacing
    /// it would give the path a new inode that a sweep, which opened the old one,
    /// would neither see nor lock.
    static func claim(at url: URL, pid: pid_t) throws -> Int32 {
        // A sweep that held the lock first may have unlinked the file, which leaves
        // this descriptor on a file no path leads to. Try again against the path.
        for _ in 0..<5 {
            let descriptor = open(url.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
            guard descriptor >= 0 else { throw posixError() }
            guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
                let error = posixError()
                close(descriptor)
                throw error
            }
            guard isStillAt(url, descriptor) else {
                close(descriptor)
                continue
            }
            let text = Array(String(pid).utf8)
            guard fchmod(descriptor, 0o600) == 0,
                  ftruncate(descriptor, 0) == 0,
                  pwrite(descriptor, text, text.count, 0) == text.count
            else {
                let error = posixError()
                close(descriptor)
                throw error
            }
            return descriptor
        }
        throw POSIXError(.EAGAIN)
    }

    /// Runs `body` with the pid the record at `url` names, if nothing holds its
    /// lock. A record that is locked, or missing, is left alone and `body` does
    /// not run: its owner is alive, or there is nothing to clean up.
    ///
    /// `body` runs while the lock is held, so whatever it deletes cannot belong to a
    /// server that has since claimed the record.
    static func withAbandonedRecord(at url: URL, _ body: (pid_t?) -> Void) {
        let descriptor = open(url.path, O_RDONLY | O_CLOEXEC)
        guard descriptor >= 0 else { return }
        defer { close(descriptor) }
        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0, isStillAt(url, descriptor) else { return }

        var buffer = [UInt8](repeating: 0, count: 32)
        let count = pread(descriptor, &buffer, buffer.count, 0)
        let text = count > 0 ? String(decoding: buffer.prefix(count), as: UTF8.self) : ""
        body(pid_t(text.trimmingCharacters(in: .whitespacesAndNewlines)))
    }

    private static func isStillAt(_ url: URL, _ descriptor: Int32) -> Bool {
        var held = stat()
        var named = stat()
        return fstat(descriptor, &held) == 0
            && stat(url.path, &named) == 0
            && held.st_dev == named.st_dev
            && held.st_ino == named.st_ino
    }

    private static func posixError() -> POSIXError {
        POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
    }
}
