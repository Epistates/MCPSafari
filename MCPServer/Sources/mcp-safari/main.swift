import Darwin
import Foundation
import Logging

let command: CLICommand
do {
    command = try parseCommand(arguments: Array(CommandLine.arguments.dropFirst()))
} catch {
    FileHandle.standardError.write(Data("mcp-safari: \(error)\n".utf8))
    exit(2)
}

switch command {
case .help:
    // Asked for explicitly, so it is output rather than an error: stdout, exit 0.
    // Usage errors keep going to stderr with a non-zero status above.
    print(usageText)
    exit(0)

case .version:
    print("mcp-safari \(MCPSafariProduct.version)")
    exit(0)

case .doctor(let port, let json):
    let report = Doctor.inspect(port: port, extensionRegistered: Doctor.isExtensionRegistered())
    let output = json ? try Doctor.json(report) : Doctor.humanReadable(report)
    print(output)
    exit(report.exitCode)

case .serve(let port, let logLevel):
    // Log to stderr so stdout is reserved for MCP stdio transport
    var logger = Logger(label: "mcp-safari") { label in
        StreamLogHandler.standardError(label: label)
    }
    logger.logLevel = logLevel

    logger.info("Starting Safari MCP server on WebSocket port \(port)")

    let server = try SafariMCPServer(port: port, logger: logger)
    try await server.start()
}
