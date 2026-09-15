import MCP
import Testing
@testable import MCPSafari

struct RunStepsTests {
    @Test func parsesStepsAndInheritsBatchTab() throws {
        let plan = try RunStepsPlan(arguments: [
            "tabId": "p0t42",
            "steps": [
                ["tool": "navigate", "arguments": ["url": "https://example.com"]],
                ["tool": "click", "arguments": ["selector": "#submit", "tabId": "p1t7"]],
                ["tool": "wait"],
            ],
        ])

        #expect(plan.steps.count == 3)
        #expect(plan.steps[0].arguments["tabId"]?.stringValue == "p0t42")
        // A step naming its own tab keeps it, including one in another profile.
        #expect(plan.steps[1].arguments["tabId"]?.stringValue == "p1t7")
        #expect(plan.steps[2].arguments["tabId"]?.stringValue == "p0t42")
        #expect(plan.timeout == 60)
    }

    @Test func rejectsTabIdsThatAreNotHandles() {
        // The integer form named a tab without saying which profile's, so the
        // same number meant a different page in each one.
        #expect(errorMessage(["tabId": 42, "steps": [["tool": "wait"]]])?
            .hasPrefix("tabId must be a tab handle such as \"p0t5\"") == true)
        #expect(errorMessage(["tabId": "42", "steps": [["tool": "wait"]]]) ==
            "tabId \"42\" is not a tab handle. Handles look like p0t5, meaning tab 5 of profile 0, "
            + "and come from tabs_context.")
        #expect(errorMessage(["steps": [["tool": "wait", "arguments": ["tabId": "t5"]]]]) ==
            "steps[0].arguments.tabId \"t5\" is not a tab handle. Handles look like p0t5, meaning "
            + "tab 5 of profile 0, and come from tabs_context.")
    }

    @Test func acceptsTheFileAttachmentTools() throws {
        // They route through the same handler a direct call does; excluding them
        // forced callers to split a batch around the one step that attaches a file.
        let plan = try RunStepsPlan(arguments: [
            "steps": [
                ["tool": "upload_file", "arguments": ["selector": "#file", "paths": ["/tmp/a.png"]]],
                ["tool": "drop_file", "arguments": ["selector": "#drop", "paths": ["/tmp/b.png"]]],
            ],
        ])

        #expect(plan.steps.map(\.tool) == ["upload_file", "drop_file"])
        #expect(RunStepsPlan.allowedTools.isSuperset(of: ["upload_file", "drop_file"]))
    }

    @Test func rejectsEmptyOversizedAndUnsupportedBatches() {
        #expect(errorMessage([:]) == "steps must contain at least one step")
        #expect(errorMessage(["steps": []]) == "steps must contain at least one step")
        #expect(errorMessage([
            "steps": .array((0...RunStepsPlan.maxSteps).map { _ in ["tool": "wait"] }),
        ]) == "steps cannot contain more than 10 steps")
        #expect(errorMessage(["steps": [["tool": "run_steps"]]]) ==
            "steps[0].tool does not support run_steps")
    }

    @Test func keepsBatchArtifactsAtBatchLevel() {
        #expect(errorMessage([
            "steps": [["tool": "click", "arguments": ["trace": true]]],
        ]) == "steps[0].arguments.trace must be set on run_steps instead")
        #expect(errorMessage([
            "steps": [["tool": "click", "arguments": ["eventTypes": ["dom.mutation"]]]],
        ]) == "steps[0].arguments.eventTypes must be set on run_steps instead")
        #expect(errorMessage([
            "steps": [["tool": "click", "arguments": ["includeSnapshot": true]]],
        ]) == "steps[0].arguments.includeSnapshot must be set on run_steps instead")
    }

    @Test func validatesAndCapsTheBatchDeadline() throws {
        let plan = try RunStepsPlan(arguments: [
            "timeout": 600,
            "steps": [["tool": "wait", "arguments": ["seconds": 0]]],
        ])

        #expect(plan.timeout == RunStepsPlan.maxTimeout)
        #expect(errorMessage([
            "timeout": "soon",
            "steps": [["tool": "wait"]],
        ]) == "timeout must be a number")
    }

    private func errorMessage(_ arguments: [String: Value]) -> String? {
        do {
            _ = try RunStepsPlan(arguments: arguments)
            return nil
        } catch let error as RunStepsInputError {
            return error.description
        } catch {
            return String(describing: error)
        }
    }
}
