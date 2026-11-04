import Darwin
import Foundation

// MARK: - Protected Paths

/// The directories the server keeps its bridge token in, and the questions a
/// tool asks before it reads or writes near them.
///
/// The token is the only thing standing between a page and the bridge, and the
/// same user account that holds it is the one the file tools run as. So a tool
/// that reads a caller-named path, or points the browser at one, has to refuse
/// these directories: `upload_file` would hand the token to a page as a file, and
/// a `file:` URL would let Safari render it back through `read_page`. The legacy
/// `~/.config` root is covered too: nothing writes there now, but a token an
/// older server left behind is still a credential.
///
/// Comparison is on resolved paths and ignores case, Unicode composition and the
/// `/System/Volumes/Data` prefix, because the default macOS volume is
/// case-insensitive and normalization insensitive and reachable through its
/// mount point as well as through firmlinks, so several spellings name one
/// file. A `~/.config` symlinked into a
/// dotfiles repository is the reason resolving matters: the files then live
/// under a path that never mentions the directory the roots are named by.
enum ProtectedPaths {
    /// Both places a token has ever been written, named here rather than taken
    /// from the bridge. The bridge may stop writing to the legacy one, but a
    /// token file left behind there is still a valid credential until its
    /// server exits and until someone deletes it, so the directory stays
    /// off limits whether or not anything is still writing to it.
    static let knownTokenRoots: [URL] = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return [
            home.appendingPathComponent("Library", isDirectory: true)
                .appendingPathComponent("Application Support", isDirectory: true)
                .appendingPathComponent("MCPSafari", isDirectory: true),
            home.appendingPathComponent(".config", isDirectory: true)
                .appendingPathComponent("mcp-safari", isDirectory: true),
        ]
    }()

    /// What is protected by default: the known roots, plus whatever the bridge
    /// currently writes to, in case that is somewhere else.
    static let defaultTokenRoots: [URL] = knownTokenRoots + [WebSocketBridge.applicationSupportDirectoryURL]

    /// The token roots, both as written and as resolved, each once. Kept in their
    /// own case so the directories can be listed; comparison folds both sides.
    static func roots(for tokenRoots: [URL] = defaultTokenRoots) -> [String] {
        var roots: [String] = []
        var seen: Set<String> = []
        for root in tokenRoots {
            for path in [root.standardizedFileURL.path, canonicalPath(root.path)]
            where seen.insert(fold(path)).inserted {
                roots.append(path)
            }
        }
        return roots
    }

    static let defaultRoots: [String] = roots()

    /// Whether `path`, resolved through symlinks, is a protected root or lies
    /// inside one.
    static func isProtected(_ path: String, roots: [String] = defaultRoots) -> Bool {
        let folded = fold(canonicalPath(path))
        return roots.contains { root in
            let root = fold(root)
            return folded == root || folded.hasPrefix(root + "/")
        }
    }

    /// Whether the file `descriptor` refers to is protected. The path comes from
    /// the descriptor, not from the string the caller supplied, so a symlink
    /// swapped in after the check cannot change what was checked. A descriptor
    /// whose path cannot be read is treated as protected.
    ///
    /// A hard link is a second name for the token file's data, and the
    /// descriptor reports only the name it was opened by, so a link made
    /// elsewhere passes the path test. A file with more than one link is
    /// therefore also compared, by device and inode, with the files inside the
    /// roots.
    static func isProtected(descriptor: Int32, roots: [String] = defaultRoots) -> Bool {
        var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
        guard fcntl(descriptor, F_GETPATH, &buffer) != -1 else { return true }
        let path = String(decoding: buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }, as: UTF8.self)
        return isProtected(path, roots: roots) || isHardLinkedIntoRoots(descriptor: descriptor, roots: roots)
    }

    private static func isHardLinkedIntoRoots(descriptor: Int32, roots: [String]) -> Bool {
        var opened = stat()
        guard fstat(descriptor, &opened) == 0 else { return true }
        guard opened.st_nlink > 1 else { return false }
        let fileManager = FileManager.default
        for root in roots {
            guard let entries = fileManager.enumerator(atPath: root) else { continue }
            for case let relative as String in entries {
                var candidate = stat()
                guard lstat(root + "/" + relative, &candidate) == 0,
                      (candidate.st_mode & S_IFMT) == S_IFREG
                else { continue }
                if candidate.st_dev == opened.st_dev, candidate.st_ino == opened.st_ino { return true }
            }
        }
        return false
    }

    /// The path with every symlink resolved. For a path that does not exist yet,
    /// the longest existing ancestor is resolved and the rest appended, which is
    /// what a file about to be created will resolve to.
    static func canonicalPath(_ path: String) -> String {
        if let resolved = realPath(path) { return resolved }
        let lexical = URL(fileURLWithPath: path).standardized.path
        var existing = lexical
        var missing: [String] = []
        while existing != "/", realPath(existing) == nil {
            missing.append((existing as NSString).lastPathComponent)
            existing = (existing as NSString).deletingLastPathComponent
        }
        guard let base = realPath(existing) else { return lexical }
        return missing.reversed().reduce(base) { $0 == "/" ? "/" + $1 : $0 + "/" + $1 }
    }

    private static func realPath(_ path: String) -> String? {
        guard let resolved = Darwin.realpath(path, nil) else { return nil }
        defer { free(resolved) }
        return String(validatingCString: resolved)
    }

    /// Where the data volume is mounted. Its directories are also reachable
    /// without this prefix, through firmlinks (`/Users`, `/Library`, `/private`),
    /// and `realpath` leaves whichever spelling it was given, so the same token
    /// file has two resolved names and a root written one way misses the other.
    private static let dataVolumePrefix = "/system/volumes/data"

    private static func fold(_ path: String) -> String {
        var folded = path.precomposedStringWithCanonicalMapping.lowercased()
        if folded == dataVolumePrefix {
            folded = "/"
        } else if folded.hasPrefix(dataVolumePrefix + "/") {
            folded.removeFirst(dataVolumePrefix.count)
        }
        while folded.count > 1, folded.hasSuffix("/") { folded.removeLast() }
        return folded
    }
}
