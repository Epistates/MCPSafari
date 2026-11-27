//
//  SafariWebExtensionHandler.swift
//  MCPSafari Extension
//
//  Created by Nick Paterno on 3/23/26.
//

import SafariServices
import Darwin
import os.log
import TokenReader

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {

    func beginRequest(with context: NSExtensionContext) {
        let request = context.inputItems.first as? NSExtensionItem
        let profile = request?.userInfo?[SFExtensionProfileKey] as? UUID
        let message = request?.userInfo?[SFExtensionMessageKey]

        let responseBody = TokenStore.response(to: message, profile: profile, roots: Self.tokenRoots())

        // A fixed word, the profile that asked and how many tokens it got. The
        // message is whatever the sender chose to put in it, and the reply carries
        // tokens, so neither belongs in a log. The profile is how one that has
        // stopped asking, and so stopped finding new servers, shows up.
        os_log(.default, "Received native message: %{public}@ from profile %{public}@, %d token(s)",
               TokenStore.isTokenRequest(message) ? "getTokens" : "unsupported",
               responseBody["profile"] as? String ?? "none",
               (responseBody["tokens"] as? [String: String])?.count ?? 0)

        let response = NSExtensionItem()
        response.userInfo = [ SFExtensionMessageKey: responseBody ]

        context.completeRequest(returningItems: [ response ], completionHandler: nil)
    }

    private static func tokenRoots() -> [URL] {
        TokenStore.roots(homes: [realHomeDirectory, FileManager.default.homeDirectoryForCurrentUser].compactMap { $0 })
    }

    private static var realHomeDirectory: URL? {
        guard let passwordEntry = getpwuid(getuid()),
              let homeDirectory = passwordEntry.pointee.pw_dir
        else { return nil }

        return URL(fileURLWithPath: String(cString: homeDirectory), isDirectory: true)
    }

}
