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


// Errors are built inside the sandbox, as a page's own are.
const inPage = (context, code) => vm.runInContext(code, context);

test("an Error is captured with its name, message and stack, not as {}", () => {
    const context = loadInterceptor();
    const error = inPage(context, `(() => {
        const e = new TypeError("cannot read x");
        e.stack = "TypeError: cannot read x\\n    at render (app.js:10:5)";
        return e;
    })()`);

    context.console.error("failed:", error);
    const [entry] = context.window.__mcpGetConsoleMessages({});

    assert.match(entry.text, /^failed: TypeError: cannot read x\n    at render \(app\.js:10:5\)$/);
    assert.doesNotMatch(entry.text, /\{\}/);
});

test("a stack with no header, as Safari writes it, gets one", () => {
    const context = loadInterceptor();
    const error = inPage(context, `(() => {
        const e = new RangeError("too deep");
        e.stack = "render@app.js:10:5\\nmain@app.js:2:1";
        return e;
    })()`);

    context.console.error(error);
    const [entry] = context.window.__mcpGetConsoleMessages({});

    assert.equal(entry.text, "RangeError: too deep\nrender@app.js:10:5\nmain@app.js:2:1");
});

test("an Error's stack is bounded and the entry says so", () => {
    const context = loadInterceptor();
    const error = inPage(context, `(() => {
        const e = new Error("deep");
        e.stack = "Error: deep\\n" + "    at frame (app.js:1:1)\\n".repeat(5000);
        return e;
    })()`);

    context.console.error(error);
    const [entry] = context.window.__mcpGetConsoleMessages({});

    assert.ok(entry.text.length < 2048 + 64, `${entry.text.length} characters`);
    assert.equal(entry.truncated, true);
});

test("an Error without a stack or a message still reads as an error", () => {
    const context = loadInterceptor();
    const bare = inPage(context, `(() => { const e = new Error(""); e.stack = undefined; return e; })()`);

    context.console.warn(bare);
    const [entry] = context.window.__mcpGetConsoleMessages({});

    assert.equal(entry.text, "Error");
});

test("an unhandled rejection with an Error reports the Error", () => {
    const listeners = {};
    const context = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        window: { addEventListener: (type, fn) => { listeners[type] = fn; }, postMessage() {} },
        Date, JSON, RegExp, String, Set,
    };
    context.window.window = context.window;
    vm.runInNewContext(source, context);
    const reason = vm.runInContext(`(() => { const e = new Error("nope"); e.stack = ""; return e; })()`, context);

    listeners.unhandledrejection({ reason });
    const [entry] = context.window.__mcpGetConsoleMessages({});

    assert.equal(entry.text, "Unhandled Promise Rejection: Error: nope");
});

test("values JSON cannot carry are named instead of vanishing", () => {
    const context = loadInterceptor();
    const { console: patched, window } = context;

    patched.log(undefined);
    patched.log(function handler() {});
    patched.log(Symbol("tag"));
    patched.log(10n);
    patched.log({ nested: inPage(context, `(() => { const e = new Error("inner"); e.stack = ""; return e; })()`), run() {} });
    const texts = Array.from(window.__mcpGetConsoleMessages({}), (m) => m.text);

    assert.equal(texts[0], "undefined");
    assert.equal(texts[1], "[Function handler]");
    assert.equal(texts[2], "Symbol(tag)");
    assert.equal(texts[3], "10n");
    assert.equal(texts[4], '{"nested":"Error: inner","run":"[Function run]"}');
});

test("capture bounds large arguments and rejects pathological filters", () => {
    const { console: patched, window } = loadInterceptor();
    patched.log("a".repeat(100_000));
    const entries = window.__mcpGetConsoleMessages({});
    assert.equal(entries[0].text.length, 8192);
    assert.equal(entries[0].truncated, true);
    assert.throws(() => window.__mcpGetConsoleMessages({ pattern: "(a+)+$" }), /Unsupported filter/);
    assert.throws(() => window.__mcpGetConsoleMessages({ pattern: "a*a*Z" }), /Unsupported filter/);
    assert.throws(() => window.__mcpGetConsoleMessages({ pattern: "[" }));
});
