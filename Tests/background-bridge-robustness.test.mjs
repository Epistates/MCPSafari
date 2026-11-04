import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { handshakeGlobals, serverHandshake } from "./helpers/bridge-handshake.mjs";
import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

const PORT = 8089;
const TOKEN = "token-one";
// The one timer in the bridge that is not a reconnect backoff.
const HANDSHAKE_LIMIT_MS = 5000;

const settle = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

// The socket as a browser has it, including the stretch between asking to close
// and being closed that a stub which jumps straight to CLOSED hides. Sending on
// anything but an open socket throws, as it does in Safari.
class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url, sockets) {
        this.url = url;
        this.readyState = FakeWebSocket.CONNECTING;
        this.sent = [];
        this.closeRequested = false;
        sockets.push(this);
    }
    send(frame) {
        if (this.readyState !== FakeWebSocket.OPEN) throw new Error("InvalidStateError");
        this.sent.push(frame);
    }
    close() {
        this.closeRequested = true;
        if (this.readyState !== FakeWebSocket.CLOSED) this.readyState = FakeWebSocket.CLOSING;
    }
    /// The browser finishing the close: the state changes, then the event fires.
    finishClose() {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.();
    }
}

function loadBackground({ tokens = { [PORT]: TOKEN } } = {}) {
    const state = { tokens };
    const sockets = [];
    const timers = [];
    const runtimeListeners = [];
    let alarmListener = null;

    const browser = {
        alarms: {
            create() {},
            onAlarm: { addListener: (listener) => { alarmListener = listener; } },
        },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
            sendNativeMessage: async () => Object.keys(state.tokens).length === 0
                ? { error: "no_token_files" }
                : { tokens: state.tokens },
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
        clearTimeout: (id) => { const timer = timers[id]; if (timer) timer.cancelled = true; },
        console: { error() {}, log() {}, warn() {} },
        Date,
        Promise,
        // Queued with the delay asked for, so a test runs the reconnect backoff or
        // the handshake limit without waiting for either.
        setTimeout: (callback, ms) => {
            timers.push({ callback, ms, cancelled: false, ran: false });
            return timers.length - 1;
        },
        WebSocket: class extends FakeWebSocket {
            constructor(url) { super(url, sockets); }
        },
    });
    vm.runInContext(source, context);

    const harness = {
        evaluate: (expression) => vm.runInContext(expression, context),
        sockets,
        timers,
        setHandleRequest(handler) { context.handleRequest = handler; },
        setTokens(tokens) { state.tokens = tokens; },
        /// Runs the pending reconnect backoff timers, or the handshake limit when `handshake` is set.
        async runTimers({ handshake = false } = {}) {
            for (const timer of [...timers]) {
                if (timer.ran || timer.cancelled) continue;
                if ((timer.ms === HANDSHAKE_LIMIT_MS) !== handshake) continue;
                timer.ran = true;
                await timer.callback();
            }
            await settle();
        },
        async keepalive() {
            alarmListener({ name: "mcp-keepalive" });
            await settle();
        },
        message(message) {
            runtimeListeners[0](message, {}, () => {});
            return settle();
        },
        async authenticate(socket = sockets.at(-1)) {
            socket.readyState = FakeWebSocket.OPEN;
            socket.onopen();
            await serverHandshake(socket, { token: TOKEN, port: PORT });
            await settle();
            return socket;
        },
        /// Delivers a request on an authenticated socket and waits for the extension to finish with it.
        request(socket, request = { id: "r1", action: "anything", params: {} }) {
            return socket.onmessage({ data: JSON.stringify(request) });
        },
    };
    return harness;
}

async function refuseUntilSuppressed(harness) {
    // Each refusal closes the socket before it was ever accepted.
    for (let attempt = 0; attempt < 10 && harness.evaluate(`connections.has(${PORT})`); attempt += 1) {
        harness.sockets.at(-1).finishClose();
        await settle();
        await harness.runTimers();
    }
}

// ─── BR1: a refusal is not a verdict ─────────────────────────────────

