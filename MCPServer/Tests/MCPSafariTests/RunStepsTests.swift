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
                ["tool": "upload_file", "arguments": ["selector": "#file", "filePaths": ["/tmp/a.png"]]],
                ["tool": "drop_file", "arguments": ["selector": "#drop", "filePath": "/tmp/b.png"]],
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

    // The header of RunStepsPlan promises the batch is validated before any of it
    // runs. Step arguments used to be checked only as each step ran, so a bad URL
    // in step 3 was found after steps 1 and 2 had already acted on the page. The
    // plan is built before the first bridge call, so a plan that throws sends none.
    @Test func aBadUrlInTheThirdStepRefusesTheWholeBatchBeforeAnythingRuns() {
        let message = errorMessage(["steps": [
            ["tool": "navigate", "arguments": ["url": "https://example.com/"]],
            ["tool": "click", "arguments": ["selector": "#go"]],
            ["tool": "navigate", "arguments": ["url": "javascript:alert(1)"]],
        ]])
        #expect(message == "steps[2] (navigate): Invalid URL or disallowed scheme. Only http, https, about, and file are allowed.")
    }

    @Test func everyKindOfBadStepArgumentIsRefusedWhilePlanning() {
        func refused(_ tool: String, _ arguments: [String: Value]) -> String? {
            errorMessage(["steps": [
                ["tool": "wait", "arguments": ["seconds": 0]],
                ["tool": .string(tool), "arguments": .object(arguments)],
            ]])
        }
        #expect(refused("navigate", ["action": "sideways"])?.hasPrefix("steps[1] (navigate): Invalid navigation action") == true)
        #expect(refused("navigate", ["url": "ht\ttp://example.com", "action": 5]) == "steps[1] (navigate): action must be a string")
        #expect(refused("wait", ["seconds": "soon"]) == "steps[1] (wait): seconds must be a number")
        #expect(refused("wait", ["selector": "#a", "timeout": "5"]) == "steps[1] (wait): timeout must be a number")
        #expect(refused("click", ["selector": "#a", "waitForSelector": ""]) == "steps[1] (click): waitForSelector must not be empty")
        #expect(refused("click", ["selector": "#a", "waitTimeout": "5"]) == "steps[1] (click): waitTimeout must be a number")
        #expect(refused("hover", ["selector": "#a", "native": "yes"]) == "steps[1] (hover): native must be a boolean")
        #expect(refused("upload_file", ["selector": "input"]) == "steps[1] (upload_file): Provide filePath or filePaths")
        #expect(refused("drop_file", ["selector": "#z", "filePath": 5]) == "steps[1] (drop_file): filePath must be a string")
    }

    @Test func nativeStepsThatCouldNeverRunAreRefusedWhilePlanning() {
        let quit = errorMessage(["steps": [
            ["tool": "click", "arguments": ["selector": "#a"]],
            ["tool": "press_key", "arguments": ["key": "Meta+q", "native": true]],
        ]])
        #expect(quit?.hasPrefix("steps[1] (press_key): Native press_key does not send Meta+q") == true)

        let tooLong = errorMessage(["steps": [
            ["tool": "type_text", "arguments": ["text": .string(String(repeating: "x", count: 1001)), "native": true]],
        ]])
        #expect(tooLong?.hasPrefix("steps[0] (type_text): Native type_text types at most 1000 characters") == true)

        // The same key without native goes to the page and is not held to that list.
        #expect(errorMessage(["steps": [
            ["tool": "press_key", "arguments": ["key": "Meta+q"]],
        ]]) == nil)
    }

    @Test func aValidBatchStillPlans() {
        #expect(errorMessage(["steps": [
            ["tool": "navigate", "arguments": ["url": "https://example.com/", "waitForText": "Example"]],
            ["tool": "wait", "arguments": ["seconds": 1]],
            ["tool": "wait", "arguments": ["selector": "#a", "timeout": 5]],
            ["tool": "click", "arguments": ["selector": "#a", "waitForSelector": "#b", "waitTimeout": 2]],
        ]]) == nil)
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
