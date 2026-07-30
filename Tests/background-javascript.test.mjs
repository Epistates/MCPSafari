import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const backgroundSource = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/background.js", import.meta.url),
    "utf8"
);

function backgroundHarness() {
    class FakeWebSocket {
        static CONNECTING = 0;
        constructor(url) {
            this.url = url;
            this.readyState = FakeWebSocket.CONNECTING;
        }
        send() {}
    }

    const browser = {
        alarms: {
            create() {},
            onAlarm: { addListener() {} },
        },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        scripting: {
            executeScript: async ({ func, args }) => [{ result: await func(...args) }],
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            get: async () => { throw new Error("not found"); },
            onUpdated: { addListener() {}, removeListener() {} },
        },
    };

    const context = vm.createContext({
        browser,
        clearTimeout() {},
        console: { error() {}, log() {}, warn() {} },
        Date,
        Promise,
        setTimeout() {},
        WebSocket: FakeWebSocket,
    });
    vm.runInContext(backgroundSource, context);

    return (code) => vm.runInContext(
        `handleJavaScript({ tabId: 1, code: ${JSON.stringify(code)} })`,
        context
    );
}

test("plain expression returns its value", async () => {
    const run = backgroundHarness();
    assert.equal(await run("1 + 1"), "2");
});

test("statement body with explicit return returns its value", async () => {
    const run = backgroundHarness();
    const code = "const a = await Promise.resolve(41); const b = a + 1; return JSON.stringify({ b })";
    assert.equal(await run(code), '"{\\"b\\":42}"');
});

test("statement body without return yields no value", async () => {
    const run = backgroundHarness();
    const code = "const x = 1; const y = 2; JSON.stringify({ sum: x + y })";
    assert.equal(await run(code), "undefined");
});

test("sync throw in a statement body surfaces as an error", async () => {
    const run = backgroundHarness();
    await assert.rejects(run('throw new Error("boom-sync")'), /boom-sync/);
});

test("awaited rejection surfaces as an error", async () => {
    const run = backgroundHarness();
    const code = "const p = Promise.reject(new Error('boom-async')); return await p";
    await assert.rejects(run(code), /boom-async/);
});

test("non-Error rejection surfaces its string form", async () => {
    const run = backgroundHarness();
    await assert.rejects(run("return Promise.reject('boom-string')"), /boom-string/);
});

test("parse errors still surface", async () => {
    const run = backgroundHarness();
    await assert.rejects(run("const a = 1; this is not valid js; return a"), /Unexpected identifier/);
});

test("async IIFE expression keeps working", async () => {
    const run = backgroundHarness();
    const code = "(async () => { const a = await Promise.resolve(41); return JSON.stringify({ b: a + 1 }) })()";
    assert.equal(await run(code), '"{\\"b\\":42}"');
});
