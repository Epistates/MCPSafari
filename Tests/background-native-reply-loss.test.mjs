import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { handshakeGlobals } from "./helpers/bridge-handshake.mjs";
import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// Safari loses the reply to one of two native messages in flight at once, and
// every profile's keepalive alarm fires in the same millisecond. Before these, the
// profile whose read was lost waited a whole keepalive, often several, to find a
// new server (#168). These pin the recovery: a lost reply is sent again, one page
// never has two reads of its own in flight, and a reply to another request is not
// taken for this one's.

const settle = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

/**
 * A background page whose native handler answers each request through `answer`,
 * which gets the message and how many came before it, and returns a reply, or
 * `undefined` for a reply Safari loses (a promise that never settles).
 */
function loadBackground(answer) {
    const sockets = [];
    const sent = [];
    const timers = [];
    let alarmListener = null;

    class FakeWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        constructor(url) {
            this.url = url;
            this.readyState = FakeWebSocket.CONNECTING;
            sockets.push(this);
        }
        send() {}
        close() { this.readyState = 3; }
    }

    const browser = {
        alarms: {
            create() {},
            onAlarm: { addListener: (listener) => { alarmListener = listener; } },
        },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: (_application, message) => {
                sent.push(message);
                const reply = answer(message, sent.length - 1);
                return reply === undefined ? new Promise(() => {}) : Promise.resolve(reply);
            },
        },
        scripting: { executeScript: async () => [{ result: true }] },
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

    const context = vm.createContext({
        ...handshakeGlobals,
        browser,
        clearTimeout: (id) => { if (timers[id]) timers[id].cancelled = true; },
        console: { error() {}, log() {}, warn() {} },
        Date,
        Promise,
        setTimeout: (callback, ms) => timers.push({ callback, ms, cancelled: false, ran: false }) - 1,
        WebSocket: FakeWebSocket,
    });
    vm.runInContext(source, context);

    return {
        evaluate: (expression) => vm.runInContext(expression, context),
        sent,
        sockets,
        timers,
        dialledPorts: () => sockets.map((socket) => Number(new URL(socket.url).port)),
        policy: vm.runInContext("NATIVE_REQUEST_POLICY", context),
        /// Runs every pending timer whose delay `which` accepts, as time passing would.
        async runTimers(which = () => true) {
            for (const timer of [...timers]) {
                if (timer.ran || timer.cancelled || !which(timer.ms)) continue;
                timer.ran = true;
                timer.callback();
                await settle();
            }
        },
        fireKeepalive() { alarmListener({ name: "mcp-keepalive" }); },
        /// The deadline on one request running out.
        missDeadline() { return this.runTimers((ms) => ms === this.policy.deadlineMs); },
        /// The pause before a lost request is sent again.
        pauseBeforeRetry() { return this.runTimers((ms) => ms >= this.policy.minPauseMs && ms <= this.policy.maxPauseMs); },
    };
}

const tokensReply = (message, tokens, profile = "PROFILE-A") => ({ tokens, profile, nonce: message.nonce });

test("a token read whose reply Safari loses is sent again, and the server it names is dialled", async () => {
    // The first read at startup collides with another profile's and is lost.
    const harness = loadBackground((message, index) => (index === 0 ? undefined : tokensReply(message, { 8091: "token" })));
    await settle();
    assert.deepEqual(harness.dialledPorts(), []);

    await harness.missDeadline();
    await harness.pauseBeforeRetry();

    assert.equal(harness.sent.length, 2);
    assert.notEqual(harness.sent[1].nonce, harness.sent[0].nonce, "each send is its own request");
    assert.deepEqual(harness.dialledPorts(), [8091]);
});

test("every caller shares the read in flight rather than starting a second one", async () => {
    let resolveFirst;
    const harness = loadBackground((message, index) => (index === 0
        ? new Promise((resolve) => { resolveFirst = () => resolve(tokensReply(message, { 8091: "token" })); })
        : tokensReply(message, { 8091: "token" })));
    await settle();

    // A popup refresh and a reconnect arriving while the startup read is out.
    const second = harness.evaluate("loadAuthTokens()");
    const third = harness.evaluate("loadAuthTokens()");
    assert.equal(harness.sent.length, 1, "a second request in flight is the collision that loses a reply");

    resolveFirst();
    await Promise.all([second, third]);
    await settle();
    assert.deepEqual(harness.dialledPorts(), [8091]);

    // Once it is done, the next caller reads afresh.
    await harness.evaluate("loadAuthTokens()");
    assert.equal(harness.sent.length, 2);
});

test("a reply to another request is not taken for this one's", async () => {
    const harness = loadBackground((message, index) => (index === 0
        ? { tokens: { 9999: "theirs" }, profile: "SOMEONE-ELSE", nonce: "a-different-request" }
        : tokensReply(message, { 8091: "token" }, "PROFILE-A")));
    await settle();
    await harness.pauseBeforeRetry();

    assert.equal(harness.evaluate("profileId"), "PROFILE-A", "another profile's identity would make the server evict this one");
    assert.deepEqual(harness.dialledPorts(), [8091]);
});

test("a reply from a handler that predates the echo is accepted", async () => {
    const harness = loadBackground(() => ({ tokens: { 8091: "token" }, profile: "PROFILE-A" }));
    await settle();

    assert.equal(harness.sent.length, 1);
    assert.equal(harness.evaluate("profileId"), "PROFILE-A");
    assert.deepEqual(harness.dialledPorts(), [8091]);
});

test("a handler that never answers is given up on until the next read, not waited on for good", async () => {
    const harness = loadBackground(() => undefined);
    await settle();
    for (let round = 0; round < harness.policy.attempts; round += 1) {
        await harness.missDeadline();
        await harness.pauseBeforeRetry();
    }
    assert.equal(harness.sent.length, harness.policy.attempts);

    // The read finished, so the next one is a new request rather than the stuck one.
    harness.evaluate("loadAuthTokens()");
    assert.equal(harness.sent.length, harness.policy.attempts + 1);
});

test("the keepalive reads a moment after the alarm, not on it", async () => {
    const harness = loadBackground((message) => tokensReply(message, { 8091: "token" }));
    await settle();
    const before = harness.sent.length;

    harness.fireKeepalive();
    await settle();
    assert.equal(harness.sent.length, before, "every profile's alarm fires together, so reading on it collides");

    const pause = harness.timers.at(-1).ms;
    const spread = harness.evaluate("KEEPALIVE_READ_SPREAD_MS");
    assert.ok(pause >= 0 && pause < spread, `read offset ${pause} ms`);
    await harness.runTimers((ms) => ms === pause);
    assert.equal(harness.sent.length, before + 1);
});
