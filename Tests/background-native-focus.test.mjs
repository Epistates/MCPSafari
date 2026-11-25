import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { createHash } from "node:crypto";

import { handshakeGlobals } from "./helpers/bridge-handshake.mjs";
import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// The page refuses native input when Safari's own controls hold the keyboard.
// The server can move the keyboard into the page through Accessibility, but only
// after it has confirmed that the window in front is this tab's, so the refusal
// carries the window's frame and the tab's title for it to check.
function loadBackground({ contentReply, url = "https://forms.example/apply" }) {
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
            get: async (id) => ({ id, active: true, windowId: 3, url, title: "Nominations" }),
            update: async () => {},
            sendMessage: async (_tabId, message) => contentReply(message.action),
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
            onActivated: { addListener() {} },
        },
        action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setBadgeTextColor: async () => {}, setTitle: async () => {} },
        webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url }] },
        windows: {
            update: async () => {},
            get: async (id) => ({ id, left: 40, top: 60, width: 1200, height: 900, state: "normal", focused: true }),
        },
    };
    const context = vm.createContext({
        // The address goes to the server as a SHA-256 digest, which needs WebCrypto.
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
            nativeTarget: { left: 40, top: 60, width: 1200, height: 900, title: "Nominations", urlDigest: digest("https://forms.example/apply") },
        });
    });
}

const digest = (text) => createHash("sha256").update(text).digest("hex");

// The address itself never crosses the bridge, and its fragment is left out:
// the server compares against the page's address, which a jump within the page
// doesn't change.
test("the tab's address goes to the server as a digest without its fragment", async () => {
    const request = loadBackground({ contentReply: unfocused, url: "https://forms.example/apply?token=s3cret#dates" });

    const response = await request("native_press_key", { key: "a" });

    assert.equal(JSON.parse(response.data).nativeTarget.urlDigest, digest("https://forms.example/apply?token=s3cret"));
    assert.equal(response.data.includes("s3cret"), false);
});

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

// Safari measures screenY from the top of the window's own display, so the
// points' own screen guess is off on a second display. The server places them
// from where Accessibility shows this window's page, and checks that the window
// under them is this one, so every pointer result names the window as well.
test("native pointer points come with the tab's window for the server to place them in", async () => {
    const request = loadBackground({
        contentReply: () => ({ data: { from: { x: 160, y: 290, pageX: 60, pageY: 65 } }, error: null }),
    });

    const response = await request("native_pointer", { selector: "#q" });

    assert.equal(response.success, true);
    assert.deepEqual(JSON.parse(response.data), {
        from: { x: 160, y: 290, pageX: 60, pageY: 65 },
        nativeTarget: { left: 40, top: 60, width: 1200, height: 900, title: "Nominations", urlDigest: digest("https://forms.example/apply") },
    });
});
