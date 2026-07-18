import MCP
import Testing
@testable import MCPSafari

struct RunStepsTests {
    @Test func parsesStepsAndInheritsBatchTab() throws {
        let plan = try RunStepsPlan(arguments: [
            "tabId": 42,
            "steps": [
                ["tool": "navigate", "arguments": ["url": "https://example.com"]],
                ["tool": "click", "arguments": ["selector": "#submit", "tabId": 7]],
                ["tool": "wait"],
            ],
        ])

        #expect(plan.steps.count == 3)
        #expect(plan.steps[0].arguments["tabId"]?.intValue == 42)
        #expect(plan.steps[1].arguments["tabId"]?.intValue == 7)
        #expect(plan.steps[2].arguments["tabId"]?.intValue == 42)
        #expect(plan.timeout == 60)
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
