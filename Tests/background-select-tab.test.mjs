import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// The tab in these tests sits on a site the user has not granted: the access
// probe is refused. Selecting it only records which tab later calls mean, so it
// must work anyway, and the first call that reads the page must still refuse.
function loadBackground({ granted = false, getTab, activeCalls = [], session = {}, rejectWrites = false } = {}) {
    const stored = {};
    const tab = { id: 7, windowId: 3, active: false, url: "https://ungranted.example/account?token=abc", title: "Your account" };
    // The one the user is looking at, which no pin is on.
    const front = { id: 1, windowId: 3, active: true, url: "https://front.example/", title: "Front" };
    const tabs = [tab, front];
    const sent = [];
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        scripting: {
            executeScript: async (options) => {
                if (options.func && options.func.name === "probeTabAccess" && !granted) {
                    throw new Error("This extension does not have access to this tab");
                }
                return [{ result: true }];
            },
        },
        storage: {
            local: { get: async () => ({}), set: () => (rejectWrites ? Promise.reject(new Error("quota exceeded")) : undefined) },
            session: {
                get: async () => session,
                set: (values) => {
                    if (rejectWrites) return Promise.reject(new Error("quota exceeded"));
                    Object.assign(stored, values);
                },
                remove: async () => {},
            },
        },
        tabs: {
            get: getTab || (async (id) => {
                const found = tabs.find((candidate) => candidate.id === id);
                if (!found) throw new Error(`No tab with id: ${id}`);
                return found;
            }),
            query: async (filter = {}) => (filter.active ? tabs.filter((candidate) => candidate.active) : tabs),
            update: async (id, info) => { activeCalls.push(["tabs.update", id, { ...info }]); },
            sendMessage: async (tabId) => { sent.push(tabId); return { data: "page text", error: null }; },
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
        webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: tab.url }] },
        windows: { update: async (id, info) => { activeCalls.push(["windows.update", id, { ...info }]); } },
    };

    const context = vm.createContext({
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
        stored,
        sent,
        activeCalls,
        evaluate: (expression) => vm.runInContext(expression, context),
        // `port` is the server the request arrives from. One server unless a
        // test is about two.
        request: (action, params, port = 8089) => vm.runInContext(
            `handleRequest(${JSON.stringify({ id: "r1", action, params })}, ${port})`,
            context
        ),
    };
}

