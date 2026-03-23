import Foundation
import Logging

let port = parsePort()
let verbose = CommandLine.arguments.contains("--verbose")

// Log to stderr so stdout is reserved for MCP stdio transport
var logger = Logger(label: "safari-mcp") { label in
    StreamLogHandler.standardError(label: label)
}
logger.logLevel = verbose ? .debug : .info

logger.info("Starting Safari MCP server on WebSocket port \(port)")

let server = try SafariMCPServer(port: port, logger: logger)
try await server.start()

func parsePort() -> UInt16 {
    let args = CommandLine.arguments
    for (i, arg) in args.enumerated() {
        if (arg == "--port" || arg == "-p"), i + 1 < args.count,
           let port = UInt16(args[i + 1])
        {
            return port
        }
    }
    return 8089
}
