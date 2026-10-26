import Foundation
import Testing
@testable import MCPSafari

/// Browsers do not apply same-origin to WebSockets, so a page on any site can open
/// one against a loopback port. Safari sends `Origin: safari-web-extension://<UUID>`
/// for the extension (#121); everything with a browser behind it that is not the
/// extension is a page. These dial with the header written by hand because
/// `URLSessionWebSocketTask` sends none.
struct OriginCheckTests {
    @Test func onlyAnExtensionSchemeIsAllowed() {
        for allowed in [
            "safari-web-extension://0E4C1B2A-TEST",
            "safari-web-extension://B9F4C2A1-7E3D-4F10-9A6B-0C5D8E2F1A34",
            "Safari-Web-Extension://UPPER-CASE-SCHEME",
        ] {
            #expect(BridgeHandshake.isAllowedOrigin(allowed), "\(allowed)")
        }
        for refused in [
            "https://evil.example",
            "http://localhost:8089",
            "http://127.0.0.1:8089",
            "null",
            "",
            "file://",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
            "moz-extension://0E4C1B2A-TEST",
            "safari-web-extension:",
            "safari-web-extension:/missing-slash",
            "https://safari-web-extension://tricky",
            " safari-web-extension://leading-space",
        ] {
            #expect(!BridgeHandshake.isAllowedOrigin(refused), "\(refused)")
        }
    }

    @Test func aPageOriginIsRefusedAtTheUpgrade() async throws {
        try await withStartedBridge { bridge, port in
            for origin in ["https://evil.example", "null", "http://localhost:8089"] {
                let socket = try #require(RawSocket.dial(port: port, origin: origin))
                guard case .rejected(let status) = socket.reply() else {
                    Issue.record("\(origin) should have been refused at the upgrade")
                    continue
                }
                #expect(!status.contains("101"), "\(status)")
            }
            #expect(await bridge.status().profiles.isEmpty)
        }
    }

    @Test func anExtensionOriginIsAdmitted() async throws {
        try await withStartedBridge { bridge, port in
            let socket = try #require(RawSocket.dial(port: port, origin: "safari-web-extension://0E4C1B2A-TEST"))
            #expect(socket.reply() == .upgraded)

            // And it can finish the handshake from there.
            let reply = try await TestExtension(token: await bridge.authToken, port: port).handshake(over: socket)
            #expect(reply["auth"] as? String == "ok")
        }
    }

    @Test func aClientWithNoOriginIsAdmitted() async throws {
        // Not a browser: the Node harness, the Swift tests, anything scripted.
        try await withStartedBridge { _, port in
            let socket = try #require(RawSocket.dial(port: port))
            #expect(socket.reply() == .upgraded)
        }
    }

    /// Refused pages must not fill the handshake slots. With a long deadline, more
    /// refusals than there are slots would leave none for the extension if each held
    /// one until it timed out.
    @Test func refusedPagesDoNotUseUpTheHandshakeSlots() async throws {
        try await withStartedBridge(handshakeDeadline: .seconds(60)) { bridge, port in
            for _ in 0..<20 {
                let page = try #require(RawSocket.dial(port: port, origin: "https://evil.example"))
                if case .rejected = page.reply() {} else { Issue.record("expected the upgrade to be refused") }
            }

            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()
            let reply = try await TestExtension(token: await bridge.authToken, port: port).handshake(over: task)
            #expect(reply["auth"] as? String == "ok")
        }
    }
}