test("selecting a tab on an ungranted site pins it and reports success with the access state", async () => {
    const harness = loadBackground();

    const response = await harness.request("select_tab", { tabId: 7 });

    // `success: true` is what lets the server pin the profile too.
    assert.equal(response.success, true);
    const tab = JSON.parse(response.data);
    assert.equal(tab.id, 7);
    assert.equal(tab.selected, true);
    assert.equal(tab.access, "not_granted");
    assert.match(tab.accessHint, /MCPSafari button in Safari's toolbar/);
    // Nothing about the page it was never given access to.
    assert.equal("url" in tab, false);
    assert.equal("title" in tab, false);
    assert.doesNotMatch(response.data, /ungranted\.example|Your account|abc/);
    assert.equal(harness.evaluate("pinnedTabs.get(8089) ?? null"), 7);
    assert.deepEqual({ ...harness.stored.pinnedTabs }, { 8089: 7 }, "and it survives the background page being suspended");
});

test("the pinned ungranted tab still refuses the first call that reads the page", async () => {
    const harness = loadBackground();
    await harness.request("select_tab", { tabId: 7 });

    // No tab named: the pin supplies it.
    const response = await harness.request("snapshot", {});

    assert.equal(response.success, false);
    assert.equal(response.errorCode, "permission_required");
    assert.equal(response.resolvedTabId, 7);
});

test("selecting a tab on a reached site still describes it", async () => {
    const harness = loadBackground({ granted: true });
    await harness.evaluate("ensureTabAccess(7)");

    const tab = JSON.parse((await harness.request("select_tab", { tabId: 7 })).data);

    assert.equal(tab.access, "granted");
    assert.equal(tab.title, "Your account");
    assert.equal(tab.url, "https://ungranted.example/account?token=[redacted]");
    assert.equal("accessHint" in tab, false);
});

test("selecting brings the tab forward without needing access to its page", async () => {
    const calls = [];
    const harness = loadBackground({ activeCalls: calls });

    await harness.request("select_tab", { tabId: 7 });

    assert.deepEqual(calls, [
        ["tabs.update", 7, { active: true }],
        ["windows.update", 3, { focused: true }],
    ]);
});

test("bringToFront: false pins without moving anything", async () => {
    const calls = [];
    const harness = loadBackground({ activeCalls: calls });

    const response = await harness.request("select_tab", { tabId: 7, bringToFront: false });

    assert.equal(response.success, true);
    assert.deepEqual(calls, []);
    assert.equal(harness.evaluate("pinnedTabs.get(8089) ?? null"), 7);
});

test("a tab that does not exist is refused and not pinned", async () => {
    const harness = loadBackground();

    const response = await harness.request("select_tab", { tabId: 99 });

    assert.equal(response.success, false);
    assert.match(response.error, /No tab with id/);
    assert.equal(harness.evaluate("pinnedTabs.get(8089) ?? null"), null);
});

test("a lookup parked behind a dialog does not stop the pin", async () => {
    // The deadline is fired by hand: the harness's timer only runs short waits.
    const harness = loadBackground({ getTab: () => new Promise(() => {}) });
    // Startup arms a deadline of its own; let it finish so the one captured
    // below is the lookup's.
    await new Promise((resolve) => setImmediate(resolve));
    harness.evaluate("setTimeout = (callback) => { globalThis.__fire = callback; return 1; }");

    const pending = harness.request("select_tab", { tabId: 7 });
    for (let attempt = 0; attempt < 50 && !harness.evaluate("globalThis.__fire"); attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    harness.evaluate("globalThis.__fire()");
    const response = await pending;

    assert.equal(response.success, true);
    assert.equal(JSON.parse(response.data).access, "not_granted");
    assert.equal(harness.evaluate("pinnedTabs.get(8089) ?? null"), 7);
});

test("restoring a pin does not hold startup on a tab parked behind a dialog, and keeps the pin", async () => {
    // Startup restores the pins before it connects to any server, so a tab.get
    // that never answers would keep every server waiting. A tab that is parked
    // is a tab that exists.
    const harness = loadBackground({
        granted: true,
        session: { pinnedTabs: { 8089: 7 } },
        getTab: () => new Promise(() => {}),
    });
    await new Promise((resolve) => setImmediate(resolve));
    harness.evaluate("setTimeout = (callback) => { globalThis.__fire = callback; return 1; }");

    const restoring = harness.evaluate("restoreSessionState()");
    for (let attempt = 0; attempt < 50 && !harness.evaluate("globalThis.__fire"); attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    harness.evaluate("globalThis.__fire()");
    await restoring;

    assert.equal(harness.evaluate("pinnedTabs.get(8089)"), 7);
});

// ─── Storage that refuses a write ────────────────────────────────────

test("a storage write that is rejected does not become an unhandled rejection", async () => {
    // `storage.*.set` returns a promise, so the try/catch around the call saw
    // nothing of a quota or an I/O failure. The write is a convenience across a
    // suspension; losing it must not be an error that surfaces anywhere else.
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
        const harness = loadBackground({ granted: true, rejectWrites: true });

        const response = await harness.request("select_tab", { tabId: 7, bringToFront: false });
        harness.evaluate("persistManualPorts()");
        harness.evaluate('rememberOriginAccess("https://granted.example", true)');
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(response.success, true, "the pin itself still worked");
        assert.deepEqual(unhandled.map(String), []);
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
});

// ─── Two servers ─────────────────────────────────────────────────────

// Each MCP client has its own server on its own port, and the extension is
// connected to all of them. The pin used to be one global, so a second client's
// untabbed calls landed on the first client's tab.

test("a pin belongs to the server that made it", async () => {
    const harness = loadBackground({ granted: true });
    await harness.request("select_tab", { tabId: 7, bringToFront: false }, 8089);

    const pinned = await harness.request("hover", { uid: "f0e1" }, 8089);
    const other = await harness.request("hover", { uid: "f0e1" }, 8090);

    assert.equal(pinned.resolvedTabId, 7);
    assert.equal(other.resolvedTabId, 1, "the second server's call went to the first server's tab");
    assert.deepEqual(harness.sent, [7, 1]);
});

test("two servers pin different tabs without disturbing each other", async () => {
    const harness = loadBackground({ granted: true });
    await harness.request("select_tab", { tabId: 7, bringToFront: false }, 8089);
    await harness.request("select_tab", { tabId: 1, bringToFront: false }, 8090);

    assert.equal((await harness.request("hover", { uid: "f0e1" }, 8089)).resolvedTabId, 7);
    assert.equal((await harness.request("hover", { uid: "f0e1" }, 8090)).resolvedTabId, 1);
    assert.deepEqual({ ...harness.stored.pinnedTabs }, { 8089: 7, 8090: 1 });
});

test("closing a tab clears the pin of the server that closed it", async () => {
    const harness = loadBackground({ granted: true });
    harness.evaluate("browser.tabs.remove = async () => {}");
    await harness.request("select_tab", { tabId: 7, bringToFront: false }, 8089);
    await harness.request("select_tab", { tabId: 7, bringToFront: false }, 8090);

    await harness.request("tabs_close", { tabId: 7 }, 8089);

    assert.equal(harness.evaluate("pinnedTabs.has(8089)"), false);
    assert.equal(harness.evaluate("pinnedTabs.get(8090)"), 7, "another server's pin was cleared");
    assert.deepEqual({ ...harness.stored.pinnedTabs }, { 8090: 7 });
});

test("pins are restored per server, and one whose tab has gone is dropped", async () => {
    const harness = loadBackground({ granted: true, session: { pinnedTabs: { 8089: 7, 8090: 99 } } });

    await harness.evaluate("restoreSessionState()");

    assert.equal(harness.evaluate("pinnedTabs.get(8089)"), 7);
    assert.equal(harness.evaluate("pinnedTabs.has(8090)"), false);
    assert.deepEqual({ ...harness.stored.pinnedTabs }, { 8089: 7 }, "the stored copy still names a tab that is gone");
});
