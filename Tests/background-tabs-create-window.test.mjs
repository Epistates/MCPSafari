import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { handshakeGlobals } from "./helpers/bridge-handshake.mjs";
import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// Two windows: the user's in front (window 1) and an agent's own (window 2).
// A new tab belongs in the agent's window, never in the user's by default.
function loadBackground({ getTab } = {}) {
    const tabs = [
        { id: 1, windowId: 1, active: true, url: "https://front.example/", title: "Front" },
        { id: 7, windowId: 2, active: true, url: "https://agent.example/", title: "Agent" },
    ];
    const created = [];
    const windowsCreated = [];
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        scripting: { executeScript: async () => [{ result: true }] },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            get: getTab || (async (id) => {
                const found = tabs.find((tab) => tab.id === id);
                if (!found) throw new Error(`No tab with id: ${id}`);
                return found;
            }),
            create: async (options) => {
                created.push({ ...options });
                const tab = { id: 100 + created.length, windowId: options.windowId ?? 1, active: true, url: "", title: "" };
                tabs.push(tab);
                return tab;
            },
            query: async () => tabs,
            update: async () => {},
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
        webNavigation: { getAllFrames: async () => [] },
        windows: {
            update: async () => {},
            getCurrent: async () => ({ id: 1, left: 0, top: 0, width: 800, height: 600 }),
            getLastFocused: async () => ({ id: 1, left: 0, top: 0, width: 800, height: 600 }),
            get: async (id) => ({ id, left: 0, top: 0, width: 800, height: 600 }),
            create: async (options) => {
                windowsCreated.push({ ...options });
                tabs.push({ id: 200, windowId: 9, index: 0, active: true, url: "", title: "" });
                return { id: 9 };
            },
        },
    };

    const context = vm.createContext({
        // The digest a pin carries of the server's token needs WebCrypto.
        ...handshakeGlobals,
        browser,
        clearTimeout() {},
        console: { error() {}, log() {}, warn() {} },
        Date,
        Error,
        Promise,
        URL,
        setTimeout: (callback, ms) => { if ((ms || 0) <= 400) queueMicrotask(callback); return 0; },
        WebSocket: class { send() {} },
    });
    vm.runInContext(source, context);

    return {
        created,
        windowsCreated,
        request: (action, params, port = 8089) => vm.runInContext(
            `handleRequest(${JSON.stringify({ id: "r1", action, params })}, ${port})`,
            context
        ),
    };
}

test("a new tab opens in the window of the tab the caller names", async () => {
    const harness = loadBackground();

    const response = await harness.request("tabs_create", { tabId: 7 });

    assert.equal(response.success, true, response.error);
    assert.deepEqual(harness.created, [{ windowId: 2 }]);
});

test("with no tab named, a new tab joins the window of the server's pinned tab", async () => {
    const harness = loadBackground();
    await harness.request("select_tab", { tabId: 7, bringToFront: false });

    await harness.request("tabs_create", {});

    assert.deepEqual(harness.created, [{ windowId: 2 }]);
});

test("a pin is the server's own: another server's new tab still opens in the window in front", async () => {
    const harness = loadBackground();
    await harness.request("select_tab", { tabId: 7, bringToFront: false }, 8089);

    await harness.request("tabs_create", {}, 8090);

    assert.deepEqual(harness.created, [{}]);
});

test("with no tab named and no pin, a new tab opens in the window in front, as before", async () => {
    const harness = loadBackground();

    await harness.request("tabs_create", {});

    assert.equal(harness.created.length, 1);
    assert.equal("windowId" in harness.created[0], false);
});

// Opening it in the window in front instead would put the tab exactly where the
// caller asked it not to go.
test("a named tab that has closed is reported, not swapped for the window in front", async () => {
    const harness = loadBackground();

    const response = await harness.request("tabs_create", { tabId: 55 });

    assert.equal(response.success, false);
    assert.equal(response.errorCode, "tab_closed");
    assert.deepEqual(harness.created, []);
});

test("a pinned tab that can't be found falls back to the window in front", async () => {
    let pinnedGone = false;
    const harness = loadBackground({
        getTab: async (id) => {
            if (id === 7 && pinnedGone) throw new Error(`No tab with id: ${id}`);
            return { id, windowId: 2, active: true, url: "https://agent.example/", title: "Agent" };
        },
    });
    await harness.request("select_tab", { tabId: 7, bringToFront: false });
    pinnedGone = true;

    const response = await harness.request("tabs_create", {});

    assert.equal(response.success, true, response.error);
    assert.deepEqual(harness.created, [{}]);
});

test("newWindow still opens a window of its own, whatever tab is named", async () => {
    const harness = loadBackground();

    const response = await harness.request("tabs_create", { tabId: 7, newWindow: true });

    assert.equal(response.success, true, response.error);
    assert.equal(harness.windowsCreated.length, 1);
    assert.deepEqual(harness.created, []);
    assert.equal(JSON.parse(response.data).id, 200);
});
