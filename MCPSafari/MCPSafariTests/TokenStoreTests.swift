//
//  TokenStoreTests.swift
//  MCPSafariTests
//
//  TokenStore.swift is compiled into this bundle directly, not reached through the
//  host app, so these run without launching anything.
//

import Foundation
import Testing

@Suite struct TokenStoreTests {
    let sandbox: URL

    init() {
        sandbox = FileManager.default.temporaryDirectory
            .appendingPathComponent("TokenStoreTests-\(UUID().uuidString)", isDirectory: true)
    }

    // Swift Testing makes a fresh suite value per test and has no teardown for
    // structs, so each test that touches disk creates and removes its sandbox here.
    private func withRoots(_ count: Int = 1, _ body: ([URL]) throws -> Void) throws {
        try FileManager.default.createDirectory(at: sandbox, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: sandbox) }
        let roots = try (0..<count).map { index -> URL in
            let root = sandbox.appendingPathComponent("root\(index)", isDirectory: true)
            try FileManager.default.createDirectory(
                at: root.appendingPathComponent("tokens"), withIntermediateDirectories: true
            )
            return root
        }
        try body(roots)
    }

    @discardableResult
    private func writeToken(_ contents: String, _ name: String, in root: URL) throws -> URL {
        let file = root.appendingPathComponent("tokens").appendingPathComponent(name)
        try contents.write(to: file, atomically: false, encoding: .utf8)
        return file
    }

    private let first = "0F0F0F0F-0000-4000-8000-000000000001"
    private let second = "0F0F0F0F-0000-4000-8000-000000000002"

    @Test func readsPortTokensAndTrimsWhitespace() throws {
        try withRoots { roots in
            try writeToken("\(first)\n", "9223", in: roots[0])
            #expect(TokenStore.load(from: roots) == ["9223": first])
        }
    }

    @Test func earlierRootWinsAndRootsMerge() throws {
        try withRoots(2) { roots in
            try writeToken(first, "9223", in: roots[0])
            try writeToken(second, "9223", in: roots[1])
            try writeToken(second, "9224", in: roots[1])
            #expect(TokenStore.load(from: roots) == ["9223": first, "9224": second])
        }
    }

    @Test func nonNumericAndNonCanonicalPortNamesAreIgnored() throws {
        try withRoots { roots in
            for name in ["abc", "+9223", "09223", "0", "00", "65536", "-1", "9223.bak", ".9223", "9223 "] {
                try writeToken(first, name, in: roots[0])
            }
            try writeToken(second, "9224", in: roots[0])
            #expect(TokenStore.load(from: roots) == ["9224": second])
        }
    }

    @Test func emptyOversizedAndNonUUIDFilesAreSkipped() throws {
        try withRoots { roots in
            try writeToken("", "9001", in: roots[0])
            try writeToken("  \n", "9002", in: roots[0])
            try writeToken("not-a-uuid", "9003", in: roots[0])
            try writeToken(first + String(repeating: "\n", count: TokenStore.maxTokenFileBytes), "9004", in: roots[0])
            try writeToken(String(repeating: "A", count: 4096), "9005", in: roots[0])
            try writeToken("\(first) trailing", "9006", in: roots[0])
            try writeToken(second, "9007", in: roots[0])
            #expect(TokenStore.load(from: roots) == ["9007": second])
        }
    }

    @Test func tokenAtTheSizeLimitIsAccepted() throws {
        try withRoots { roots in
            try writeToken(first + String(repeating: "\n", count: TokenStore.maxTokenFileBytes - first.count), "9223", in: roots[0])
            #expect(TokenStore.load(from: roots) == ["9223": first])
        }
    }

    @Test func symlinkedTokenFileIsRefused() throws {
        try withRoots { roots in
            let target = sandbox.appendingPathComponent("elsewhere")
            try first.write(to: target, atomically: false, encoding: .utf8)
            try FileManager.default.createSymbolicLink(
                at: roots[0].appendingPathComponent("tokens/9223"), withDestinationURL: target
            )
            try writeToken(second, "9224", in: roots[0])
            #expect(TokenStore.load(from: roots) == ["9224": second])
        }
    }

    @Test func symlinkedTokenDirectoryStillWorks() throws {
        try withRoots { roots in
            let real = sandbox.appendingPathComponent("dotfiles", isDirectory: true)
            try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
            try first.write(to: real.appendingPathComponent("9223"), atomically: false, encoding: .utf8)
            try FileManager.default.removeItem(at: roots[0].appendingPathComponent("tokens"))
            try FileManager.default.createSymbolicLink(
                at: roots[0].appendingPathComponent("tokens"), withDestinationURL: real
            )
            #expect(TokenStore.load(from: roots) == ["9223": first])
        }
    }

    @Test func fifoIsSkippedWithoutBlocking() throws {
        try withRoots { roots in
            #expect(mkfifo(roots[0].appendingPathComponent("tokens/9223").path, 0o600) == 0)
            try writeToken(second, "9224", in: roots[0])
            #expect(TokenStore.load(from: roots) == ["9224": second])
        }
    }

    @Test func directoryNamedLikeAPortIsSkipped() throws {
        try withRoots { roots in
            try FileManager.default.createDirectory(
                at: roots[0].appendingPathComponent("tokens/9223"), withIntermediateDirectories: true
            )
            #expect(TokenStore.load(from: roots).isEmpty)
        }
    }

    @Test func aLegacyTokenFileIsNeverRead() throws {
        try withRoots { roots in
            try first.write(to: roots[0].appendingPathComponent("token"), atomically: false, encoding: .utf8)
            #expect(TokenStore.load(from: roots).isEmpty)

            let reply = TokenStore.response(to: ["type": "getTokens"], profile: nil, roots: roots)
            #expect(reply["token"] == nil)
            #expect(reply["tokens"] == nil)
            #expect(reply["error"] as? String == "no_token_files")
        }
    }

    @Test func onlyApplicationSupportIsASearchRoot() {
        let home = URL(fileURLWithPath: "/Users/someone", isDirectory: true)
        let sandboxHome = URL(fileURLWithPath: "/Users/someone/Library/Containers/x/Data", isDirectory: true)

        let roots = TokenStore.roots(homes: [home, sandboxHome, home])

        #expect(roots.map(\.path) == [
            "/Users/someone/Library/Application Support/MCPSafari",
            "/Users/someone/Library/Containers/x/Data/Library/Application Support/MCPSafari",
        ])
        #expect(!roots.contains { $0.path.contains(".config") })
    }

    @Test func tokensReplyCarriesTheProfile() throws {
        try withRoots { roots in
            try writeToken(first, "9223", in: roots[0])
            let profile = UUID()

            let reply = TokenStore.response(to: ["type": "getTokens"], profile: profile, roots: roots)

            #expect(reply["tokens"] as? [String: String] == ["9223": first])
            #expect(reply["profile"] as? String == profile.uuidString)
            #expect(reply["error"] == nil)
        }
    }

    @Test func missingProfileKeyFallsBackToDefault() throws {
        try withRoots { roots in
            let reply = TokenStore.response(to: ["type": "getTokens"], profile: nil, roots: roots)
            #expect(reply["profile"] as? String == "default")
        }
    }

    @Test func noTokensReplyHasACodeAndNoPaths() throws {
        try withRoots { roots in
            let reply = TokenStore.response(to: ["type": "getTokens"], profile: nil, roots: roots)

            #expect(reply["error"] as? String == "no_token_files")
            #expect(!String(describing: reply).contains(sandbox.path))
        }
    }

    @Test func unknownMessagesGetAFixedErrorAndAreNotEchoed() throws {
        try withRoots { roots in
            try writeToken(first, "9223", in: roots[0])
            let messages: [Any?] = [
                nil, "getTokens", ["type": "getToken"], ["type": "other", "secret": "x"], ["type": 1], [:] as [String: Any],
            ]
            for message in messages {
                let reply = TokenStore.response(to: message, profile: UUID(), roots: roots)
                #expect(reply.count == 1)
                #expect(reply["error"] as? String == "unsupported_message")
            }
        }
    }
}
