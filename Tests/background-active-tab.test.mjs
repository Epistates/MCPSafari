import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// The tab a call lands on is decided in one place, and a wrong answer there is
// the worst kind of failure: the call succeeds, on a page nobody meant.
function loadBackground({
    tabs = [{ id: 1, active: true, windowId: 1 }],
    getTab,
    frames = [{ frameId: 0, parentFrameId: -1, url: "" }],
    // Runs after each message reaches a page, which is where a user clicking
    // into another tab mid-request is simulated.
    afterSend = () => {},
} = {}) {
    const sent = [];
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
                const tab = tabs.find((candidate) => candidate.id === id);
                if (!tab) throw new Error(`No tab with id: ${id}`);
                return { url: "https://ok.example/", title: "T", ...tab };
            }),
            query: async (filter = {}) => (filter.active ? tabs.filter((tab) => tab.active) : tabs),
            sendMessage: async (tabId, message, options) => {
                sent.push({ tabId, frameId: options ? options.frameId : 0, action: message.action });
                afterSend(tabs);
                return { data: [], error: null };
            },
            update: async () => {},
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
        webNavigation: { getAllFrames: async () => frames },
        windows: { update: async () => {} },
    };

    const context = vm.createContext({
        browser,
        clearTimeout() {},
        console: { error() {}, log() {}, warn() {} },
        Date,
        Error,
        Promise,
        URL,
        setTimeout: (callback, ms) => { if ((ms || 0) <= 200) queueMicrotask(callback); return 0; },
        WebSocket: class { send() {} },
    });
    vm.runInContext(source, context);

    return {
        sent,
        call: (expression) => vm.runInContext(expression, context),
    };
}

async function rejection(promise) {
    try {
        await promise;
        return null;
    } catch (err) {
        return err;
    }
}

test("a pinned tab that was closed is an error, not a quiet switch to the active tab", async () => {
    // The user is looking at tab 1. The agent pinned tab 7, which has since closed.
    const harness = loadBackground({ tabs: [{ id: 1, active: true, windowId: 1 }] });
    harness.call("selectedTabId = 7");

    const err = await rejection(harness.call("getActiveTabId()"));

    assert.equal(err.code, "tab_closed");
    assert.equal(err.retryable, false);
    assert.equal(err.recoveryAction, "call_tabs_context");
    assert.match(err.message, /select_tab/);
    assert.equal(harness.call("selectedTabId"), null, "the dead pin is cleared so the next call is not stuck");
});

test("an untabbed type_text after the pinned tab closed does not land on the user's tab", async () => {
    const harness = loadBackground({ tabs: [{ id: 1, active: true, windowId: 1 }] });
    harness.call("selectedTabId = 7");

    const response = await harness.call(
        'handleRequest({ id: "r1", action: "type_text", params: { text: "hunter2" } })'
    );

    assert.equal(response.success, false);
    assert.equal(response.errorCode, "tab_closed");
    assert.equal(harness.sent.length, 0, "nothing may reach the page the user is looking at");
});

test("the call after a tab_closed refusal resolves normally again", async () => {
    const harness = loadBackground({ tabs: [{ id: 1, active: true, windowId: 1 }] });
    harness.call("selectedTabId = 7");

    await rejection(harness.call("getActiveTabId()"));

    assert.equal(await harness.call("getActiveTabId()"), 1);
});

test("a pinned tab whose lookup fails for another reason keeps its pin", async () => {
    // The tab is in the listing, so it exists; `tabs.get` failing is something else.
    const harness = loadBackground({
        tabs: [{ id: 1, active: true, windowId: 1 }, { id: 7, active: false, windowId: 1 }],
        getTab: async () => { throw new Error("transient failure"); },
    });
    harness.call("selectedTabId = 7");

    const err = await rejection(harness.call("getActiveTabId()"));

    assert.match(err.message, /transient failure/);
    assert.notEqual(err.code, "tab_closed");
    assert.equal(harness.call("selectedTabId"), 7);
});

test("a pinned tab is kept when the listing that would confirm its absence fails too", async () => {
    const harness = loadBackground({ getTab: async () => { throw new Error("transient failure"); } });
    harness.call("browser.tabs.query = async () => { throw new Error('listing failed'); }");
    harness.call("selectedTabId = 7");

    const err = await rejection(harness.call("getActiveTabId()"));

    assert.match(err.message, /transient failure/);
    assert.equal(harness.call("selectedTabId"), 7);
});

// An untabbed call used to look the active tab up again at every step, once per
// frame for a search, so a user switching tabs partway through split one request
// across two pages.
test("an untabbed request acts on one tab even if the user switches mid-request", async () => {
    const harness = loadBackground({
        tabs: [
            { id: 1, active: true, windowId: 1 },
            { id: 2, active: false, windowId: 1 },
        ],
        frames: [
            { frameId: 0, parentFrameId: -1, url: "https://ok.example/" },
            { frameId: 3, parentFrameId: 0, url: "https://ok.example/frame" },
        ],
        afterSend: (tabs) => {
            tabs[0].active = false;
            tabs[1].active = true;
        },
    });

    const response = await harness.call(
        'handleRequest({ id: "r1", action: "find", params: { text: "Pay" } })'
    );

    assert.equal(response.success, true);
    assert.deepEqual(harness.sent.map((s) => [s.tabId, s.frameId]), [[1, 0], [1, 3]]);
    assert.equal(response.resolvedTabId, 1);
});

test("the resolved tab is reported on the response so a caller can reuse it", async () => {
    const harness = loadBackground({ tabs: [{ id: 4, active: true, windowId: 1 }] });

    const untabbed = await harness.call('handleRequest({ id: "r1", action: "click", params: { selector: "#go" } })');
    assert.equal(untabbed.resolvedTabId, 4);

    const tabbed = await harness.call('handleRequest({ id: "r2", action: "click", params: { tabId: 9, selector: "#go" } })');
    assert.equal(tabbed.resolvedTabId, 9);
    assert.equal(harness.sent.at(-1).tabId, 9, "an explicit tab is never overridden");
});

test("a failed request still reports the tab it resolved", async () => {
    const harness = loadBackground({ tabs: [{ id: 4, active: true, windowId: 1 }] });
    harness.call("browser.tabs.sendMessage = async () => ({ data: null, error: 'nope', errorCode: 'target_not_found' })");

    const response = await harness.call('handleRequest({ id: "r1", action: "click", params: { selector: "#go" } })');

    assert.equal(response.success, false);
    assert.equal(response.resolvedTabId, 4);
});

test("tools that act on no tab report none and never default to the active one", async () => {
    const harness = loadBackground({ tabs: [{ id: 4, active: true, windowId: 1 }] });
    harness.call("globalThis.removed = []");
    harness.call("browser.tabs.remove = async (id) => { removed.push(id); }");

    const listing = await harness.call('handleRequest({ id: "r1", action: "tabs_query", params: {} })');
    assert.equal(listing.resolvedTabId, null);

    // `tabs_close` with no tab must not close whatever is in front.
    const close = await harness.call('handleRequest({ id: "r2", action: "tabs_close", params: {} })');
    assert.equal(close.resolvedTabId, null);
    assert.equal(harness.call('removed.join("|")'), "");
});
