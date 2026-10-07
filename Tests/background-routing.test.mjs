import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

function loadBackground() {
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
            get: async (id) => ({ id, active: true, windowId: 1, url: "https://ok.example/" }),
            query: async () => [{ id: 1, active: true, windowId: 1 }],
            sendMessage: async (tabId, message) => {
                sent.push({ tabId, message });
                return { data: "ok", error: null };
            },
            remove: async () => {},
            update: async () => {},
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
        webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1 }] },
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
        WebSocket: class {
            static CONNECTING = 0;
            static OPEN = 1;
            send() {}
            close() {}
        },
    });
    vm.runInContext(source, context);

    return {
        sent,
        request: (action, params = {}) => vm.runInContext(
            `handleRequest(${JSON.stringify({ id: "r1", action, params })})`,
            context
        ),
    };
}

test("an action nobody serves is refused rather than guessed at", async () => {
    const response = await loadBackground().request("no_such_tool", { tabId: 1 });

    assert.equal(response.success, false);
    assert.equal(response.error, "Unknown action: no_such_tool");
    assert.equal(response.errorCode, "extension_error");
    assert.equal(response.recoveryAction, "inspect_error");
});

// The action name arrives off the WebSocket. The dispatch tables are Maps for
// this reason: as plain object literals, every one of these names would have
// resolved through Object.prototype to an inherited function and been called as
// though it were a handler.
for (const inherited of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
    test(`an action named ${inherited} is refused like any other unknown action`, async () => {
        const harness = loadBackground();
        const response = await harness.request(inherited, { tabId: 1 });

        assert.equal(response.success, false);
        assert.equal(response.error, `Unknown action: ${inherited}`);
        assert.equal(harness.sent.length, 0, "nothing should have been sent to the page");
    });
}

test("an action the content script owns is handed to the page", async () => {
    const harness = loadBackground();
    const response = await harness.request("click", { tabId: 1, selector: "#go" });

    assert.equal(response.success, true);
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.sent[0].message.action, "click");
});

test("read_console is renamed and its arguments defaulted before the page sees it", async () => {
    const harness = loadBackground();
    await harness.request("read_console", { tabId: 1 });

    assert.equal(harness.sent.length, 1);
    // The content script answers `get_console_messages`, and the defaults are
    // filled here so it never has to guess at a missing filter.
    assert.equal(harness.sent[0].message.action, "get_console_messages");
    // Compared field by field: the object is built inside the vm realm, and
    // strict deep equality counts that different prototype as a difference.
    const params = harness.sent[0].message.params;
    assert.equal(params.level, "all");
    assert.equal(params.pattern, null);
    assert.equal(params.clear, false);
});

test("read_network passes a zero status through rather than defaulting it", async () => {
    const harness = loadBackground();
    await harness.request("read_network", { tabId: 1, status: 0 });

    // `||` would have turned 0 into null here, so the nullish coalesce is doing
    // real work: 0 is not a status anyone filters on, but the distinction is the
    // difference between "no filter" and "this filter".
    assert.equal(harness.sent[0].message.params.status, 0);
    assert.equal(harness.sent[0].message.params.type, "all");
});
