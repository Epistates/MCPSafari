import Darwin
import Foundation
import Logging

/// Removes the bridge's token files when the process is asked to end.
///
/// Terminating on a signal runs no cleanup of its own, so without these a client
/// that stops the server leaves its token on disk for the extension to keep
/// dialling. SIGPIPE is ignored for a different reason: a write to a pipe or socket
/// whose reader has gone would otherwise end the process without any cleanup either.
/// Returns the sources, which stop delivering if they are released.
func installShutdownHandlers(
    for server: SafariMCPServer,
    logger: Logger
) -> [any DispatchSourceSignal] {
    signal(SIGPIPE, SIG_IGN)
    let queue = DispatchQueue(label: "mcp-safari.signals")
    return [SIGTERM, SIGINT, SIGHUP].map { number in
        // The default action has to be off or it wins the race with the source.
        signal(number, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
        source.setEventHandler {
            logger.info("Received signal \(number), shutting down")
            // Exit even if the bridge is slow to stop; the token files are the
            // part that matters and `stop()` removes them first.
            queue.asyncAfter(deadline: .now() + 2) { exit(128 + number) }
            Task {
                await server.shutdown()
                exit(128 + number)
            }
        }
        source.resume()
        return source
    }
}

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
    let report = Doctor.inspect(port: port, registration: Doctor.extensionRegistration())
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
    let signalSources = installShutdownHandlers(for: server, logger: logger)
    try await server.start()
    // The sources are only referenced here, and Swift may release a value after its
    // last use, which would be before `start()` rather than after it.
    withExtendedLifetime(signalSources) {}
}
