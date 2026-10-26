import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import {
    PROTOCOL_VERSION,
    challengeFor,
    deliver,
    expectedClientProof,
    handshakeGlobals,
    helloOn,
    newNonce,
    serverHandshake,
    serverProof,
} from "./helpers/bridge-handshake.mjs";
import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const backgroundSource = backgroundScriptSource();
const popupSource = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/popup.js", import.meta.url),
    "utf8"
);
const popupHTML = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/popup.html", import.meta.url),
    "utf8"
);

function backgroundHarness(initialTokens, { profile, nativeResponse, randomBytes } = {}) {
    const tokenMap = new Map(Object.entries(initialTokens));
    const sockets = [];
    const timers = [];
    const runtimeListeners = [];
    let nativeMessageCount = 0;

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
        // A real socket reports its close later, through onclose, which the
        // harness fires itself when a test wants that moment.
        close() { this.readyState = 3; this.closed = true; }
    }

    const browser = {
        alarms: {
            create() {},
            onAlarm: { addListener() {} },
        },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
            sendNativeMessage: async () => {
                nativeMessageCount++;
                if (nativeResponse) return nativeResponse;
                const response = { tokens: Object.fromEntries(tokenMap) };
                // The appex omits this for extension builds without profile support.
                if (profile !== undefined) response.profile = profile;
                return response;
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

    const logged = [];
    const context = vm.createContext({
        ...handshakeGlobals,
        // A test that wants the extension's nonce to be a known value supplies the
        // bytes `getRandomValues` fills in.
        ...(randomBytes && {
            crypto: {
                subtle: handshakeGlobals.crypto.subtle,
                getRandomValues: (array) => { array.set(randomBytes); return array; },
            },
        }),
        browser,
        clearTimeout() {},
        console: {
            error: (...args) => logged.push(args.join(" ")),
            log() {},
            warn() {},
        },
        Date,
        Promise,
        setTimeout: (callback) => timers.push(callback),
        WebSocket: FakeWebSocket,
    });
    vm.runInContext(backgroundSource, context);

    return {
        evaluate: (source) => vm.runInContext(source, context),
        /// Opens the latest socket and returns the hello the extension sends on connect.
        openLatestSocket() {
            const socket = sockets.at(-1);
            socket.readyState = FakeWebSocket.OPEN;
            socket.onopen();
            return helloOn(socket);
        },
        /// What the extension logged as an error.
        logged,
        /// The reconnect timer's callback may itself be asynchronous, so this
        /// waits for it: the next dial happens after any token reload.
        async failLatestSocket() {
            const socket = sockets.at(-1);
            socket.readyState = 3;
            socket.onclose();
            await timers.shift()?.();
        },
        /// Delivers one frame from the server to the latest socket.
        serverSends(frame) {
            return sockets.at(-1).onmessage({ data: JSON.stringify(frame) });
        },
        runtimeListeners,
        sockets,
        tokenMap,
        nativeMessageCount: () => nativeMessageCount,
    };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("unchanged stale tokens stop reconnecting until their value changes", async () => {
    const harness = backgroundHarness({ 8091: "stale-token" });
    await settle();

    assert.equal(harness.sockets.length, 1);
    for (let attempt = 0; attempt < 4; attempt++) await harness.failLatestSocket();

    assert.equal(harness.evaluate("connections.has(8091)"), false);
    assert.equal(harness.evaluate("staleTokensByPort.get(8091)"), "stale-token");

    await harness.evaluate("loadAuthTokens()");
    assert.equal(harness.sockets.length, 4);
    assert.equal(harness.evaluate("connections.has(8091)"), false);

    harness.tokenMap.set("8091", "replacement-token");
    await harness.evaluate("loadAuthTokens()");
    assert.equal(harness.evaluate("connections.has(8091)"), true);
    assert.equal(harness.sockets.length, 5);
});

test("the handshake carries the Safari profile the appex reported", async () => {
    // Safari runs one instance of the extension per profile, all reading the same
    // token. Without this the server cannot tell them apart and evicts one for the
    // other, which is what made a two-profile setup flap.
    const harness = backgroundHarness({ 8091: "current-token" }, { profile: "WORK-UUID" });
    await settle();

    const hello = harness.openLatestSocket();
    assert.equal(hello.profileId, "WORK-UUID");
    assert.equal(hello.protocolVersion, PROTOCOL_VERSION);
});

test("an appex that reports no profile leaves the handshake on the default", async () => {
    const harness = backgroundHarness({ 8091: "current-token" });
    await settle();

    assert.equal(harness.openLatestSocket().profileId, "default");
});

test("the extension dials the IPv4 loopback address, never the name localhost", async () => {
    // The server binds 127.0.0.1 only. `localhost` can resolve to ::1 first, where
    // a different local user could be listening and would be the one answering.
    const harness = backgroundHarness({ 8091: "current-token" });
    await settle();

    assert.equal(harness.sockets.at(-1).url, "ws://127.0.0.1:8091");
});

test("a token_mismatch reply makes the redial read the token again", async () => {
    // A restarted server writes a new token. The extension kept redialling with the
    // one it had cached and stayed locked out until the keepalive (#156).
    const harness = backgroundHarness({ 8091: "old-token" });
    await settle();
    harness.openLatestSocket();

    await harness.serverSends({ auth: "error", error: "token_mismatch" });
    harness.tokenMap.set("8091", "new-token");
    const reads = harness.nativeMessageCount();
    await harness.failLatestSocket();

    assert.equal(harness.nativeMessageCount(), reads + 1, "tokens are read once for the attempt");
    assert.equal(harness.sockets.length, 2);
    // The token no longer appears in any frame, so which one the redial used is
    // told by whose proof it accepts: only a server holding the new one gets through.
    harness.openLatestSocket();
    await serverHandshake(harness.sockets.at(-1), { token: "new-token", port: 8091 });
    assert.equal(harness.evaluate("connections.get(8091).state"), "connected");
});

test("a socket that closes before authenticating also reads the token again", async () => {
    // The server may simply be gone or restarting, with nothing said at all.
    const harness = backgroundHarness({ 8091: "old-token" });
    await settle();
    harness.openLatestSocket();

    harness.tokenMap.set("8091", "new-token");
    await harness.failLatestSocket();

    harness.openLatestSocket();
    await serverHandshake(harness.sockets.at(-1), { token: "new-token", port: 8091 });
    assert.equal(harness.evaluate("connections.get(8091).state"), "connected");
});

test("a connection that was authenticated redials without a token read", async () => {
    // Its token was good a moment ago, and the keepalive reloads tokens anyway.
    const harness = backgroundHarness({ 8091: "current-token" });
    await settle();
    harness.openLatestSocket();
    await serverHandshake(harness.sockets.at(-1), { token: "current-token", port: 8091 });

    const reads = harness.nativeMessageCount();
    await harness.failLatestSocket();

    assert.equal(harness.nativeMessageCount(), reads);
    assert.equal(harness.sockets.length, 2);
});

test("a single shared token from the host app is not dialled with", async () => {
    // Only the per-port map is read. A host app that answers with the old single
    // token has nothing the extension will use, so it dials nothing rather than
    // trying one secret against every port.
    const harness = backgroundHarness({}, { nativeResponse: { token: "shared-token" } });
    await settle();

    // A port the user adds by hand is dialled once tokens are read, with whatever
    // token there is for it.
    harness.runtimeListeners[0]({ type: "addPort", port: "8091" }, {}, () => {});
    await settle();

    assert.equal(harness.sockets.length, 0);
    assert.equal(harness.evaluate("connections.get(8091).state"), "disconnected");
});

// ─── The challenge-response handshake ────────────────────────────────

const TOKEN = "B9F4C2A1-7E3D-4F10-9A6B-0C5D8E2F1A34";

/// A harness with one dialled, opened socket and a spy where requests are dispatched.
async function openedHarness(options) {
    const harness = backgroundHarness({ 8091: TOKEN }, options);
    await settle();
    harness.openLatestSocket();
    harness.evaluate(
        "globalThis.dispatched = []; handleRequest = async (request) => { dispatched.push(request); return { id: request.id, success: true }; }"
    );
    return { harness, socket: harness.sockets.at(-1) };
}

const dispatched = (harness) => harness.evaluate("dispatched.length");
const stateOf = (harness) => harness.evaluate("connections.get(8091).state");

test("the token is never sent, in the hello or in any frame after it", async () => {
    // The token is the key to both proofs. A listener that is not the real server
    // is handed whatever the extension sends on connecting, so none of it may be
    // the token.
    const harness = backgroundHarness({ 8091: TOKEN });
    await settle();
    harness.openLatestSocket();
    const frames = await serverHandshake(harness.sockets.at(-1), { token: TOKEN, port: 8091 });

    assert.equal(frames.length, 2, "a hello and a proof");
    for (const frame of harness.sockets.at(-1).sent) assert.ok(!frame.includes(TOKEN), frame);
    assert.equal(stateOf(harness), "connected");
});

test("the proof it sends is the HMAC the server expects, in both directions", async () => {
    // Fixed bytes in place of the random ones, so the extension's WebCrypto output
    // can be held against a vector computed by another implementation. The Swift
    // side asserts the same two values.
    const harness = backgroundHarness({ 8089: TOKEN }, { randomBytes: new Uint8Array(32) });
    await settle();
    const socket = harness.sockets.at(-1);
    harness.openLatestSocket();
    const clientNonce = "A".repeat(43);
    const serverNonce = "B".repeat(43);
    assert.equal(helloOn(socket).clientNonce, clientNonce);

    assert.equal(serverProof(TOKEN, 8089, clientNonce, serverNonce), "Vu6_f6XKAvJZ-jhqHWGJdqiV7Fg2ZfpPoM9koUiT22U");
    await deliver(socket, challengeFor(helloOn(socket), { token: TOKEN, port: 8089, serverNonce }));

    assert.equal(
        JSON.parse(socket.sent[1]).auth.clientProof,
        "Pd_tPFSAAAEYm9VKBPq4lTqgdoj3DS1i-FN1nh6B-1E"
    );
    assert.equal(
        expectedClientProof(TOKEN, 8089, clientNonce, serverNonce),
        "Pd_tPFSAAAEYm9VKBPq4lTqgdoj3DS1i-FN1nh6B-1E"
    );
});

test("an ok with no proof behind it does not authenticate the server", async () => {
    // Any listener on the port can send {"auth":"ok"}. Before the challenge it was
    // all the extension asked for, so it began answering requests from whoever
    // was there.
    const { harness, socket } = await openedHarness();

    await harness.serverSends({ auth: "ok", protocolVersion: PROTOCOL_VERSION });

    assert.equal(socket.closed, true);
    assert.notEqual(stateOf(harness), "connected");
    assert.equal(socket.sent.length, 1, "nothing but the hello was sent");
});

test("a server that cannot prove it holds the token gets no proof back and is never served", async () => {
    const { harness, socket } = await openedHarness();

    // Right shape, wrong key: what a listener that merely accepted the dial can do.
    await deliver(socket, challengeFor(helloOn(socket), { token: "some-other-token", port: 8091 }));

    assert.equal(socket.closed, true);
    assert.equal(socket.sent.length, 1, "no clientProof was sent");
    assert.notEqual(stateOf(harness), "connected");
    assert.ok(harness.logged.some((line) => line.includes("did not prove it knows the token")));

    // And what it sends next is not read as a request.
    await harness.serverSends({ id: "r1", action: "tabs_query", params: {} });
    assert.equal(dispatched(harness), 0);
    assert.equal(socket.sent.length, 1);
});

test("a proof made for another port, or in the client's direction, is refused", async () => {
    for (const forge of [
        // The right token, for a different listener.
        (hello, serverNonce) => serverProof(TOKEN, 8092, hello.clientNonce, serverNonce),
        // The client's proof offered as the server's: reflection.
        (hello, serverNonce) => expectedClientProof(TOKEN, 8091, hello.clientNonce, serverNonce),
        // The server's nonces in the wrong order.
        (hello, serverNonce) => serverProof(TOKEN, 8091, serverNonce, hello.clientNonce),
    ]) {
        const { harness, socket } = await openedHarness();
        const serverNonce = newNonce();
        await deliver(socket, challengeFor(helloOn(socket), {
            serverNonce,
            proof: forge(helloOn(socket), serverNonce),
        }));

        assert.equal(socket.closed, true);
        assert.equal(socket.sent.length, 1);
        assert.notEqual(stateOf(harness), "connected");
    }
});

test("a request that arrives before the handshake is finished is never dispatched", async () => {
    const { harness, socket } = await openedHarness();

    // Before any challenge.
    await harness.serverSends({ id: "r1", action: "tabs_query", params: {} });
    assert.equal(dispatched(harness), 0);
    assert.equal(socket.closed, true, "a peer that skips the handshake is dropped");
    assert.equal(socket.sent.length, 1);
});

test("a request between the server's proof and its ok is not dispatched", async () => {
    const { harness, socket } = await openedHarness();
    await deliver(socket, challengeFor(helloOn(socket), { token: TOKEN, port: 8091 }));
    assert.equal(socket.sent.length, 2, "the extension answered the genuine challenge");

    await harness.serverSends({ id: "r1", action: "tabs_query", params: {} });

    assert.equal(dispatched(harness), 0);
    assert.equal(socket.closed, true);
    assert.notEqual(stateOf(harness), "connected");
});

test("a second challenge on a finished handshake is not answered", async () => {
    const { harness, socket } = await openedHarness();
    await deliver(socket, challengeFor(helloOn(socket), { token: TOKEN, port: 8091 }));
    await harness.serverSends({ auth: "ok", protocolVersion: PROTOCOL_VERSION });
    assert.equal(stateOf(harness), "connected");
    const sent = socket.sent.length;

    // A genuine challenge again would be a request with no id, which is dropped
    // rather than answered, and in particular is not a second proof.
    await deliver(socket, challengeFor(helloOn(socket), { token: TOKEN, port: 8091 }));
    assert.equal(socket.sent.length, sent);
});

test("a challenge whose nonce is malformed is refused", async () => {
    const { harness, socket } = await openedHarness();

    await deliver(socket, { challenge: { serverNonce: "short", serverProof: "x" } });

    assert.equal(socket.closed, true);
    assert.equal(socket.sent.length, 1);
    assert.notEqual(stateOf(harness), "connected");
});

test("once authenticated, requests are dispatched as before", async () => {
    const { harness, socket } = await openedHarness();
    await deliver(socket, challengeFor(helloOn(socket), { token: TOKEN, port: 8091 }));
    await harness.serverSends({ auth: "ok", protocolVersion: PROTOCOL_VERSION });

    await harness.serverSends({ id: "r1", action: "tabs_query", params: {} });

    assert.equal(dispatched(harness), 1);
    assert.equal(JSON.parse(socket.sent.at(-1)).id, "r1");
});

test("a server proof that fails reads the token again before the next dial", async () => {
    // The usual reason a genuine server fails the check is that it restarted and
    // wrote a new token, the same situation #156 covers.
    const { harness, socket } = await openedHarness();
    await deliver(socket, challengeFor(helloOn(socket), { token: "the-new-token", port: 8091 }));
    harness.tokenMap.set("8091", "the-new-token");
    const reads = harness.nativeMessageCount();

    await harness.failLatestSocket();

    assert.equal(harness.nativeMessageCount(), reads + 1);
    harness.openLatestSocket();
    await serverHandshake(harness.sockets.at(-1), { token: "the-new-token", port: 8091 });
    assert.equal(stateOf(harness), "connected");
});

test("a protocol mismatch is reported with both versions and what to do", async () => {
    const { harness } = await openedHarness();

    await harness.serverSends({
        auth: "error",
        error: "protocol_version_mismatch",
        extensionProtocolVersion: PROTOCOL_VERSION,
        serverProtocolVersion: 1,
    });

    const line = harness.logged.find((entry) => entry.includes("Protocol mismatch"));
    assert.ok(line, "the mismatch is logged");
    assert.match(line, new RegExp(`extension=${PROTOCOL_VERSION}`));
    assert.match(line, /server=1/);
    assert.match(line, /Install matching/);
});

test("popup status polling does not restart disconnected ports", async () => {
    const harness = backgroundHarness({ 8091: "current-token" });
    await settle();
    harness.evaluate("connections.get(8091).ws = null; connections.get(8091).state = 'disconnected'");
    const socketCount = harness.sockets.length;

    let response;
    const initialNativeMessageCount = harness.nativeMessageCount();
    const staysOpen = harness.runtimeListeners[0](
        { type: "getStatus" },
        {},
        (value) => { response = value; }
    );

    assert.equal(staysOpen, false);
    assert.equal(harness.nativeMessageCount(), initialNativeMessageCount);
    assert.equal(harness.sockets.length, socketCount);
    assert.equal(response.ports[0].state, "disconnected");
});

test("explicit connection refresh reloads tokens once", async () => {
    const harness = backgroundHarness({ 8091: "current-token" });
    await settle();
    const initialNativeMessageCount = harness.nativeMessageCount();

    let response;
    const staysOpen = harness.runtimeListeners[0](
        { type: "refreshConnections" },
        {},
        (value) => { response = value; }
    );
    await settle();

    assert.equal(staysOpen, true);
    assert.equal(harness.nativeMessageCount(), initialNativeMessageCount + 1);
    assert.equal(response.ports[0].port, 8091);
});

test("popup version comes from the extension manifest", async () => {
    assert.match(popupHTML, /id="version"/);
    assert.doesNotMatch(popupHTML, /v0\.2\.8/);

    let domReady;
    const elements = new Map();
    const renderedPorts = [];
    const element = () => ({ addEventListener() {}, textContent: "", value: "" });
    for (const id of ["version", "connections", "add-btn", "port-input", "site"]) {
        elements.set(id, element());
    }
    elements.set("connections", {
        innerHTML: "",
        appendChild: (row) => renderedPorts.push(Number(row.innerHTML.match(/conn-port">(\d+)/)[1])),
        querySelectorAll: () => [],
    });
    const document = {
        addEventListener: (type, listener) => { if (type === "DOMContentLoaded") domReady = listener; },
        createElement: () => ({ className: "", innerHTML: "" }),
        getElementById: (id) => elements.get(id),
    };
    const context = vm.createContext({
        browser: {
            runtime: {
                getManifest: () => ({ version: "9.9.9" }),
                sendMessage: async () => ({ ports: [] }),
            },
        },
        clearInterval() {},
        console,
        document,
        setInterval: () => 1,
        setTimeout,
        window: { addEventListener() {} },
    });
    vm.runInContext(popupSource, context);
    await domReady();

    assert.equal(elements.get("version").textContent, "v9.9.9");
    vm.runInContext(
        "renderConnections([{ port: 8091, state: 'connected' }, { port: 8089, state: 'disconnected' }, { port: 8090, state: 'connecting' }])",
        context
    );
    assert.deepEqual(renderedPorts, [8089, 8090, 8091]);
});
