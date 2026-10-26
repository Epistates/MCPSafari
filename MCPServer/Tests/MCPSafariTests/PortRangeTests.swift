import Darwin
import Foundation
import Logging
import Testing
@testable import MCPSafari

/// How many ports the server tries is a setting (#155). The extension needs no
/// matching one, because it dials whichever ports have a token file and only a
/// server that bound a port writes one; so what matters here is that the count the
/// user chose is the count the sweep uses, and that nonsense is refused up front.
struct PortRangeTests {
    private let tokenRoot = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)

    // MARK: - Command line

    @Test func theRangeDefaultsToTenPorts() throws {
        #expect(WebSocketBridge.defaultPortCount == 10)
        #expect(
            try parseCommand(arguments: [], environment: [:])
                == .serve(port: 8089, portCount: 10, logLevel: .notice)
        )
        #expect(
            try parseCommand(arguments: ["doctor"], environment: [:])
                == .doctor(port: 8089, portCount: 10, json: false)
        )
    }

    @Test func theRangeComesFromTheFlagOrTheEnvironment() throws {
        #expect(
            try parseCommand(arguments: ["--port-range", "3"], environment: [:])
                == .serve(port: 8089, portCount: 3, logLevel: .notice)
        )
        #expect(
            try parseCommand(arguments: ["--port", "9000", "--port-range", "64"], environment: [:])
                == .serve(port: 9000, portCount: 64, logLevel: .notice)
        )
        #expect(
            try parseCommand(arguments: [], environment: ["MCP_SAFARI_PORT_RANGE": "20"])
                == .serve(port: 8089, portCount: 20, logLevel: .notice)
        )
        // The flag wins, as it does for the log level.
        #expect(
            try parseCommand(arguments: ["--port-range", "2"], environment: ["MCP_SAFARI_PORT_RANGE": "20"])
                == .serve(port: 8089, portCount: 2, logLevel: .notice)
        )
        // An empty variable is how a client config unsets one.
        #expect(
            try parseCommand(arguments: [], environment: ["MCP_SAFARI_PORT_RANGE": " "])
                == .serve(port: 8089, portCount: 10, logLevel: .notice)
        )
        #expect(
            try parseCommand(arguments: ["doctor", "--port-range", "5", "--json"], environment: [:])
                == .doctor(port: 8089, portCount: 5, json: true)
        )
        #expect(
            try parseCommand(arguments: ["doctor"], environment: ["MCP_SAFARI_PORT_RANGE": "7"])
                == .doctor(port: 8089, portCount: 7, json: false)
        )
    }

    @Test func aRangeOutsideOneThroughSixtyFourIsRefused() {
        for value in ["0", "65", "1000", "-1", "ten", "2.5", "70000"] {
            #expect(throws: CLIError.self, "--port-range \(value)") {
                try parseCommand(arguments: ["--port-range", value], environment: [:])
            }
            #expect(throws: CLIError.self, "MCP_SAFARI_PORT_RANGE=\(value)") {
                try parseCommand(arguments: [], environment: ["MCP_SAFARI_PORT_RANGE": value])
            }
        }
        #expect(throws: CLIError.self) {
            try parseCommand(arguments: ["--port-range", ""], environment: [:])
        }
        #expect(throws: CLIError.self) {
            try parseCommand(arguments: ["--port-range"], environment: [:])
        }
    }

    @Test func theRefusalNamesWhatToDoAndWhereTheValueCameFrom() throws {
        let flag = #expect(throws: CLIError.self) {
            try parseCommand(arguments: ["--port-range", "65"], environment: [:])
        }
        #expect(flag?.description == "--port-range requires a whole number of ports from 1 through 64")

        let variable = #expect(throws: CLIError.self) {
            try parseCommand(arguments: [], environment: ["MCP_SAFARI_PORT_RANGE": "many"])
        }
        #expect(variable?.description == "MCP_SAFARI_PORT_RANGE must be a whole number of ports from 1 through 64, not many")
    }

    @Test func aRangeThatRunsPastThePortSpaceIsRefusedOnlyWhenAskedFor() throws {
        // Asked for and impossible: say so rather than quietly using fewer ports.
        let flag = #expect(throws: CLIError.self) {
            try parseCommand(arguments: ["--port", "65530", "--port-range", "10"], environment: [:])
        }
        #expect(flag?.description.contains("65535") == true)
        #expect(flag?.description.contains("--port-range") == true)
        #expect(throws: CLIError.self) {
            try parseCommand(arguments: ["--port", "65530"], environment: ["MCP_SAFARI_PORT_RANGE": "10"])
        }
        #expect(throws: CLIError.self) {
            try parseCommand(arguments: ["doctor", "--port", "65535", "--port-range", "2"], environment: [:])
        }
        // The last port that fits is allowed.
        #expect(
            try parseCommand(arguments: ["--port", "65526", "--port-range", "10"], environment: [:])
                == .serve(port: 65526, portCount: 10, logLevel: .notice)
        )
        // The default has always shortened itself at the top, and still does.
        #expect(
            try parseCommand(arguments: ["--port", "65535"], environment: [:])
                == .serve(port: 65535, portCount: 10, logLevel: .notice)
        )
    }

    @Test func theLastPortOfASweepStopsAtTheTopOfThePortSpace() {
        #expect(WebSocketBridge.lastPort(from: 8089, count: 10) == 8098)
        #expect(WebSocketBridge.lastPort(from: 9000, count: 1) == 9000)
        #expect(WebSocketBridge.lastPort(from: 9000, count: 64) == 9063)
        #expect(WebSocketBridge.lastPort(from: 65530, count: 10) == 65535)
        #expect(WebSocketBridge.lastPort(from: 65535, count: 64) == 65535)
        // Zero ports is no sweep at all, so it is read as the one port asked for.
        #expect(WebSocketBridge.lastPort(from: 9000, count: 0) == 9000)
    }

    // MARK: - The sweep

    /// The default was a hard-coded ten, so a user whose first ten ports were all
    /// taken had no way to get a server up at all.
    @Test func aWiderRangeReachesPastTheTenthPort() async throws {
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }

        let first: UInt16 = 8601
        let held = holdPorts(from: first, count: 10)
        defer { for descriptor in held { Darwin.close(descriptor) } }
        try #require(held.count == 10, "every port in the first ten has to be occupied for this to test anything")

        let bridge = try WebSocketBridge(
            port: first,
            portCount: 12,
            logger: Logger(label: "PortRangeTests"),
            tokenRoot: tokenRoot
        )
        await bridge.start()
        defer { Task { await bridge.stop() } }

        let status = await bridge.status()
        #expect(status.listener == .listening)
        #expect(status.port == first + 10)
        #expect(status.requestedPort == first)
        #expect(status.lastPort == first + 11)
        // The token is what the extension discovers the server by, so it has to
        // be under the port that was actually bound.
        let token = tokenRoot.appendingPathComponent("tokens/\(first + 10)")
        let published = try String(contentsOf: token, encoding: .utf8)
        let expected = await bridge.authToken
        #expect(published == expected)
    }

    @Test func aNarrowerRangeStopsWhereItWasTold() async throws {
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }

        let first: UInt16 = 8631
        let held = holdPorts(from: first, count: 3)
        defer { for descriptor in held { Darwin.close(descriptor) } }
        try #require(held.count == 3, "the ports in the sweep have to be occupied for this to test anything")

        // The ports right after the held ones are free, and a sweep of ten would
        // have reached them.
        let bridge = try WebSocketBridge(
            port: first,
            portCount: 3,
            logger: Logger(label: "PortRangeTests"),
            tokenRoot: tokenRoot
        )
        await bridge.start()
        defer { Task { await bridge.stop() } }

        let status = await bridge.status()
        #expect(status.listener == .failed)
        #expect(status.lastPort == first + 2)
        let failure = try #require(status.lastError)
        #expect(failure.code == "bridge_bind_failed")
        #expect(failure.message == "No free port in 8631-8633 for the extension bridge.")
        #expect(failure.recovery.contains("--port-range"))
        #expect(!FileManager.default.fileExists(atPath: tokenRoot.appendingPathComponent("tokens/\(first + 3)").path))
    }

    @Test func aRangeOfOneNamesThePortRatherThanARangeOfOne() async throws {
        try FileManager.default.createDirectory(at: tokenRoot, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }

        let first: UInt16 = 8641
        let held = holdPorts(from: first, count: 1)
        defer { for descriptor in held { Darwin.close(descriptor) } }
        try #require(held.count == 1)

        let bridge = try WebSocketBridge(
            port: first,
            portCount: 1,
            logger: Logger(label: "PortRangeTests"),
            tokenRoot: tokenRoot
        )
        await bridge.start()
        defer { Task { await bridge.stop() } }

        #expect(await bridge.status().lastError?.message == "No free port in 8641 for the extension bridge.")
    }

    @Test func statusReportsTheDefaultRange() async throws {
        let bridge = try WebSocketBridge(port: 8128, logger: Logger(label: "PortRangeTests"))
        let status = await bridge.status()
        #expect(status.requestedPort == 8128)
        #expect(status.lastPort == 8137)

        let json = String(decoding: try JSONEncoder().encode(status), as: UTF8.self)
        #expect(json.contains(#""lastPort":8137"#))
    }

    // MARK: - Doctor

    private func writeToken(_ port: UInt16, mode: Int, in directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent(String(port))
        try "secret".write(to: file, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: mode], ofItemAtPath: file.path)
    }

    /// A server whose first port was taken binds a later one, and the doctor
    /// looked only at the first, so it called a working install broken.
    @Test func doctorFindsTheTokenAnywhereInTheRange() throws {
        let tokens = tokenRoot.appendingPathComponent("tokens", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        try writeToken(8095, mode: 0o600, in: tokens)

        let found = Doctor.tokenFileCheck(in: tokens, ports: 8089...8098)
        #expect(found.status == .ok)
        #expect(found.message.hasSuffix("8095."))

        // The same files, with the range cut short of the one that exists.
        let missed = Doctor.tokenFileCheck(in: tokens, ports: 8089...8091)
        #expect(missed.status == .warning)
        #expect(missed.message == "No authentication token file exists for ports 8089-8091 in \(tokens.path).")
    }

    @Test func doctorNamesTheOnePortWhenTheRangeIsOne() throws {
        let tokens = tokenRoot.appendingPathComponent("tokens", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }

        let missing = Doctor.tokenFileCheck(in: tokens, ports: 9000...9000)
        #expect(missing.status == .warning)
        #expect(missing.message == "No authentication token file exists at \(tokens.appendingPathComponent("9000").path).")
    }

    @Test func doctorReportsEveryTokenInTheRangeAndFlagsAnUnsafeOne() throws {
        let tokens = tokenRoot.appendingPathComponent("tokens", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: tokenRoot) }
        try writeToken(8089, mode: 0o600, in: tokens)
        try writeToken(8091, mode: 0o600, in: tokens)

        let both = Doctor.tokenFileCheck(in: tokens, ports: 8089...8098)
        #expect(both.status == .ok)
        #expect(both.message.contains("8089, 8091"))

        try writeToken(8091, mode: 0o644, in: tokens)
        let unsafe = Doctor.tokenFileCheck(in: tokens, ports: 8089...8098)
        #expect(unsafe.status == .warning)
        #expect(unsafe.message.contains(tokens.appendingPathComponent("8091").path))
        #expect(!unsafe.message.contains(tokens.appendingPathComponent("8089").path))
        #expect(unsafe.message.contains("permissions are not 0600"))
    }
}
