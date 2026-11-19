import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { deliver, handshakeGlobals, serverHandshake } from "./helpers/bridge-handshake.mjs";
import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// Several sessions each run a server, and the popup listed them by port alone,
// so nobody could tell which was which. A server now says who it is in the
// handshake's ok (its --name, the folder it was started in, and the MCP client
// that has introduced itself), and `identify` names a client that introduces
// itself later. These drive the real background scripts through the handshake
// and the request router, and read what the popup is told.

const settle = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

function loadBackground(tokens) {
    const sockets = [];

    class FakeWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        constructor(url) {
            this.url = url;
            this.readyState = FakeWebSocket.CONNECTING;
            this.sent = [];
            sockets.push(this);
        }
        send(frame) { this.sent.push(frame); }
        close() { this.readyState = 3; }
    }

    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens }),
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
        clearTimeout() {},
        console: { error() {}, log() {}, warn() {} },
        Date,
        Promise,
        // Queued, never run: a backoff reconnect is not what is under test.
        setTimeout: () => 0,
        WebSocket: FakeWebSocket,
    });
    vm.runInContext(source, context);

    const evaluate = (expression) => vm.runInContext(expression, context);
    return {
        evaluate,
        /** A value from the background, copied into this realm so `deepEqual` compares it. */
        read: (expression) => JSON.parse(evaluate(`JSON.stringify(${expression})`)),
        /** What the popup is told about `port`. */
        row: (port) => JSON.parse(evaluate(
            `JSON.stringify(visibleConnectionStatuses().find((status) => status.port === ${port}) ?? null)`
        )),
        async authenticate(port, ok) {
            const socket = sockets.findLast((candidate) => candidate.url.endsWith(`:${port}`));
            socket.readyState = FakeWebSocket.OPEN;
            socket.onopen();
            await serverHandshake(socket, { token: tokens[port], port, ok });
            await settle();
            return socket;
        },
        /** Sends `request` down `socket` as the server would, and returns the extension's reply. */
        async ask(socket, request) {
            const before = socket.sent.length;
            await deliver(socket, request);
            await settle();
            assert.equal(socket.sent.length, before + 1, "the extension answered once");
            return JSON.parse(socket.sent.at(-1));
        },
    };
}

const CLAUDE = { name: "claude-code", version: "2.1.0" };

test("a server's name, folder and client arrive with its ok and name its row", async () => {
    const harness = loadBackground({ 8089: "token-a" });
    await settle();

    await harness.authenticate(8089, {
        instance: { name: "marketing", folder: "/Users/me/work/site" },
        client: CLAUDE,
    });

    assert.deepEqual(harness.read("connections.get(8089).instance"), { name: "marketing", folder: "/Users/me/work/site" });
    assert.deepEqual(harness.read("connections.get(8089).client"), CLAUDE);
    assert.deepEqual(harness.row(8089), {
        port: 8089,
        state: "connected",
        manual: false,
        label: "marketing",
        folder: "/Users/me/work/site",
        client: CLAUDE,
    });
});

test("with no name, the last part of the folder names the connection", async () => {
    const harness = loadBackground({ 8089: "token-a" });
    await settle();

    // No client yet either: it had not introduced itself when Safari connected.
    await harness.authenticate(8089, { instance: { folder: "/Users/me/work/bookof/" } });

    const row = harness.row(8089);
    assert.equal(row.label, "bookof");
    assert.equal(row.folder, "/Users/me/work/bookof");
    assert.equal(row.client, null);
});

test("an older server says nothing about itself, and its row is named by its port", async () => {
    const harness = loadBackground({ 8089: "token-a" });
    await settle();

    await harness.authenticate(8089);

    assert.equal(harness.evaluate("connections.get(8089).instance"), null);
    assert.equal(harness.evaluate("connections.get(8089).client"), null);
    const row = harness.row(8089);
    assert.equal(row.label, "port 8089");
    assert.equal(row.folder, null);
    assert.equal(row.client, null);
});

test("identify names the client of the connection it came in on, and only that one", async () => {
    const harness = loadBackground({ 8089: "token-a", 8090: "token-b" });
    await settle();
    const alpha = await harness.authenticate(8089, { instance: { folder: "/w/alpha" } });
    await harness.authenticate(8090, { instance: { folder: "/w/beta" } });

    const reply = await harness.ask(alpha, { id: "r1", action: "identify", params: { client: CLAUDE } });

    assert.equal(reply.id, "r1");
    assert.equal(reply.success, true, reply.error);
    // It touches no tab, so none is resolved for it.
    assert.equal(reply.resolvedTabId, null);
    assert.deepEqual(harness.row(8089).client, CLAUDE);
    assert.equal(harness.row(8090).client, null);

    // A client that says nothing usable is forgotten rather than kept.
    await harness.ask(alpha, { id: "r2", action: "identify", params: { client: { name: 7 } } });
    assert.equal(harness.row(8089).client, null);
});

test("what a server says about itself is dropped when it is the wrong shape", async () => {
    const harness = loadBackground({ 8089: "token-a", 8090: "token-b", 8091: "token-c" });
    await settle();

    // A name too long, and one carrying a control character that could rewrite
    // the row it is shown in, both give way to the folder.
    await harness.authenticate(8089, {
        instance: { name: "x".repeat(65), folder: "/w/kept", extra: "ignored" },
        client: { name: "y".repeat(101) },
    });
    await harness.authenticate(8090, { instance: { name: "a\u202Eb", folder: "/w/also" } });
    // A relative folder, and the root a client with no project starts a server
    // in, say nothing about who it is.
    await harness.authenticate(8091, { instance: { folder: "/" }, client: "claude-code" });

    assert.deepEqual(harness.read("connections.get(8089).instance"), { name: null, folder: "/w/kept" });
    assert.equal(harness.row(8089).label, "kept");
    assert.equal(harness.row(8089).client, null);
    assert.equal(harness.row(8090).label, "also");
    assert.equal(harness.row(8091).label, "port 8091");
    assert.equal(harness.row(8091).folder, null);
    assert.equal(harness.row(8091).client, null);

    harness.evaluate(`connections.get(8091).instance = readInstanceIdentity({ folder: "work/relative" })`);
    assert.equal(harness.row(8091).label, "port 8091");
    assert.equal(harness.row(8091).folder, null);
});

test("a port that is not connected carries no name, and a new run starts from nothing", async () => {
    const harness = loadBackground({ 8089: "token-a" });
    await settle();
    const first = await harness.authenticate(8089, { instance: { name: "alpha", folder: "/w/alpha" }, client: CLAUDE });

    // The server goes away. Whoever comes back on the port may be someone else.
    first.onclose();
    const gone = harness.row(8089);
    assert.equal(gone.state, "disconnected");
    assert.equal(gone.label, null);
    assert.equal(gone.folder, null);
    assert.equal(gone.client, null);

    // An older server takes the port: nothing of the last one carries over.
    harness.evaluate("connectToPort(8089)");
    await harness.authenticate(8089);
    const next = harness.row(8089);
    assert.equal(next.state, "connected");
    assert.equal(next.label, "port 8089");
    assert.equal(next.client, null);
});
