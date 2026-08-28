import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const backgroundSource = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/background.js", import.meta.url),
    "utf8"
);

// Built inside the vm so the thrown EvalError belongs to that realm, the way a
// real page's refusal does; a cross-realm one would defeat `instanceof`.
function refusingFunction(context) {
    return vm.runInContext(
        `(function () {
            throw new EvalError("Refused to evaluate a string as JavaScript because 'unsafe-eval' is not an allowed source of script in the following Content Security Policy directive: \\"script-src 'self'\\".");
        })`,
        context
    );
}

function backgroundHarness({ cspBlockedWorlds = [] } = {}) {
    let context;

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
            // A world whose CSP forbids 'unsafe-eval' refuses to compile a
            // string, which is what `new Function` does inside the injected code.
            executeScript: async ({ func, args, world }) => {
                if (!cspBlockedWorlds.includes(world)) {
                    return [{ result: await func(...args) }];
                }
                // Read from inside: intrinsics live on the vm global, not on the
                // sandbox object, so `context.Function` here would be undefined
                // and restoring it would erase the real one.
                const realFunction = vm.runInContext("Function", context);
                context.Function = refusingFunction(context);
                try {
                    return [{ result: await func(...args) }];
                } finally {
                    context.Function = realFunction;
                }
            },
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

    context = vm.createContext({
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

test("a page CSP that blocks eval falls back to the isolated world", async () => {
    const run = backgroundHarness({ cspBlockedWorlds: ["MAIN"] });

    const output = await run("1 + 1");

    assert.match(output, /^2\n/, "the value still comes back");
    assert.match(output, /isolated world/i, "and the caller is told where it ran");
    assert.match(output, /globals/i, "including what is not visible there");
});

test("CSP in both worlds reports what to use instead", async () => {
    const run = backgroundHarness({ cspBlockedWorlds: ["MAIN", "ISOLATED"] });

    await assert.rejects(run("1 + 1"), (err) => {
        assert.match(err.message, /Content Security Policy/);
        assert.match(err.message, /snapshot|find|read_page/);
        assert.doesNotMatch(err.message, /unsafe-eval/, "the raw browser text is replaced with guidance");
        return true;
    });
});

test("an ordinary page still runs in the page world with no note", async () => {
    const run = backgroundHarness();
    assert.equal(await run("1 + 1"), "2");
});
