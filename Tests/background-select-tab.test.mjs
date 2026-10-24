import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// The tab in these tests sits on a site the user has not granted: the access
// probe is refused. Selecting it only records which tab later calls mean, so it
// must work anyway, and the first call that reads the page must still refuse.
function loadBackground({ granted = false, getTab, activeCalls = [] } = {}) {
    const stored = {};
    const tab = { id: 7, windowId: 3, active: false, url: "https://ungranted.example/account?token=abc", title: "Your account" };
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
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set: (values) => { Object.assign(stored, values); }, remove: async () => {} },
        },
        tabs: {
            get: getTab || (async (id) => {
                if (id !== tab.id) throw new Error(`No tab with id: ${id}`);
                return tab;
            }),
            query: async () => [tab],
            update: async (id, info) => { activeCalls.push(["tabs.update", id, { ...info }]); },
            sendMessage: async () => ({ data: "page text", error: null }),
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
        activeCalls,
        evaluate: (expression) => vm.runInContext(expression, context),
        request: (action, params) => vm.runInContext(
            `handleRequest(${JSON.stringify({ id: "r1", action, params })})`,
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
    assert.equal(harness.evaluate("selectedTabId"), 7);
    assert.equal(harness.stored.selectedTabId, 7, "and it survives the background page being suspended");
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
    assert.equal(harness.evaluate("selectedTabId"), 7);
});

test("a tab that does not exist is refused and not pinned", async () => {
    const harness = loadBackground();

    const response = await harness.request("select_tab", { tabId: 99 });

    assert.equal(response.success, false);
    assert.match(response.error, /No tab with id/);
    assert.equal(harness.evaluate("selectedTabId"), null);
});

test("a lookup parked behind a dialog does not stop the pin", async () => {
    // The deadline is fired by hand: the harness's timer only runs short waits.
    const harness = loadBackground({ getTab: () => new Promise(() => {}) });
    harness.evaluate("setTimeout = (callback) => { globalThis.__fire = callback; return 1; }");

    const pending = harness.request("select_tab", { tabId: 7 });
    for (let attempt = 0; attempt < 50 && !harness.evaluate("globalThis.__fire"); attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    harness.evaluate("globalThis.__fire()");
    const response = await pending;

    assert.equal(response.success, true);
    assert.equal(JSON.parse(response.data).access, "not_granted");
    assert.equal(harness.evaluate("selectedTabId"), 7);
});
