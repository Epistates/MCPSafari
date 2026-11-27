import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

const DATA_URL = "data:image/png;base64,AAAB";

// One window showing the user's tab 1, with the agent's tab 7 behind it. Safari
// shows one tab per window, so `active` is kept to one tab as `update` moves it.
function loadBackground({ duringCapture } = {}) {
    const tabs = [
        { id: 1, windowId: 1, active: true, url: "https://user.example/", title: "User" },
        { id: 7, windowId: 1, active: false, url: "https://agent.example/", title: "Agent" },
        { id: 3, windowId: 1, active: false, url: "https://other.example/", title: "Other" },
    ];
    const activations = [];
    const activate = (id) => {
        activations.push(id);
        for (const tab of tabs) tab.active = tab.id === id;
    };
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
            get: async (id) => ({ ...tabs.find((tab) => tab.id === id) }),
            query: async (filter = {}) => tabs.filter((tab) =>
                (filter.active === undefined || tab.active === filter.active)
                && (filter.windowId === undefined || tab.windowId === filter.windowId)),
            update: async (id, info) => { if (info.active) activate(id); },
            captureVisibleTab: async () => {
                if (duringCapture) duringCapture(activate);
                return DATA_URL;
            },
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
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
        activations,
        showing: () => tabs.find((tab) => tab.active).id,
        screenshot: (params) => vm.runInContext(`handleScreenshot(${JSON.stringify(params)})`, context),
    };
}

test("a screenshot of a tab behind another puts the tab that was showing back", async () => {
    const harness = loadBackground();

    const result = await harness.screenshot({ tabId: 7 });

    assert.equal(result.image, "AAAB");
    assert.deepEqual(harness.activations, [7, 1]);
    assert.equal(harness.showing(), 1);
});

test("a screenshot of the tab already showing moves nothing", async () => {
    const harness = loadBackground();

    await harness.screenshot({ tabId: 1 });

    assert.deepEqual(harness.activations, []);
    assert.equal(harness.showing(), 1);
});

// The user, or another agent, chose a tab while the capture ran. Their choice
// stands, and the capture of the wrong page is refused as before.
test("a tab switched to during the capture is left showing", async () => {
    const harness = loadBackground({ duringCapture: (activate) => activate(3) });

    await assert.rejects(harness.screenshot({ tabId: 7 }), (err) => err.code === "tab_not_showing");

    assert.equal(harness.showing(), 3);
});

test("a capture that fails still gives the front tab back", async () => {
    const harness = loadBackground({ duringCapture: () => { throw new Error("capture failed"); } });

    await assert.rejects(harness.screenshot({ tabId: 7 }), /capture failed/);

    assert.equal(harness.showing(), 1);
});
