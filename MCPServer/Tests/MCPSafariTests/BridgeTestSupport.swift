import Foundation
@testable import MCPSafari

/// Polls until `condition` holds or `timeout` passes, and returns whether it held.
///
/// For asserting on something an actor does on its own schedule. Sleeping a fixed
/// time and then checking passes on a slow machine for the wrong reason and fails
/// on a busy one, and a negative check after a sleep proves nothing; waiting on
/// the observable condition does neither.
func eventually(
    timeout: Duration = .seconds(5),
    _ condition: () async -> Bool
) async -> Bool {
    let deadline = ContinuousClock.now + timeout
    while ContinuousClock.now < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return await condition()
}

/// What a bridge call fails with as the MCP client would see it, or nil if the call
/// succeeded or failed some other way.
func bridgeFailure(of call: () async throws -> Void) async -> ToolFailure? {
    do {
        try await call()
        return nil
    } catch let error as WebSocketBridge.BridgeError {
        return error.toolFailure
    } catch {
        return nil
    }
}
