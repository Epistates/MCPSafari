import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { handshakeGlobals, serverHandshake } from "./helpers/bridge-handshake.mjs";
import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// How many ports the server tries is a setting (#155), and the extension has no
// matching one. It dials whichever ports have a token file, because a server
// writes a token for the port it actually bound and nothing else could be
// authenticated anyway. These pin that: any port with a token is dialled, with
// no range in the way, and the only bound is on how many connection objects a
// directory full of files can create.

const settle = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

function loadBackground(initialTokens = {}, { manualPorts = [] } = {}) {
    const tokenMap = new Map(Object.entries(initialTokens));
    const sockets = [];
    const warnings = [];
    const runtimeListeners = [];
    let alarmListener = null;

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
            onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
            // What the native handler does: the map when there is any token file,
            // and `no_token_files` when there is none.
            sendNativeMessage: async () => tokenMap.size === 0
                ? { error: "no_token_files" }
                : { tokens: Object.fromEntries(tokenMap) },
        },
        scripting: { executeScript: async () => [{ result: true }] },
        storage: {
            local: {
                get: async (key) => (key === "manualPorts" ? { manualPorts } : {}),
                set() {},
            },
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
        clearTimeout() {},
        console: { error() {}, log() {}, warn: (...args) => warnings.push(args.join(" ")) },
        Date,
        Promise,
        // Queued, never run: a backoff reconnect is not what is under test.
        setTimeout: () => 0,
        WebSocket: FakeWebSocket,
    });
    vm.runInContext(source, context);

    const harness = {
        evaluate: (expression) => vm.runInContext(expression, context),
        tokenMap,
        sockets,
        warnings,
        /// The ports the popup would list. Copied into this realm's array, which
        /// is the one `deepEqual` compares against.
        visiblePorts: () => Array.from(
            harness.evaluate("visibleConnectionStatuses()"),
            ({ port }) => port
        ),
        dialledPorts: () => sockets.map((socket) => Number(new URL(socket.url).port)),
        async keepalive() {
            alarmListener({ name: "mcp-keepalive" });
            await settle();
        },
        addPort(port) {
            runtimeListeners[0]({ type: "addPort", port: String(port) }, {}, () => {});
            return settle();
        },
        async authenticate(port, token) {
            const socket = sockets.findLast((candidate) => candidate.url.endsWith(`:${port}`));
            socket.readyState = FakeWebSocket.OPEN;
            socket.onopen();
            await serverHandshake(socket, { token, port });
            await settle();
            return socket;
        },
    };
    return harness;
}

test("a port nowhere near the default is dialled without being configured", async () => {
    // A server started with --port 9000, and one that fell back past the old
    // eighth-port window, both write a token for the port they bound.
    const harness = loadBackground({ 8089: "token-a", 8104: "token-b", 9000: "token-c" });
    await settle();

    assert.deepEqual(harness.dialledPorts().sort(), [8089, 8104, 9000]);
    assert.deepEqual(harness.visiblePorts().sort(), [8089, 8104, 9000]);
});

test("a server that comes up later is found on the next keepalive", async () => {
    const harness = loadBackground();
    await settle();
    assert.equal(harness.sockets.length, 0);

    harness.tokenMap.set("9003", "token");
    await harness.keepalive();

    assert.deepEqual(harness.dialledPorts(), [9003]);
});

test("with no server running there is nothing to dial and nothing listed", async () => {
    // A fixed window used to create a connection for each of ten ports up front.
    const harness = loadBackground();
    await settle();

    assert.equal(harness.evaluate("connections.size"), 0);
    assert.equal(harness.sockets.length, 0);
    assert.deepEqual(harness.visiblePorts(), []);
});

test("a token directory full of files cannot create unbounded connections", async () => {
    const tokens = Object.fromEntries(
        Array.from({ length: 200 }, (_, offset) => [9000 + offset, `token-${offset}`])
    );
    const harness = loadBackground(tokens);
    await settle();

    assert.equal(harness.evaluate("connections.size"), 64);
    assert.equal(harness.sockets.length, 64);
    // The same 64 each time, not whichever the directory listed first.
    const dialled = harness.dialledPorts().sort((a, b) => a - b);
    assert.equal(dialled[0], 9000);
    assert.equal(dialled.at(-1), 9063);
    assert.ok(harness.warnings.some((line) => line.includes("136")), "the ports left out are reported");

    // Reading again changes nothing.
    await harness.keepalive();
    assert.equal(harness.evaluate("connections.size"), 64);
});

