import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/console-interceptor.js", import.meta.url),
    "utf8"
);

function loadInterceptor() {
    const context = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        window: { addEventListener() {}, postMessage() {} },
        Date, JSON, RegExp, String, Set,
    };
    context.window.window = context.window;
    vm.runInNewContext(source, context);
    return context;
}

test("clearing a pattern-filtered read keeps messages the caller never saw", () => {
    const { console: patched, window } = loadInterceptor();

    patched.log("alpha keep-me");
    patched.log("beta match-me");

    const matched = window.__mcpGetConsoleMessages({ pattern: "match-me", clear: true });
    const remaining = window.__mcpGetConsoleMessages({});

    assert.deepEqual(Array.from(matched, (m) => m.text), ["beta match-me"]);
    assert.deepEqual(Array.from(remaining, (m) => m.text), ["alpha keep-me"]);
});

test("clearing a level-filtered read leaves the other levels intact", () => {
    const { console: patched, window } = loadInterceptor();

    patched.log("a log line");
    patched.error("an error line");

    window.__mcpGetConsoleMessages({ level: "error", clear: true });
    const remaining = window.__mcpGetConsoleMessages({});

    assert.deepEqual(Array.from(remaining, (m) => m.text), ["a log line"]);
});

test("clearing an unfiltered read empties the buffer", () => {
    const { console: patched, window } = loadInterceptor();

    patched.log("one");
    patched.warn("two");

    window.__mcpGetConsoleMessages({ clear: true });

    assert.deepEqual(Array.from(window.__mcpGetConsoleMessages({})), []);
});

test("level and pattern filters compose when clearing", () => {
    const { console: patched, window } = loadInterceptor();

    patched.error("fetch failed for /a");
    patched.error("render failed");
    patched.log("fetch started for /a");

    const matched = window.__mcpGetConsoleMessages({ level: "error", pattern: "^fetch", clear: true });
    const remaining = window.__mcpGetConsoleMessages({});

    assert.deepEqual(Array.from(matched, (m) => m.text), ["fetch failed for /a"]);
    assert.deepEqual(
        Array.from(remaining, (m) => m.text),
        ["render failed", "fetch started for /a"]
    );
});
