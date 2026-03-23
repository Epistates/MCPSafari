//
//  SafariWebExtensionHandler.swift
//  MCPSafari Extension
//
//  Created by Nick Paterno on 3/23/26.
//

import SafariServices
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

        // Handle token request from the extension background script
        if let dict = message as? [String: Any], dict["type"] as? String == "getToken" {
            let tokenPath = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".config/mcp-safari/token").path
            if let token = try? String(contentsOfFile: tokenPath, encoding: .utf8) {
                responseBody = ["token": token.trimmingCharacters(in: .whitespacesAndNewlines)]
            } else {
                responseBody = ["error": "Token file not found at \(tokenPath)"]
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

}
