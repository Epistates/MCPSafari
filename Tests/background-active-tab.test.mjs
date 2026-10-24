import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// The tab a call lands on is decided in one place, and a wrong answer there is
// the worst kind of failure: the call succeeds, on a page nobody meant.
function loadBackground({ tabs = [{ id: 1, active: true, windowId: 1 }], getTab } = {}) {
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
                return { data: "ok", error: null };
            },
            update: async () => {},
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
        webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: "" }] },
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