test("a port that refused every dial is tried again on the next keepalive", async () => {
    const harness = loadBackground();
    await settle();
    await refuseUntilSuppressed(harness);

    assert.ok(!harness.evaluate(`connections.has(${PORT})`), "the port was suppressed after repeated refusals");
    const before = harness.sockets.length;

    // Its token file never went anywhere, so the server may well be there. Giving
    // up for good here was the whole defect: only a restart of Safari brought the
    // extension back.
    await harness.keepalive();

    assert.ok(harness.sockets.length > before, "a fresh dial was made");
    assert.ok(harness.evaluate(`connections.has(${PORT})`), "the port is managed again");
});

test("a suppressed port whose token file is gone is not brought back", async () => {
    const harness = loadBackground();
    await settle();
    await refuseUntilSuppressed(harness);
    const before = harness.sockets.length;

    // The server stopped and removed its file.
    harness.setTokens({});
    await harness.keepalive();

    assert.equal(harness.sockets.length, before, "nothing is dialled");
    assert.ok(!harness.evaluate(`connections.has(${PORT})`));
    assert.ok(!harness.evaluate(`staleTokensByPort.has(${PORT})`), "and nothing is remembered about it");
});

// ─── BR2: a socket on its way out is not dialled over ───────────────

test("a reconnect asked for while the old socket is closing does not dial a second one", async () => {
    const harness = loadBackground();
    await settle();
    const old = await harness.authenticate();

    await harness.message({ type: "reconnect", port: String(PORT) });

    // The close has been asked for and has not happened. A new socket here is the
    // second of three the live one gets lost between.
    assert.equal(old.readyState, FakeWebSocket.CLOSING);
    assert.equal(harness.sockets.length, 1, "no dial while the old socket is still closing");

    old.finishClose();
    await settle();
    await harness.runTimers();

    assert.equal(harness.sockets.length, 2, "one new dial once the old one has gone");
    assert.equal(harness.evaluate(`connections.get(${PORT}).ws`), harness.sockets[1]);
});

test("an older socket closing late leaves the one that replaced it alone", async () => {
    const harness = loadBackground();
    await settle();
    const old = await harness.authenticate();

    // Dead without having reported it, so the next reconnect pass redials.
    old.readyState = FakeWebSocket.CLOSED;
    await harness.keepalive();
    const live = harness.sockets.at(-1);
    assert.notEqual(live, old);
    assert.equal(harness.evaluate(`connections.get(${PORT}).ws`), live);

    // The late close event of the first one. It used to clear `ws` under the live
    // socket and mark the port disconnected, leaving nothing that owned it.
    old.onclose();
    await settle();

    assert.equal(harness.evaluate(`connections.get(${PORT}).ws`), live);
    assert.equal(harness.evaluate(`connections.get(${PORT}).state`), "connecting");
});

// ─── BR-send and BR-size: what leaves is well formed and bounded ────

const frames = (socket) => socket.sent.map((frame) => JSON.parse(frame));
const lastFrame = (socket) => frames(socket).at(-1);

async function authenticatedWithReply(reply) {
    const harness = loadBackground();
    await settle();
    const socket = await harness.authenticate();
    harness.setHandleRequest(async () => reply);
    return { harness, socket };
}

test("a lone surrogate in a reply is sent as the replacement character", async () => {
    const { harness, socket } = await authenticatedWithReply({
        id: "r1",
        success: true,
        // A string cut through the middle of an emoji, which JSON.stringify writes as `\ud83d`.
        data: { text: "ok \ud83d" },
    });
    await harness.request(socket);

    const sent = socket.sent.at(-1);
    // The text the server's decoder sees, before anything parses it.
    assert.ok(!/\\u[dD][89abAB]/.test(sent), `a surrogate escape is still on the wire: ${sent}`);
    assert.equal(lastFrame(socket).data.text, "ok �");
});

test("a lone surrogate in a key is replaced too", async () => {
    const { harness, socket } = await authenticatedWithReply({
        id: "r1",
        success: true,
        data: { ["key\udc00"]: 1 },
    });
    await harness.request(socket);

    const sent = socket.sent.at(-1);
    assert.ok(!/\\u[dD][c-fC-F]/.test(sent), `a surrogate escape is still on the wire: ${sent}`);
    assert.deepEqual(Object.keys(lastFrame(socket).data), ["key�"]);
});

