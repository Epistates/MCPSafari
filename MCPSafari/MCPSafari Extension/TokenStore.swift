//
//  TokenStore.swift
//  MCPSafari Extension
//
//  The part of the native messaging handler that needs no Safari: reading the
//  bridge's token files and building the reply to the background script. It
//  imports only Foundation so the unit tests can compile this same file.
//

import Foundation

enum TokenStore {

    /// Reported when Safari supplies no `SFExtensionProfileKey`. Must match
    /// `WebSocketBridge.defaultProfileID`.
    ///
    /// This is a fallback, not the usual path. The default profile was assumed to
    /// present by sending no key at all, and a real run on Safari 27.0.1
    /// (2026-10-08) disproved that: it sent the profile's UUID like any other,
    /// and the profile came through as `p0`, selected and authenticated. So the
    /// literal `"default"` is only reached on a Safari that sends nothing, which
    /// no observed version does. Kept because a missing key still has to resolve
    /// to one stable id rather than an empty one.
    static let defaultProfileID = "default"

    /// The bridge writes a UUID and a newline, 37 bytes. Anything much past that
    /// is not a token file, and is refused before it is read.
    static let maxTokenFileBytes = 256

    /// Where the bridge writes `tokens/<port>`, relative to a home directory.
    ///
    /// This is the only root. The extension is sandboxed and its read exception
    /// is evaluated against the *resolved* path, so a `~/.config` symlinked into
    /// a dotfiles repo put the token outside the granted path and made it
    /// unreadable. `~/.config/mcp-safari` is no longer read at all.
    static let tokenRootRelativePath = "Library/Application Support/MCPSafari"

    /// The token roots for each home directory given, deduplicated, most preferred first.
    ///
    /// A sandboxed process has two homes: its container, and the real one from the
    /// password database. The bridge runs unsandboxed and writes under the real one.
    static func roots(homes: [URL]) -> [URL] {
        var roots: [URL] = []
        for home in homes {
            let root = home.appendingPathComponent(tokenRootRelativePath)
            if !roots.contains(where: { $0.standardizedFileURL.path == root.standardizedFileURL.path }) {
                roots.append(root)
            }
        }
        return roots
    }

    /// The reply to one native message from the background script.
    ///
    /// Anything but `getTokens` gets a fixed error. The handler used to echo the
    /// message back, which is Xcode's template and gives a caller nothing it
    /// did not already have. The no-token error carries a code and no paths, so
    /// the home directory never reaches a page-visible log.
    static func response(to message: Any?, profile: UUID?, roots: [URL]) -> [String: Any] {
        guard isTokenRequest(message) else { return ["error": "unsupported_message"] }

        var body: [String: Any] = [:]
        let tokens = load(from: roots)
        if tokens.isEmpty {
            body["error"] = "no_token_files"
        } else {
            body["tokens"] = tokens
        }

        // Safari runs a separate extension instance per profile, each with its own
        // background page. The bridge needs to tell them apart so they stop evicting
        // one another, and this handler is the only place the identity is available.
        // Safari omits the key for the default profile.
        body["profile"] = profile?.uuidString ?? defaultProfileID
        return body
    }

    static func isTokenRequest(_ message: Any?) -> Bool {
        (message as? [String: Any])?["type"] as? String == "getTokens"
    }

    /// Reads port tokens from every root, most preferred first.
    ///
    /// A stale token in an earlier root must not hide live ports in a later one,
    /// so ports merge across roots with the earlier root winning.
    static func load(from roots: [URL]) -> [String: String] {
        var tokens: [String: String] = [:]
        for root in roots {
            for (port, token) in readPortTokens(from: root.appendingPathComponent("tokens")) where tokens[port] == nil {
                tokens[port] = token
            }
        }
        return tokens
    }

    /// The directory itself may be a symlink, so it is listed normally. Only the
    /// files inside are held to `readToken`.
    private static func readPortTokens(from tokenDirectory: URL) -> [String: String] {
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: tokenDirectory.path) else { return [:] }

        var tokens: [String: String] = [:]
        for name in names {
            // `UInt16` alone also takes "+80" and "0080", which the bridge never
            // writes and which would alias port 80 under a second name.
            guard let port = UInt16(name), port != 0, String(port) == name,
                  let token = readToken(at: tokenDirectory.appendingPathComponent(name))
            else { continue }

            tokens[name] = token
        }
        return tokens
    }

    /// A token is a small regular file holding one UUID, and nothing else is sent.
    ///
    /// The extension forwards this to the page-facing background script, so a
    /// file that is not shaped like a token is dropped here rather than relayed.
    /// `O_NOFOLLOW` refuses a symlink in the final component, `O_NONBLOCK` keeps
    /// a FIFO from hanging the open, and checking `fstat` on the descriptor
    /// rather than the path leaves no gap to swap the file in.
    static func readToken(at file: URL) -> String? {
        let descriptor = open(file.path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC)
        guard descriptor >= 0 else { return nil }
        defer { close(descriptor) }

        var info = stat()
        guard fstat(descriptor, &info) == 0,
              info.st_mode & S_IFMT == S_IFREG,
              info.st_size > 0, info.st_size <= maxTokenFileBytes
        else { return nil }

        // One byte past the limit, so a file that grew after `fstat` is refused
        // instead of truncated into something that might still parse.
        var buffer = [UInt8](repeating: 0, count: maxTokenFileBytes + 1)
        let count = read(descriptor, &buffer, buffer.count)
        guard count > 0, count <= maxTokenFileBytes,
              let text = String(bytes: buffer[..<count], encoding: .utf8)
        else { return nil }

        let token = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return UUID(uuidString: token) == nil ? nil : token
    }
}
