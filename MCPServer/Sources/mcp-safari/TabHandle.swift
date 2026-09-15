import Foundation
import MCP

/// A profile-qualified tab handle, shaped `p<profile>t<tab>`.
///
/// Safari runs a separate, complete instance of the extension in every profile,
/// and each instance numbers its own tabs, so tab 5 names a different page in
/// each one. The handle carries the profile the way an element UID carries the
/// frame that minted it (`f0e42`): no tool takes a profile argument, the handle
/// names one. Handles are read out of `tabs_context`, never composed by hand.
struct TabHandle: Equatable, Sendable, CustomStringConvertible {
    /// Position of the profile in the bridge's connection order. Stable for the
    /// life of the server, including across that profile's own reconnects.
    let profileIndex: Int
    /// Tab id as that profile's extension instance knows it.
    let tabID: Int

    var description: String { "p\(profileIndex)t\(tabID)" }

    /// Parses the canonical form and returns nil for anything else. Whether the
    /// profile is connected is the bridge's answer, not this one's.
    static func parse(_ text: String) -> TabHandle? {
        guard text.hasPrefix("p") else { return nil }
        let body = text.dropFirst()
        guard let separator = body.firstIndex(of: "t"),
              let profileIndex = asciiDigits(body[..<separator]),
              let tabID = asciiDigits(body[body.index(after: separator)...])
        else { return nil }
        return TabHandle(profileIndex: profileIndex, tabID: tabID)
    }

    /// `Int.init` alone would accept a sign, spaces, and non-ASCII digits, none
    /// of which are handles.
    private static func asciiDigits(_ text: Substring) -> Int? {
        guard !text.isEmpty, text.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return Int(text)
    }

    /// Reads a tool's `tabId` argument. Absent means the caller named no tab,
    /// which every tool reads as the selected profile's own selected tab.
    static func resolve(_ value: Value?) throws -> TabHandle? {
        guard let value, !value.isNull else { return nil }
        guard let text = value.stringValue else {
            throw TabHandleError(
                "tabId must be a tab handle such as \"p0t5\", not a number. Call tabs_context "
                + "for current handles. Safari numbers tabs per profile, so a bare number names "
                + "a different tab in each one."
            )
        }
        guard let handle = parse(text) else {
            throw TabHandleError(
                "tabId \"\(text)\" is not a tab handle. Handles look like p0t5, meaning tab 5 of "
                + "profile 0, and come from tabs_context."
            )
        }
        return handle
    }
}

struct TabHandleError: Error, CustomStringConvertible, Equatable {
    let description: String

    init(_ description: String) {
        self.description = description
    }
}
