import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const backgroundSource = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/background.js", import.meta.url),
    "utf8"
);
const popupSource = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/popup.js", import.meta.url),
    "utf8"
);
const popupHTML = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/popup.html", import.meta.url),
    "utf8"
);

function backgroundHarness(initialTokens) {
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
            sockets.push(this);
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
            onMessage: { addListener: (listener) => runtimeListeners.push(listener) },
            sendNativeMessage: async () => {
                nativeMessageCount++;
                return { tokens: Object.fromEntries(tokenMap) };
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

    const context = vm.createContext({
        browser,
        clearTimeout() {},
        console: { error() {}, log() {}, warn() {} },
        Date,
        Promise,
        setTimeout: (callback) => timers.push(callback),
        WebSocket: FakeWebSocket,
    });
    vm.runInContext(backgroundSource, context);

    return {
        evaluate: (source) => vm.runInContext(source, context),
        failLatestSocket() {
            const socket = sockets.at(-1);
            socket.readyState = 3;
            socket.onclose();
            timers.shift()?.();
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
    for (let attempt = 0; attempt < 4; attempt++) harness.failLatestSocket();

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
    for (const id of ["version", "connections", "add-btn", "port-input"]) {
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
