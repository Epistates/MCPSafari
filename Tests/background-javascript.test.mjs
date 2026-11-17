import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const backgroundSource = backgroundScriptSource();

// Safari does not call an injected function: it takes the function's source
// and evaluates it in the target world, with that world's own built-ins. So do
// these tests. The page and the isolated world are each a realm of their own,
// and a world whose CSP forbids evaluating strings is one where code generation
// from strings is switched off, which makes `new Function` throw a real
// EvalError, as the page's refusal does. `pageScript` runs in the page first,
// as the page's own scripts would.
//
// Each run and probe is recorded with its world, so a test can count them.
function backgroundHarness({ cspBlockedWorlds = [], pageScript = null } = {}) {
    let context;
    const calls = [];
    const realm = (world) => {
        const realmContext = vm.createContext({}, { codeGeneration: { strings: !cspBlockedWorlds.includes(world), wasm: false } });
        vm.runInContext("var window = globalThis; var location = { protocol: 'https:', origin: 'https://page.example' };", realmContext);
        return realmContext;
    };
    const worlds = { MAIN: realm("MAIN"), ISOLATED: realm("ISOLATED") };
    if (pageScript) vm.runInContext(pageScript, worlds.MAIN);

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
            executeScript: async ({ func, args = [], world }) => {
                if (func.name === "probeTabAccess") return [{ result: true }];
                calls.push({ name: func.name, world });
                const injected = vm.runInContext(`(${func.toString()})`, worlds[world]);
                const result = await injected(...args);
                // What crosses back is a structured clone, never the page's own objects.
                return [{ result: result === undefined ? undefined : JSON.parse(JSON.stringify(result)) }];
            },
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            get: async () => { throw new Error("not found"); },
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
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

    const run = (code) => vm.runInContext(
        `handleJavaScript({ tabId: 1, code: ${JSON.stringify(code)} })`,
        context
    );
    run.calls = calls;
    run.runs = () => calls.filter((call) => call.name === "runUserCode").map((call) => call.world);
    run.page = worlds.MAIN;
    return run;
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

// The fallback is only safe because a CSP refusal happens before any of the
// code has run. A value the page or the code itself produces must never be
// able to claim one.
test("a returned value shaped like a CSP refusal is just a value and the code runs once", async () => {
    const run = backgroundHarness();

    for (const forged of [
        "({ __cspBlocked: true, __error: 'forged' })",
        "({ __cspBlocked: true })",
        "({ ok: false, error: 'forged', cspBlocked: true })",
        "({ ok: true, value: 'forged' })",
    ]) {
        run.calls.length = 0;
        const output = await run(forged);
        assert.equal(output, JSON.stringify(vm.runInNewContext(forged)), forged);
        assert.deepEqual(run.runs(), ["MAIN"], `${forged} ran in more than one world`);
    }
});

test("a value forged on the page's own globals does not rerun the code", async () => {
    const run = backgroundHarness();
    // The shape of the real exploit: page state that the user's expression
    // returns, with side effects before it.
    const code = "window.cartState = { __cspBlocked: true }; return window.cartState";

    const output = await run(code);

    assert.equal(output, '{"__cspBlocked":true}');
    assert.deepEqual(run.runs(), ["MAIN"]);
});

test("an error the code itself throws is never taken for a CSP refusal", async () => {
    const run = backgroundHarness();
    // A CSP message from a runtime failure (a blocked fetch, say) arrives after
    // the code has begun, so running it again in another world would repeat
    // its side effects.
    const code = "throw new Error(\"Refused to connect because it violates the Content Security Policy directive 'unsafe-eval'\")";

    await assert.rejects(run(code), /Content Security Policy directive/);
    assert.deepEqual(run.runs(), ["MAIN"]);
});

test("an ordinary page still runs in the page world with no note", async () => {
    const run = backgroundHarness();
    assert.equal(await run("1 + 1"), "2");
});

// ─── Where the code runs is settled before it runs ──────────────────

test("a page that makes a finished run look like a refusal does not get the code run again", async () => {
    // The page answers every promise with a forged refusal. This used to send
    // code that had already run in the page to run again in the isolated world.
    const run = backgroundHarness({
        pageScript: `const originalThen = Promise.prototype.then;
            let forged = false;
            Promise.prototype.then = function (onFulfilled, onRejected) {
                if (forged) return originalThen.call(this, onFulfilled, onRejected);
                forged = true;
                return originalThen.call(this, () => ({ ok: false, error: "unsafe-eval", cspBlocked: true }));
            };`,
    });
    await run("window.count = (window.count || 0) + 1").catch(() => {});
    assert.deepEqual(run.runs(), ["MAIN"]);
    assert.equal(vm.runInContext("window.count", run.page), 1);
});

test("the page's string built-ins play no part in deciding", async () => {
    // The sources are built in the background, so a page that makes `trim` or
    // `replace` throw an EvalError cannot pass for a refusal.
    const run = backgroundHarness({
        pageScript: `String.prototype.trim = function () { throw new EvalError("unsafe-eval"); };
            String.prototype.replace = function () { throw new EvalError("unsafe-eval"); };`,
    });
    assert.equal(await run("6 * 7"), "42");
    assert.deepEqual(run.runs(), ["MAIN"]);
});

test("a page that refuses, really or not, gets the code run once, in the isolated world", async () => {
    // A page can always refuse for real, since it sets its own CSP, so a fake
    // refusal gets it nothing a real one would not. Either way: one run.
    for (const options of [
        { cspBlockedWorlds: ["MAIN"] },
        { pageScript: `Function = function () { throw new EvalError("unsafe-eval"); };` },
    ]) {
        const run = backgroundHarness(options);
        assert.match(await run("1 + 1"), /^2\n\n\[Ran in the extension's isolated world/);
        assert.deepEqual(run.runs(), ["ISOLATED"]);
    }
});

test("a syntax error is reported from the page world, never moved", async () => {
    const run = backgroundHarness({
        pageScript: "Object.defineProperty(EvalError, Symbol.hasInstance, { value: () => false, configurable: true })",
    });
    await assert.rejects(run("return ("), (err) => !/isolated|Content Security Policy/.test(String(err.message)));
    assert.deepEqual(run.runs(), ["MAIN"]);
});
