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
case .doctor(let port, let json):
    let report = Doctor.inspect(port: port, extensionRegistered: Doctor.isExtensionRegistered())
    let output = json ? try Doctor.json(report) : Doctor.humanReadable(report)
    print(output)
    exit(report.exitCode)

case .serve(let port, let verbose):
    // Log to stderr so stdout is reserved for MCP stdio transport
    var logger = Logger(label: "mcp-safari") { label in
        StreamLogHandler.standardError(label: label)
    }
    logger.logLevel = verbose ? .debug : .info

    logger.info("Starting Safari MCP server on WebSocket port \(port)")

    let server = try SafariMCPServer(port: port, logger: logger)
    try await server.start()
}
