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
