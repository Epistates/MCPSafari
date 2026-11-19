import Foundation
import Testing
@testable import MCPSafari

/// Who a server says it is, for the name Safari's popup shows next to its
/// port: how the launch line and the environment set it, and how it reaches the
/// extension.
struct InstanceIdentityTests {

    // MARK: - The launch line

    @Test func theNameComesFromTheFlag() throws {
        #expect(
            try parseCommand(arguments: ["--name", " alpha "], environment: [:])
                == .serve(port: 8089, logLevel: .notice, name: "alpha")
        )
    }

    @Test func theEnvironmentFillsInWhatTheFlagLeavesOut() throws {
        let environment = ["MCP_SAFARI_NAME": "marketing"]
        #expect(
            try parseCommand(arguments: [], environment: environment)
                == .serve(port: 8089, logLevel: .notice, name: "marketing")
        )
        #expect(
            try parseCommand(arguments: ["--name", "flag"], environment: environment)
                == .serve(port: 8089, logLevel: .notice, name: "flag")
        )
    }

    @Test func noNameIsTheDefault() throws {
        #expect(try parseCommand(arguments: [], environment: [:]) == .serve(port: 8089, logLevel: .notice))
        #expect(try parseCommand(arguments: [], environment: ["MCP_SAFARI_NAME": ""])
            == .serve(port: 8089, logLevel: .notice))
    }

    @Test func aNameThatCannotBeUsedIsRefusedAtLaunch() {
        for arguments in [
            ["--name"],
            ["--name", ""],
            ["--name", "   "],
            ["--name", "tab\there"],
            ["--name", String(repeating: "x", count: 65)],
        ] {
            #expect(throws: CLIError.self, "\(arguments)") { try parseCommand(arguments: arguments, environment: [:]) }
        }
        #expect(throws: CLIError.self) { try parseCommand(arguments: [], environment: ["MCP_SAFARI_NAME": "a\nb"]) }
        #expect(throws: CLIError.self) { try parseCommand(arguments: [], environment: ["MCP_SAFARI_NAME": "   "]) }
    }

    @Test func aNameAtTheLimitIsKept() throws {
        let name = String(repeating: "x", count: InstanceIdentity.maxNameLength)
        #expect(try parseCommand(arguments: ["--name", name], environment: [:])
            == .serve(port: 8089, logLevel: .notice, name: name))
    }

    @Test func doctorTakesNoName() {
        #expect(throws: CLIError.self) { try parseCommand(arguments: ["doctor", "--name", "x"], environment: [:]) }
    }

    @Test func theLaunchFolderIsWhereTheServerStartedUnlessThatIsRoot() {
        #expect(InstanceIdentity.launchFolder("/") == nil)
        #expect(InstanceIdentity.launchFolder("/Users/me/work/app/") == "/Users/me/work/app")
        #expect(InstanceIdentity.launchFolder("/Users/me/work/./app/../app") == "/Users/me/work/app")
    }

    // MARK: - The handshake

    @Test func theOkFrameSaysWhoTheServerIs() async throws {
        let instance = InstanceIdentity(name: "alpha", folder: "/w/alpha")
        try await withStartedBridge(instance: instance) { bridge, port in
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()
            let reply = try await TestExtension(token: await bridge.authToken, port: port).handshake(over: task)

            #expect(reply["auth"] as? String == "ok")
            let sent = try #require(reply["instance"] as? [String: Any])
            #expect(sent["name"] as? String == "alpha")
            #expect(sent["folder"] as? String == "/w/alpha")
            // The client has not introduced itself yet, so nothing is claimed for it.
            #expect(reply["client"] == nil)
        }
    }

    @Test func aProfileThatConnectsAfterTheClientIntroducedItselfIsToldWhoItIs() async throws {
        try await withStartedBridge { bridge, port in
            await bridge.setClient(ClientIdentity(name: "claude-code", version: "2.1.0"))
            let task = webSocketTask(port: port)
            defer { task.cancel() }
            task.resume()
            let reply = try await TestExtension(token: await bridge.authToken, port: port).handshake(over: task)

            let client = try #require(reply["client"] as? [String: Any])
            #expect(client["name"] as? String == "claude-code")
            #expect(client["version"] as? String == "2.1.0")
            // A server with no name and no folder still sends the field, empty,
            // and the extension names the connection by its port.
            let sent = try #require(reply["instance"] as? [String: Any])
            #expect(sent.isEmpty)
        }
    }

    @Test func identifyCarriesTheClientAsTheExtensionReadsIt() {
        let parameters = ClientIdentity(name: "claude-code", version: nil).parameters
        let client = parameters["client"]?.objectValue
        #expect(client?["name"]?.stringValue == "claude-code")
        // No version is left out rather than sent as null.
        #expect(client?["version"] == nil)
    }

    // MARK: - status

    @Test func statusSaysWhoTheServerIs() {
        let described = SafariMCPServer.instanceStatus(
            InstanceIdentity(name: nil, folder: "/w/app"),
            client: ClientIdentity(name: "claude-code", version: nil)
        )
        #expect(described["folder"]?.stringValue == "/w/app")
        #expect(described["name"]?.value is NSNull)
        #expect(described["client"]?.objectValue?["name"]?.stringValue == "claude-code")
        #expect(described["client"]?.objectValue?["version"]?.value is NSNull)

        // Before the client has introduced itself there is nothing to report for it.
        let early = SafariMCPServer.instanceStatus(InstanceIdentity(name: "alpha"), client: nil)
        #expect(early["name"]?.stringValue == "alpha")
        #expect(early["folder"]?.value is NSNull)
        #expect(early["client"] == nil)
    }
}
