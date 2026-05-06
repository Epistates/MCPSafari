//
//  SafariWebExtensionHandler.swift
//  MCPSafari Extension
//
//  Created by Nick Paterno on 3/23/26.
//

import SafariServices
import Darwin
import os.log

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem

        let profile: UUID?
        if #available(iOS 17.0, macOS 14.0, *) {
            profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        } else {
            profile = request?.userInfo?["profile"] as? UUID
        }

        let message: Any?
        if #available(iOS 15.0, macOS 11.0, *) {
            message = request?.userInfo?[SFExtensionMessageKey]
        } else {
            message = request?.userInfo?["message"]
        }

        os_log(.default, "Received message from browser.runtime.sendNativeMessage: %@ (profile: %@)", String(describing: message), profile?.uuidString ?? "none")

        var responseBody: [String: Any] = [:]

        // Handle token requests from the extension background script.
        if let dict = message as? [String: Any],
           let type = dict["type"] as? String,
           type == "getToken" || type == "getTokens" {
            let result = Self.loadTokens()

            if !result.tokens.isEmpty {
                responseBody = ["tokens": result.tokens]
            } else if let token = result.legacyToken {
                responseBody = ["token": token]
            } else {
                responseBody = ["error": "No token files found in \(result.checkedPaths.joined(separator: ", "))"]
            }
        } else {
            responseBody = ["echo": message as Any]
        }

        let response = NSExtensionItem()
        if #available(iOS 15.0, macOS 11.0, *) {
            response.userInfo = [ SFExtensionMessageKey: responseBody ]
        } else {
            response.userInfo = [ "message": responseBody ]
        }

        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }

    private struct TokenLoadResult {
        let tokens: [String: String]
        let legacyToken: String?
        let checkedPaths: [String]
    }

    private static func loadTokens() -> TokenLoadResult {
        var checkedPaths: [String] = []

        for configDirectory in tokenConfigDirectories() {
            let tokenDirectory = configDirectory.appendingPathComponent("tokens")
            checkedPaths.append(tokenDirectory.path)

            let tokens = readPortTokens(from: tokenDirectory)
            if !tokens.isEmpty {
                return TokenLoadResult(tokens: tokens, legacyToken: nil, checkedPaths: checkedPaths)
            }

            let legacyTokenPath = configDirectory.appendingPathComponent("token")
            checkedPaths.append(legacyTokenPath.path)

            if let token = readToken(at: legacyTokenPath) {
                return TokenLoadResult(tokens: [:], legacyToken: token, checkedPaths: checkedPaths)
            }
        }

        return TokenLoadResult(tokens: [:], legacyToken: nil, checkedPaths: checkedPaths)
    }

    private static func tokenConfigDirectories() -> [URL] {
        var directories: [URL] = []

        if let realHomeDirectory {
            appendUnique(
                realHomeDirectory.appendingPathComponent(".config/mcp-safari"),
                to: &directories
            )
        }

        appendUnique(
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".config/mcp-safari"),
            to: &directories
        )

        return directories
    }

    private static var realHomeDirectory: URL? {
        guard let passwordEntry = getpwuid(getuid()),
              let homeDirectory = passwordEntry.pointee.pw_dir
        else { return nil }

        return URL(fileURLWithPath: String(cString: homeDirectory), isDirectory: true)
    }

    private static func appendUnique(_ url: URL, to directories: inout [URL]) {
        let path = url.standardizedFileURL.path

        if !directories.contains(where: { $0.standardizedFileURL.path == path }) {
            directories.append(url)
        }
    }

    private static func readPortTokens(from tokenDirectory: URL) -> [String: String] {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: tokenDirectory,
            includingPropertiesForKeys: nil
        ) else { return [:] }

        var tokens: [String: String] = [:]
        for file in files {
            guard UInt16(file.lastPathComponent) != nil,
                  let token = readToken(at: file)
            else { continue }

            tokens[file.lastPathComponent] = token
        }

        return tokens
    }

    private static func readToken(at file: URL) -> String? {
        guard let token = try? String(contentsOf: file, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty
        else { return nil }

        return token
    }

}