test("a port added by hand is not held to the cap", async () => {
    const tokens = Object.fromEntries(
        Array.from({ length: 70 }, (_, offset) => [9000 + offset, `token-${offset}`])
    );
    tokens[9500] = "manual-token";
    const harness = loadBackground(tokens, { manualPorts: [9500] });
    await settle();

    assert.ok(harness.evaluate("connections.has(9500)"));
    assert.ok(harness.dialledPorts().includes(9500));
    assert.equal(harness.evaluate("discoveredPortCount()"), 64);
});

test("a port that loses its token loses its connection", async () => {
    const harness = loadBackground({ 9000: "token-a", 9001: "token-b" });
    await settle();
    assert.deepEqual(harness.visiblePorts().sort(), [9000, 9001]);

    harness.tokenMap.delete("9000");
    await harness.keepalive();

    assert.ok(!harness.evaluate("connections.has(9000)"), "the dead port is dropped");
    assert.ok(harness.sockets.find((socket) => socket.url.endsWith(":9000")).closed, "and its socket closed");
    assert.deepEqual(harness.visiblePorts(), [9001]);
});

test("the last server stopping is noticed, not mistaken for a failed read", async () => {
    // With no token file at all the handler sends no map, only an error, and
    // taking that for a failed read left the final server's port in place forever.
    const harness = loadBackground({ 9000: "token" });
    await settle();

    harness.tokenMap.clear();
    await harness.keepalive();

    assert.equal(harness.evaluate("connections.size"), 0);
    assert.deepEqual(harness.visiblePorts(), []);
});

test("a token that goes away frees its slot for another", async () => {
    const tokens = Object.fromEntries(
        Array.from({ length: 64 }, (_, offset) => [9000 + offset, `token-${offset}`])
    );
    const harness = loadBackground(tokens);
    await settle();

    harness.tokenMap.delete("9000");
    harness.tokenMap.set("9100", "late");
    await harness.keepalive();

    assert.ok(!harness.evaluate("connections.has(9000)"));
    assert.ok(harness.evaluate("connections.has(9100)"));
    assert.equal(harness.evaluate("connections.size"), 64);
});

test("an authenticated socket outlives its token file until it closes", async () => {
    // The token is only needed to dial, and a read that finds none is a server
    // stopping or a directory changing under us; the socket says which, by closing.
    const harness = loadBackground({ 9000: "token" });
    await settle();
    const socket = await harness.authenticate(9000, "token");
    assert.equal(harness.evaluate("connections.get(9000).state"), "connected");

    harness.tokenMap.clear();
    await harness.keepalive();
    assert.ok(harness.evaluate("connections.has(9000)"), "still connected, so still managed");
    assert.ok(!socket.closed);

    socket.onclose();
    await settle();
    await harness.keepalive();
    assert.ok(!harness.evaluate("connections.has(9000)"), "gone once the socket is");
});

test("a port added by hand survives having no token", async () => {
    const harness = loadBackground();
    await settle();

    await harness.addPort(9100);
    await harness.keepalive();

    assert.ok(harness.evaluate("connections.has(9100)"));
    assert.ok(harness.evaluate("connections.get(9100).manual"));
    assert.deepEqual(harness.visiblePorts(), [9100]);
});

test("a port restored from storage survives having no token", async () => {
    const harness = loadBackground({}, { manualPorts: [9200] });
    await settle();
    await harness.keepalive();

    assert.ok(harness.evaluate("connections.has(9200)"));
    assert.deepEqual(harness.visiblePorts(), [9200]);
});

test("a port that has a token and was added by hand stays when the token goes", async () => {
    const harness = loadBackground({ 9300: "token" });
    await settle();
    await harness.addPort(9300);

    harness.tokenMap.clear();
    await harness.keepalive();

    assert.ok(harness.evaluate("connections.has(9300)"));
});
