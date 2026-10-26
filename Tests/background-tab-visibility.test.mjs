import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// `captureVisibleTab` takes a window and returns whichever tab is showing, so a
// user clicking another tab between the activation and the capture gets the
// wrong page's pixels labelled as the right one. `showing` is that tab.
function loadBackground({ showing = 1, afterActivate = () => {}, afterCapture = () => {} } = {}) {
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
                return [{ id: state.showing, active: true, windowId: filter.windowId }];
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
