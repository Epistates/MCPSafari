import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/trace-interceptor.js", import.meta.url),
    "utf8"
);

function loadInterceptor() {
    const location = { href: "https://example.test/" };
    const window = {
        CSS: { escape: String },
        addEventListener() {},
        postMessage() {},
    };

    class MutationObserver {
        constructor(callback) { window.__observerCallback = callback; }
        observe() {}
        disconnect() {}
    }

    vm.runInNewContext(source, {
        window,
        location,
        history: { pushState() {}, replaceState() {} },
        document: { documentElement: {} },
        MutationObserver,
        Node: { ELEMENT_NODE: 1 },
        setInterval: () => 1,
        clearInterval() {},
    });

    return window;
}

test("eventTypes filters before the trace event cap", () => {
    const window = loadInterceptor();
    const { id } = window.__mcpStartTrace({ eventTypes: ["network.fetch"] });

    for (let index = 0; index <= 1000; index += 1) {
        window.__mcpRecordTraceEvent("dom.mutation", { index });
    }
    window.__mcpRecordTraceEvent("network.fetch", { url: "https://example.test/data" });

    const trace = window.__mcpStopTrace({ id });
    assert.equal(trace.truncated, false);
    assert.deepEqual(
        Array.from(trace.events, ({ type }) => type),
        ["network.fetch"]
    );
});

// ─── Attribute mutations ─────────────────────────────────────────────

function fakeNode(tag, attributes = {}, id = "") {
    return {
        nodeType: 1,
        tagName: tag.toUpperCase(),
        id,
        attributes,
        classList: [],
        parentElement: null,
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null;
        },
    };
}

function traceMutations(mutations) {
    const window = loadInterceptor();
    const { id } = window.__mcpStartTrace({});
    window.__observerCallback(mutations);
    return window.__mcpStopTrace({ id }).events.filter((event) => event.type === "dom.mutation");
}

function attributeMutation(target, attributeName, oldValue) {
    return { type: "attributes", target, attributeName, oldValue };
}

test("a typed password mirrored into the value attribute is not recorded", () => {
    // Frameworks sync what a user types into `value`, so both the old and the
    // new value are the secret.
    const input = fakeNode("input", { type: "text", value: "hunter2" });

    const [event] = traceMutations([attributeMutation(input, "value", "hunter")]);

    assert.equal(event.attribute, "value");
    assert.equal(event.valueOmitted, true);
    assert.equal("value" in event, false);
    assert.equal("oldValue" in event, false);
    assert.doesNotMatch(JSON.stringify(event), /hunter/);
});

test("checked is never recorded either", () => {
    const box = fakeNode("input", { type: "checkbox", checked: "" });

    const [event] = traceMutations([attributeMutation(box, "checked", null)]);

    assert.equal(event.valueOmitted, true);
    assert.equal("value" in event, false);
});

test("no attribute of a sensitive input is recorded", () => {
    const password = fakeNode("input", { type: "password", title: "my secret phrase", "data-x": "y" });
    const otp = fakeNode("input", { type: "text", autocomplete: "one-time-code", title: "123456" });
    const named = fakeNode("input", { type: "text", name: "cardCvv", title: "737" });

    const events = traceMutations([
        attributeMutation(password, "title", "old secret phrase"),
        attributeMutation(otp, "title", "12345"),
        attributeMutation(named, "title", "73"),
    ]);

    assert.equal(events.length, 3);
    for (const event of events) {
        assert.equal(event.valueOmitted, true);
        assert.equal("value" in event, false);
        assert.equal("oldValue" in event, false);
    }
});

test("ordinary attributes on ordinary elements are still recorded", () => {
    const button = fakeNode("button", { class: "primary active" });

    const [event] = traceMutations([attributeMutation(button, "class", "primary")]);

    assert.equal(event.oldValue, "primary");
    assert.equal(event.value, "primary active");
    assert.equal("valueOmitted" in event, false);
});

test("a recorded attribute value is bounded and says so", () => {
    const long = "x".repeat(5000);
    const div = fakeNode("div", { style: long });

    const [event] = traceMutations([attributeMutation(div, "style", long)]);

    assert.equal(event.value.length, 512);
    assert.equal(event.oldValue.length, 512);
    assert.equal(event.truncated, true);
});
