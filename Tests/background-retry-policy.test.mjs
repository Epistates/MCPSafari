import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { handshakeGlobals } from "./helpers/bridge-handshake.mjs";
import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

// `withRetries` is the one place the background script decides how to ask over a
// channel that can lose replies: how long an attempt may take, how many there
// are, and how long it waits between them. Safari's native messaging is such a
// channel (#168).

const source = backgroundScriptSource();

const settle = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

/// A loaded background page, once its own startup read has finished.
async function loadBackground() {
    const timers = [];
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    };
    const context = vm.createContext({
        ...handshakeGlobals,
        browser,
        clearTimeout: (id) => { if (timers[id]) timers[id].cancelled = true; },
        console: { error() {}, log() {}, warn() {} },
        Date,
        Promise,
        setTimeout: (callback, ms) => timers.push({ callback, ms, cancelled: false, ran: false }) - 1,
        WebSocket: class {},
    });
    vm.runInContext(source, context);
    await settle();
    return {
        context,
        // A class is not a property of the global object, so it is read by name.
        ReplyLost: vm.runInContext("ReplyLost", context),
        evaluate: (expression) => vm.runInContext(expression, context),
        /// Lets every pending timer that `which` accepts run out.
        async elapse(which = () => true) {
            for (const timer of [...timers]) {
                if (timer.ran || timer.cancelled || !which(timer.ms)) continue;
                timer.ran = true;
                timer.callback();
                await settle();
            }
        },
        pending: () => timers.filter((timer) => !timer.ran && !timer.cancelled).map((timer) => timer.ms),
        /// Lets time pass until nothing is waiting, as a clock would.
        async drain() {
            for (let round = 0; round < 20 && this.pending().length > 0; round += 1) await this.elapse();
        },
    };
}

const POLICY = { deadlineMs: 1000, attempts: 3, minPauseMs: 100, maxPauseMs: 500 };
const never = () => new Promise(() => {});

test("an attempt that answers is returned at once, with no retry and nothing left pending", async () => {
    const harness = await loadBackground();
    let attempts = 0;
    const reply = await harness.context.withRetries(async () => { attempts += 1; return "answer"; }, POLICY);

    assert.equal(reply, "answer");
    assert.equal(attempts, 1);
    assert.deepEqual(harness.pending(), [], "the deadline is cleared once the answer is in");
});

test("an attempt that runs past its deadline is lost, and the next goes out after a pause", async () => {
    const harness = await loadBackground();
    const calls = [];
    const result = harness.context.withRetries((attempt) => {
        calls.push(attempt);
        return attempt === 1 ? never() : Promise.resolve(`answer ${attempt}`);
    }, POLICY, () => 0.5);
    await settle();
    assert.deepEqual(calls, [1]);

    await harness.elapse((ms) => ms === POLICY.deadlineMs);
    assert.deepEqual(harness.pending(), [300], "the pause is drawn from the policy's range");
    assert.deepEqual(calls, [1], "nothing is sent during the pause");

    await harness.elapse();
    assert.equal(await result, "answer 2");
    assert.deepEqual(calls, [1, 2]);
});

test("a reply that isn't this request's answer counts as lost", async () => {
    const harness = await loadBackground();
    const result = harness.context.withRetries(async (attempt) => {
        if (attempt === 1) throw new harness.ReplyLost("answered another request");
        return "mine";
    }, POLICY, () => 0);
    await settle();
    assert.deepEqual(harness.pending(), [POLICY.minPauseMs]);

    await harness.elapse();
    assert.equal(await result, "mine");
});

test("after the last attempt it gives up with ReplyLost, rather than waiting for good", async () => {
    const harness = await loadBackground();
    let attempts = 0;
    const result = harness.context.withRetries(() => { attempts += 1; return never(); }, POLICY, () => 1);
    const outcome = result.then(() => "resolved", (error) => error);

    await harness.drain();

    const error = await outcome;
    assert.ok(error instanceof harness.ReplyLost, String(error));
    assert.equal(attempts, POLICY.attempts);
    assert.deepEqual(harness.pending(), []);
});

test("a real failure is passed on at once: retrying can't fix it", async () => {
    const harness = await loadBackground();
    let attempts = 0;
    const error = await harness.context.withRetries(async () => {
        attempts += 1;
        throw new Error("native messaging is not supported");
    }, POLICY).then(() => null, (failure) => failure);

    assert.equal(error.message, "native messaging is not supported");
    assert.equal(attempts, 1);
});

test("the native policy leaves room for a cold start, and bounds a whole read to a few seconds", async () => {
    const harness = await loadBackground();
    const policy = harness.evaluate("NATIVE_REQUEST_POLICY");
    // A running handler answers in tens of milliseconds, a cold start of the app
    // extension in a few hundred.
    assert.ok(policy.deadlineMs >= 1000, `deadline ${policy.deadlineMs} ms`);
    const worst = policy.attempts * policy.deadlineMs + (policy.attempts - 1) * policy.maxPauseMs;
    // The server waits about 40 s for Safari after it starts: one 30 s keepalive,
    // the read's spread, and this.
    assert.ok(worst <= 6000, `a whole read can take ${worst} ms`);
    assert.ok(Object.isFrozen(policy));
});