test("well formed text is sent unchanged", async () => {
    const { harness, socket } = await authenticatedWithReply({
        id: "r1",
        success: true,
        data: { text: "café 😀", list: [1, null, "x"] },
    });
    await harness.request(socket);

    assert.deepEqual(lastFrame(socket).data, { text: "café 😀", list: [1, null, "x"] });
});

test("a reply too large for the bridge becomes an error for the same id", async () => {
    const limit = Number(loadBackground().evaluate("MAX_REPLY_BYTES"));
    const { harness, socket } = await authenticatedWithReply({
        id: "r1",
        success: true,
        data: "x".repeat(limit + 1),
        resolvedTabId: 7,
    });
    await harness.request(socket);

    const reply = lastFrame(socket);
    assert.equal(reply.id, "r1");
    assert.equal(reply.success, false);
    assert.equal(reply.errorCode, "response_too_large");
    assert.equal(reply.retryable, false);
    assert.equal(reply.resolvedTabId, 7);
    assert.ok(socket.sent.at(-1).length < 2000, "the error is small");
});

test("size is measured in bytes, not characters", async () => {
    const limit = Number(loadBackground().evaluate("MAX_REPLY_BYTES"));
    // Two bytes each: under the limit as characters, over it as bytes.
    const { harness, socket } = await authenticatedWithReply({
        id: "r1",
        success: true,
        data: "é".repeat(Math.ceil(limit / 2) + 1),
    });
    await harness.request(socket);

    assert.equal(lastFrame(socket).errorCode, "response_too_large");
});

test("a reply just under the limit is sent as it is", async () => {
    const limit = Number(loadBackground().evaluate("MAX_REPLY_BYTES"));
    const { harness, socket } = await authenticatedWithReply({
        id: "r1",
        success: true,
        data: "x".repeat(limit - 1000),
    });
    await harness.request(socket);

    assert.equal(lastFrame(socket).success, true);
});

// ─── BR-throw: a socket that closed under a request ─────────────────

test("a request that finishes after its socket closed is dropped quietly", async () => {
    const harness = loadBackground();
    await settle();
    const socket = await harness.authenticate();

    let finish;
    harness.setHandleRequest(() => new Promise((resolve) => { finish = resolve; }));
    const handling = harness.request(socket);
    await settle();

    // The connection went away while the browser work was still running.
    socket.readyState = FakeWebSocket.CLOSED;
    finish({ id: "r1", success: true, data: "late" });

    // `send` throws on a closed socket, and the catch that answered the first
    // failure then threw as well, out of the message handler.
    await assert.doesNotReject(handling);
});

test("a request that fails after its socket closed is dropped quietly too", async () => {
    const harness = loadBackground();
    await settle();
    const socket = await harness.authenticate();

    let fail;
    harness.setHandleRequest(() => new Promise((_, reject) => { fail = reject; }));
    const handling = harness.request(socket);
    await settle();

    socket.readyState = FakeWebSocket.CLOSED;
    fail(new Error("tab closed"));

    await assert.doesNotReject(handling);
});

// ─── BR9: a listener that never answers ─────────────────────────────

test("a socket the server never finishes the handshake on is closed after the limit", async () => {
    const harness = loadBackground();
    await settle();
    const socket = harness.sockets[0];
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen();

    assert.ok(!socket.closeRequested);
    await harness.runTimers({ handshake: true });

    assert.ok(socket.closeRequested, "the socket is given up on");
    // And the port is dialled again once that completes, instead of waiting on a
    // connection that will never be ready.
    socket.finishClose();
    await settle();
    await harness.runTimers();
    assert.equal(harness.sockets.length, 2);
});

test("an authenticated socket is left alone when the handshake limit passes", async () => {
    const harness = loadBackground();
    await settle();
    const socket = await harness.authenticate();

    await harness.runTimers({ handshake: true });

    assert.ok(!socket.closeRequested);
    assert.equal(harness.evaluate(`connections.get(${PORT}).state`), "connected");
});
