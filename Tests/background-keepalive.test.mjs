import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/background.js", import.meta.url),
    "utf8"
);

const PORT = 8089;

// The keepalive both reconnects and prunes, and the prune records the live token
// as stale, which the extension then refuses to dial again. The server only
// mints a new token when it restarts, so a wrong decision here is not something
// that recovers on its own.
function loadBackground() {
    const sockets = [];
    const timers = [];
    let alarmListener = null;
    let clock = 1_000_000;

    class FakeWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        constructor(url) {
            this.url = url;
            this.readyState = FakeWebSocket.CONNECTING;
            this.closed = false;
            this.sent = [];
            sockets.push(this);
        }
        send(frame) { this.sent.push(frame); }
        close() { this.closed = true; this.readyState = 3; }
    }

    const browser = {
        alarms: {
            create() {},
            onAlarm: { addListener: (listener) => { alarmListener = listener; } },
        },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: { [PORT]: "token-one" } }),
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
        browser,
        clearTimeout() {},
        console: { error() {}, log() {}, warn() {} },
        // Only `Date.now` is read, and the tests have to be able to move it.
        Date: { now: () => clock },
        Promise,
        // Queued rather than run: the backoff reconnect is not what is under
        // test, and letting it fire would create sockets mid-assertion.
        setTimeout: (callback) => { timers.push(callback); return timers.length - 1; },
        WebSocket: FakeWebSocket,
    });
    vm.runInContext(source, context);

    const harness = {
        evaluate: (expression) => vm.runInContext(expression, context),
        advance(ms) { clock += ms; },
        async settle() {
            for (let attempt = 0; attempt < 50; attempt += 1) {
                await new Promise((resolve) => setImmediate(resolve));
            }
        },
        async fireKeepalive() {
            alarmListener({ name: "mcp-keepalive" });
            await harness.settle();
        },
        /// Takes the newest socket through the handshake, leaving the port in
        /// the state a working server produces.
        async authenticate() {
            for (let attempt = 0; attempt < 50 && sockets.length === 0; attempt += 1) {
                await new Promise((resolve) => setImmediate(resolve));
            }
            const socket = sockets.at(-1);
            socket.readyState = FakeWebSocket.OPEN;
            socket.onopen();
            socket.onmessage({ data: JSON.stringify({ auth: "ok" }) });
            await harness.settle();
            return socket;
        },
        sockets,
    };
    return harness;
}

test("a long-lived server is not suppressed the first time its socket drops", async () => {
    const harness = loadBackground();
    const socket = await harness.authenticate();
    assert.equal(harness.evaluate(`connections.get(${PORT}).state`), "connected");

    // Up for well past the two-minute grace, which is the ordinary case.
    harness.advance(5 * 60_000);
    // Safari suspending the background page is what closes this, and the
    // comment on the prune calls that the normal reason.
    socket.onclose();
    await harness.settle();

    await harness.fireKeepalive();

    // The prune used to read `lastConnected`, which is when the port
    // authenticated and is never refreshed, as though it were "last seen". Any
    // server up longer than the grace period was dropped on its first blip, its
    // live token recorded as stale, and never dialled again.
    assert.ok(harness.evaluate(`connections.has(${PORT})`), "the port is still managed");
    assert.ok(!harness.evaluate(`staleTokensByPort.has(${PORT})`), "its live token is not stale");
});

test("a server that really has been gone for the grace period is suppressed", async () => {
    const harness = loadBackground();
    const socket = await harness.authenticate();

    socket.onclose();
    await harness.settle();
    // Now the time passes, with nothing on the other end.
    harness.advance(5 * 60_000);

    await harness.fireKeepalive();

    assert.ok(!harness.evaluate(`connections.has(${PORT})`), "a gone server is given up on");
    assert.ok(harness.evaluate(`staleTokensByPort.has(${PORT})`));
});

test("suppressing a port closes its socket rather than orphaning it", async () => {
    const harness = loadBackground();
    const socket = await harness.authenticate();

    socket.onclose();
    await harness.settle();
    harness.advance(5 * 60_000);
    await harness.fireKeepalive();

    // The reconnect in the same tick opens a fresh socket before the prune
    // runs. Dropping the record without closing it left one authenticating and
    // answering requests with nothing tracking it.
    const orphan = harness.sockets.at(-1);
    assert.ok(orphan.closed, "the socket the prune left behind is closed");
});
