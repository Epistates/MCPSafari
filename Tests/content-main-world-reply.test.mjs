import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { contentScriptSource } from "./helpers/extension-sources.mjs";

const source = contentScriptSource();

// The page can answer a MAIN-world request as easily as the interceptor can: it
// shares the window, sees the request id, and posts to the same channel. These
// drive the isolated side with whatever reply a hostile page would send.
function loadContent() {
    let runtimeListener;
    const messageListeners = new Set();
    const posted = [];

    const window = {
        addEventListener: (type, fn) => {
            if (type === "message") messageListeners.add(fn);
        },
        removeEventListener: (type, fn) => {
            if (type === "message") messageListeners.delete(fn);
        },
        postMessage: (message) => posted.push(message),
    };

    vm.runInNewContext(source, {
        browser: { runtime: { onMessage: { addListener: (fn) => { runtimeListener = fn; } } } },
        document: {},
        crypto: globalThis.crypto,
        setTimeout: () => 0,
        clearTimeout() {},
        window,
    });

    const harness = {
        posted,
        call: (action, params = {}) => new Promise((resolve) => {
            runtimeListener({ action, params }, {}, resolve);
        }),
        /// Answers the most recent request, the way a page-world script would.
        reply(payload, overrides = {}) {
            const request = posted.at(-1);
            for (const listener of [...messageListeners]) {
                listener({
                    source: window,
                    data: { source: "MCPSafariPage", id: request.id, ...payload },
                    ...overrides,
                });
            }
        },
        async ask(action, params, payload) {
            const pending = harness.call(action, params);
            await new Promise((resolve) => setImmediate(resolve));
            harness.reply(payload);
            return pending;
        },
    };
    return harness;
}

const bytes = (response) => Buffer.byteLength(JSON.stringify(response.data));

test("request ids are random and unrelated to the clock or a counter", async () => {
    const harness = loadContent();

    for (let attempt = 0; attempt < 3; attempt += 1) {
        const pending = harness.call("get_console_messages");
        await new Promise((resolve) => setImmediate(resolve));
        harness.reply({ data: [] });
        await pending;
    }

    const ids = harness.posted.map((message) => message.id);
    assert.equal(new Set(ids).size, 3);
    for (const id of ids) {
        assert.match(id, /^mcp-[0-9a-f]{32}$/);
        assert.doesNotMatch(id, new RegExp(String(Date.now()).slice(0, 8)));
    }
});

test("a console reply larger than the documented caps is cut to them", async () => {
    const harness = loadContent();
    const hostile = Array.from({ length: 50000 }, (_, index) => ({
        level: "log",
        timestamp: index,
        text: "x".repeat(100000),
        truncated: false,
    }));

    const response = await harness.ask("get_console_messages", {}, { data: hostile });

    assert.equal(response.error, null);
    assert.ok(response.data.length <= 1000, `kept ${response.data.length} entries`);
    assert.ok(response.data.every((entry) => entry.text.length <= 8192));
    assert.ok(response.data.every((entry) => entry.truncated === true), "a cut text says so");
    // Far below the bridge's 32 MiB frame limit.
    assert.ok(bytes(response) < 8 * 1024 * 1024, `${bytes(response)} bytes`);
});

test("a network reply keeps at most 500 records of 2048 characters a field", async () => {
    const harness = loadContent();
    const hostile = Array.from({ length: 5000 }, () => ({
        type: "fetch", method: "GET", url: "https://x.example/" + "a".repeat(100000), status: 200,
    }));

    const response = await harness.ask("get_network_requests", {}, { data: hostile });

    assert.equal(response.data.length, 500);
    assert.ok(response.data.every((entry) => entry.url.length === 2048 && entry.truncated === true));
});

test("a trace reply keeps its shape and loses what exceeds the caps", async () => {
    const harness = loadContent();
    const events = Array.from({ length: 20000 }, (_, index) => ({
        type: "dom.mutation", at: index, offset: index, value: "y".repeat(100000),
    }));

    const response = await harness.ask("stop_trace", { id: "t" }, {
        data: { id: "t", startTime: 1, endTime: 2, durationMs: 1, truncated: false, events },
    });

    assert.equal(response.error, null);
    assert.equal(response.data.id, "t");
    assert.ok(response.data.events.length <= 1001);
    assert.equal(response.data.truncated, true, "the trace says it lost events");
    assert.ok(response.data.events.every((event) => event.value.length <= 4096));
    assert.ok(bytes(response) < 8 * 1024 * 1024, `${bytes(response)} bytes`);
});

