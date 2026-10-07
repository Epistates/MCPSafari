import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// The server holds a pending entry for every request it sends and waits thirty
// seconds for an answer, so a reply it cannot read costs exactly as much as a
// reply that never arrives. Both were reachable from this file.
function loadBackground() {
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
            sendNativeMessage: async () => ({ tokens: { 8089: "token" } }),
        },
        scripting: { executeScript: async () => [{ result: true }] },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            get: async (id) => ({ id, active: true, windowId: 1, url: "https://ok.example/", title: "T" }),
            query: async () => [{ id: 1, active: true, windowId: 1 }],
            sendMessage: async () => ({ data: "ok", error: null }),
            remove: async () => {},
            update: async () => {},
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
        windows: { update: async () => {} },
    };

    const context = vm.createContext({
        browser,
        clearTimeout() {},
        console: { error() {}, log() {}, warn() {} },
        Date,
        Promise,
        URL,
        Error,
        setTimeout: (callback, ms) => { if ((ms || 0) <= 200) queueMicrotask(callback); return 0; },
        WebSocket: FakeWebSocket,
    });
    vm.runInContext(source, context);

    return {
        evaluate: (expression) => vm.runInContext(expression, context),
        /// Drives one socket past the handshake so later frames take the request
        /// path, and clears the auth frame so assertions see only new sends.
        ///
        /// Waits first: the ports are dialled only once `loadAuthTokens` has
        /// come back from the app extension, which is a few microtasks after
        /// the script is evaluated.
        async openAuthenticated() {
            for (let attempt = 0; attempt < 50 && sockets.length === 0; attempt += 1) {
                await new Promise((resolve) => setImmediate(resolve));
            }
            const socket = sockets.at(-1);
            socket.readyState = FakeWebSocket.OPEN;
            socket.onopen();
            socket.onmessage({ data: JSON.stringify({ auth: "ok" }) });
            socket.sent.length = 0;
            return socket;
        },
    };
}

test("a successful reply carries a data key even when the handler returns nothing", async () => {
    const harness = loadBackground();
    // Any handler that falls off its own end lands here. `snapshotAcrossFrames`
    // does it for real: it only records a truthy tree, so a falsy top-level one
    // leaves `trees.get(0)` undefined.
    harness.evaluate("handleTabsClose = async () => undefined");

    const response = await harness.evaluate(
        'handleRequest({ id: "r1", action: "tabs_close", params: { tabId: 1 } })'
    );

    assert.equal(response.success, true);
    // The defect was one level further out. `JSON.stringify(undefined)` is the
    // value undefined rather than a string, so the key vanished from the frame
    // and `response.data?.stringValue` on the server turned a successful call
    // into a failure with no reason attached.
    const frame = JSON.parse(JSON.stringify(response));
    assert.ok("data" in frame, "the server reads response.data and fails the call without it");
    assert.equal(frame.data, "null");
});

test("a frame carrying no request id is dropped rather than throwing twice", async () => {
    const harness = loadBackground();
    const socket = await harness.openAuthenticated();

    // `JSON.parse` accepts every one of these and none has an id to answer.
    // Destructuring one threw out of `handleRequest`, and the catch around it
    // then threw again reading `request.id`, so no reply was sent at all.
    for (const frame of ["null", "5", '"x"', "[]"]) {
        socket.onmessage({ data: frame });
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(socket.sent, []);
});
