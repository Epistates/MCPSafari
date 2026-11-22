import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// `captureVisibleTab` takes a window and returns whichever tab is showing, so a
// user clicking another tab between the activation and the capture gets the
// wrong page's pixels labelled as the right one. `showing` is that tab.
//
// `pinnedActive` models Safari's pinned tabs: a profile's pinned tabs belong to
// every window, and Safari answers an active-tab query for any window with the
// copy of a pinned tab that another window is showing, ahead of the tab this
// window is showing. Each copy has the same id and reports the window that owns
// it. `allTabs` is what a query with no filter returns.
function loadBackground({ showing = 1, afterActivate = () => {}, afterCapture = () => {}, pinnedActive = null, allTabs = [] } = {}) {
    const state = { showing, captures: 0, queries: [] };
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        scripting: { executeScript: async () => [{ result: { visible: true, hasFocus: true } }] },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            get: async (id) => ({ id, active: id === state.showing, windowId: 9, url: "https://ok.example/" }),
            query: async (filter) => {
                state.queries.push({ ...filter });
                if (filter.active !== true) return allTabs;
                const pinned = pinnedActive === null ? [] : [{ id: pinnedActive, active: true, pinned: true, windowId: 4 }];
                if (state.showing === pinnedActive) return pinned;
                return [...pinned, { id: state.showing, active: true, pinned: false, windowId: filter.windowId ?? 9 }];
            },
            update: async (id) => { state.showing = id; afterActivate(state); },
            captureVisibleTab: async () => {
                state.captures += 1;
                afterCapture(state);
                return "data:image/png;base64,AAAB";
            },
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
        Error,
        Promise,
        URL,
        setTimeout: (callback, ms) => { if ((ms || 0) <= 400) queueMicrotask(callback); return 0; },
        WebSocket: class { send() {} },
    });
    vm.runInContext(source, context);

    return { state, call: (expression) => vm.runInContext(expression, context) };
}

async function rejection(promise) {
    try {
        await promise;
        return null;
    } catch (err) {
        return err;
    }
}

test("a screenshot of the tab showing in its window is captured", async () => {
    const { state, call } = loadBackground({ showing: 1 });

    const capture = await call("handleScreenshot({ tabId: 1 })");

    assert.equal(capture.image, "AAAB");
    assert.equal(state.captures, 1);
    // The window's own answer is what is asked for, not the tab's claim.
    assert.ok(state.queries.every((q) => q.active === true && q.windowId === 9));
});

test("a screenshot is not taken if the user switched tabs after the activation", async () => {
    // Tab 1 is activated, then the user clicks tab 2 during the settle wait.
    const { state, call } = loadBackground({
        showing: 2,
        afterActivate: (s) => { s.showing = 2; },
    });

    const err = await rejection(call("handleScreenshot({ tabId: 1 })"));

    assert.equal(err.code, "tab_not_showing");
    assert.equal(err.retryable, true);
    assert.equal(err.recoveryAction, "retry");
    assert.equal(state.captures, 0, "no pixels may be captured from the wrong tab");
});

test("a screenshot is discarded if the tab changed while it was captured", async () => {
    const { state, call } = loadBackground({
        showing: 1,
        afterCapture: (s) => { s.showing = 2; },
    });

    const err = await rejection(call("handleScreenshot({ tabId: 1 })"));

    assert.equal(err.code, "tab_not_showing");
    assert.equal(state.captures, 1);
});

test("native input preparation fails if another tab took over the window", async () => {
    const { call } = loadBackground({
        showing: 1,
        afterActivate: (s) => { s.showing = 2; },
    });

    const err = await rejection(call("focusTabForNativeInput(1)"));

    assert.equal(err.code, "tab_not_showing");
    assert.match(err.message, /native input/);
});

test("native input preparation returns the tab once it is confirmed showing", async () => {
    const { call } = loadBackground({ showing: 1 });

    assert.equal(await call("focusTabForNativeInput(1)"), 1);
});

// Another window showing a pinned tab made every capture and every native call
// fail with tab_not_showing, with nobody touching the keyboard (2026-11-22).
test("a pinned tab another window is showing doesn't count as this window's tab", async () => {
    const { state, call } = loadBackground({ showing: 1, pinnedActive: 50 });

    const capture = await call("handleScreenshot({ tabId: 1 })");

    assert.equal(capture.image, "AAAB");
    assert.equal(state.captures, 1);
    assert.equal(await call("focusTabForNativeInput(1)"), 1);
});

test("switching to another tab is still caught when a pinned tab is showing elsewhere", async () => {
    // Tab 1 is activated, then the user clicks tab 2 during the settle wait.
    const { state, call } = loadBackground({
        showing: 2,
        pinnedActive: 50,
        afterActivate: (s) => { s.showing = 2; },
    });

    const err = await rejection(call("handleScreenshot({ tabId: 1 })"));

    assert.equal(err.code, "tab_not_showing");
    assert.equal(state.captures, 0);
});

test("a pinned tab that is the one showing can be captured", async () => {
    // No unpinned tab is active in the window, so the pinned one is what it shows.
    const { call } = loadBackground({ showing: 50, pinnedActive: 50 });

    const capture = await call("handleScreenshot({ tabId: 50 })");

    assert.equal(capture.image, "AAAB");
});

test("the tab in front is the window's own, not another window's pinned tab", async () => {
    const { call } = loadBackground({ showing: 7, pinnedActive: 50 });

    assert.equal(await call("userActiveTabId()"), 7);
});

test("a pinned tab Safari lists once per window is listed once", async () => {
    const pinned = { id: 50, active: true, pinned: true, windowId: 4, index: 0, url: "https://ok.example/" };
    const own = { id: 7, active: true, pinned: false, windowId: 9, index: 1, url: "https://ok.example/" };
    const { call } = loadBackground({ allTabs: [pinned, { ...pinned }, own] });

    const tabs = await call("handleTabsQuery()");

    assert.deepEqual(tabs.map((t) => t.id), [50, 7]);
});