test("many small entries cannot add up past the total budget", async () => {
    const harness = loadContent();
    // Each entry is within its caps; there are simply a great many strings.
    const entry = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`f${index}`, "z".repeat(2048)]));
    const hostile = Array.from({ length: 500 }, () => ({ ...entry }));

    const response = await harness.ask("get_network_requests", {}, { data: hostile });

    assert.ok(bytes(response) < 6 * 1024 * 1024, `${bytes(response)} bytes`);
});

test("a reply of the wrong shape is refused, not passed on", async () => {
    for (const [action, data] of [
        ["get_console_messages", { not: "a list" }],
        ["get_console_messages", "text"],
        ["get_network_requests", 5],
        ["stop_trace", [1, 2, 3]],
        ["stop_trace", () => {}],
    ]) {
        const harness = loadContent();
        const response = await harness.ask(action, {}, { data });
        assert.match(response.error, /unexpected result/, `${action} with ${typeof data}`);
    }
});

test("entries that are not objects are dropped from a list", async () => {
    const harness = loadContent();

    const response = await harness.ask("get_console_messages", {}, {
        data: [null, 7, "str", [1], { level: "log", text: "ok" }],
    });

    // Arrays built here carry another realm's prototype, so compare as JSON.
    assert.equal(JSON.stringify(response.data), JSON.stringify([{ level: "log", text: "ok" }]));
});

test("values that are not plain data never reach the bridge", async () => {
    const harness = loadContent();

    const response = await harness.ask("stop_trace", { id: "t" }, {
        data: {
            handled: true,
            type: "alert",
            message: "hi",
            when: new Date(0),
            lookup: new Map([[1, 2]]),
            big: 10n,
            nan: NaN,
            ["__proto__"]: { polluted: true },
        },
    });

    assert.equal(response.error, null);
    // JSON-safe, and handled by the same code that read it before.
    assert.doesNotThrow(() => JSON.stringify(response.data));
    assert.equal(response.data.handled, true);
    assert.equal(response.data.when, undefined);
    assert.equal(response.data.lookup, undefined);
    assert.equal(response.data.big, undefined);
    assert.equal(response.data.nan, null);
    assert.equal({}.polluted, undefined);
});

test("deeply nested data is cut rather than followed", async () => {
    const harness = loadContent();
    let nested = { leaf: "deep" };
    for (let level = 0; level < 5000; level += 1) nested = { child: nested };

    const response = await harness.ask("stop_trace", { id: "t" }, { data: { handled: true, nested } });

    assert.equal(response.error, null);
    assert.ok(JSON.stringify(response.data).length < 1000);
});

test("a page-supplied error message is bounded", async () => {
    const harness = loadContent();
    const pending = harness.call("get_console_messages");
    await new Promise((resolve) => setImmediate(resolve));
    harness.reply({ error: "e".repeat(1_000_000) });

    const response = await pending;

    assert.ok(response.error.length <= 1024);
});

test("a reply from anywhere but the window itself is ignored", async () => {
    const harness = loadContent();
    const pending = harness.call("get_console_messages");
    await new Promise((resolve) => setImmediate(resolve));

    harness.reply({ data: [{ level: "log", text: "forged" }] }, { source: {} });
    harness.reply({ data: [{ level: "log", text: "real" }] });
    const response = await pending;

    assert.equal(response.data[0].text, "real");
});

test("a legitimate full console reply passes through unchanged", async () => {
    const harness = loadContent();
    const messages = Array.from({ length: 1000 }, (_, index) => ({
        level: "info", timestamp: index, text: "m".repeat(200), truncated: false,
    }));

    const response = await harness.ask("get_console_messages", {}, { data: messages });

    assert.equal(response.data.length, 1000);
    assert.equal(response.data[999].text, "m".repeat(200));
    assert.equal(response.data[0].truncated, false);
});
