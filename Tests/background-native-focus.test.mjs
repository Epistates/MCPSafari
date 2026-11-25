import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// The page refuses native input when Safari's own controls hold the keyboard.
// The server can move the keyboard into the page through Accessibility, but only
// after it has confirmed that the window in front is this tab's, so the refusal
// carries the window's frame and the tab's title for it to check.
function loadBackground({ contentReply }) {
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
            query: async () => [{ id: 7, active: true, windowId: 3 }],
            get: async (id) => ({ id, active: true, windowId: 3, url: "https://forms.example/apply", title: "Nominations" }),
            update: async () => {},
            sendMessage: async (_tabId, message) => contentReply(message.action),
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
            onActivated: { addListener() {} },
        },
        action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {}, setTitle: async () => {} },
        webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: "https://forms.example/apply" }] },
        windows: {
            update: async () => {},
            get: async (id) => ({ id, left: 40, top: 60, width: 1200, height: 900, state: "normal", focused: true }),
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
    return (action, params) => vm.runInContext(
        `handleRequest(${JSON.stringify({ id: "r1", action, params: { tabId: 7, ...params } })})`,
        context
    );
}

const unfocused = () => ({
    data: null,
    error: "The page does not have focus, so native key events would go to whatever does",
    errorCode: "native_input_focus_failed",
    retryable: true,
    recoveryAction: "retry",
});

for (const [action, params] of [
    ["native_press_key", { key: "a" }],
    ["native_type_text", { selector: "#q", text: "x" }],
    ["native_pointer", { selector: "#q" }],
]) {
    test(`a ${action} refused for page focus names the tab's window for the server to check`, async () => {
        const request = loadBackground({ contentReply: unfocused });

        const response = await request(action, params);

        assert.equal(response.success, false);
        assert.equal(response.errorCode, "native_input_focus_failed");
        assert.deepEqual(JSON.parse(response.data), {
            nativeTarget: { left: 40, top: 60, width: 1200, height: 900, title: "Nominations" },
        });
    });
}

test("a native refusal for any other reason carries nothing for the server", async () => {
    const request = loadBackground({
        contentReply: () => ({
            data: null,
            error: "Native typing requires an editable text control; received <div>",
            errorCode: "unsupported_native_target",
            retryable: false,
            recoveryAction: "use_synthetic_input",
        }),
    });

    const response = await request("native_type_text", { selector: "#q", text: "x" });

    assert.equal(response.errorCode, "unsupported_native_target");
    assert.equal(response.data, null);
});
