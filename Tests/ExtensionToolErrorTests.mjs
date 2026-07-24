import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const contentSource = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/content.js", import.meta.url),
    "utf8"
);
const backgroundSource = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/background.js", import.meta.url),
    "utf8"
);

function contentHarness(document = {
    activeElement: null,
    body: { innerText: "" },
    createTreeWalker: () => ({ nextNode: () => null }),
    elementFromPoint: () => null,
    querySelector: () => null,
}) {
    let listener;
    const context = vm.createContext({
        browser: {
            runtime: {
                onMessage: { addListener: (value) => { listener = value; } },
            },
        },
        document,
        setTimeout,
        clearTimeout,
        window: {},
    });
    vm.runInContext(contentSource, context);

    return (action, params) => new Promise((resolve) => {
        listener({ action, params }, {}, resolve);
    });
}

function backgroundHarness(contentResponse) {
    const contentResponses = Array.isArray(contentResponse)
        ? [...contentResponse]
        : [contentResponse];
    const tabUpdates = [];
    const windowUpdates = [];
    const browser = {
        alarms: {
            create() {},
            onAlarm: { addListener() {} },
        },
        runtime: {
            getManifest: () => ({ version: "0.2.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            get: async () => ({ id: 1, windowId: 7 }),
            sendMessage: async () => contentResponses.shift(),
            update: async (...args) => { tabUpdates.push(args); },
        },
        windows: {
            update: async (...args) => { windowUpdates.push(args); },
        },
        scripting: { executeScript: async () => {} },
    };
    const context = vm.createContext({
        browser,
        console: { error() {}, log() {}, warn() {} },
        Promise,
        setTimeout: (callback) => callback(),
        clearTimeout() {},
        WebSocket: class { static OPEN = 1; static CONNECTING = 0; },
    });
    vm.runInContext(backgroundSource, context);
    const handleRequest = (request) => vm.runInContext(
        `handleRequest(${JSON.stringify(request)})`,
        context
    );
    handleRequest.tabUpdates = tabUpdates;
    handleRequest.windowUpdates = windowUpdates;
    return handleRequest;
}

test("content errors identify stale UIDs and missing targets", async () => {
    const call = contentHarness();

    const stale = await call("click", { uid: "e999" });
    assert.equal(stale.errorCode, "stale_uid");
    assert.equal(stale.retryable, false);
    assert.equal(stale.recoveryAction, "take_snapshot");

    const missing = await call("click", { selector: "#missing" });
    assert.equal(missing.errorCode, "target_not_found");
    assert.equal(missing.retryable, false);
    assert.equal(missing.recoveryAction, "take_snapshot");
});

test("wait timeouts are retryable", async () => {
    const response = await contentHarness()("wait", {
        selector: "#later",
        timeout: 0.001,
    });

    assert.equal(response.errorCode, "wait_timeout");
    assert.equal(response.retryable, true);
    assert.equal(response.recoveryAction, "retry");
});

test("background preserves content error metadata in bridge responses", async () => {
    const handleRequest = backgroundHarness({
        data: null,
        error: "UID expired",
        errorCode: "stale_uid",
        retryable: false,
        recoveryAction: "take_snapshot",
    });

    const response = await handleRequest({
        id: "request-1",
        action: "click",
        params: { tabId: 1, uid: "e999" },
    });

    assert.equal(response.success, false);
    assert.equal(response.errorCode, "stale_uid");
    assert.equal(response.retryable, false);
    assert.equal(response.recoveryAction, "take_snapshot");
});

test("background reinjects when Safari returns no content response", async () => {
    const handleRequest = backgroundHarness([null, {
        data: null,
        error: "UID expired",
        errorCode: "stale_uid",
        retryable: false,
        recoveryAction: "take_snapshot",
    }]);

    const response = await handleRequest({
        id: "request-1",
        action: "click",
        params: { tabId: 1, uid: "e999" },
    });

    assert.equal(response.errorCode, "stale_uid");
    assert.equal(response.recoveryAction, "take_snapshot");
});

test("native input preparation focuses only editable text targets", async () => {
    const document = { activeElement: null };
    const editor = {
        contains: (element) => element === editor,
        disabled: false,
        focus: () => { document.activeElement = editor; },
        isContentEditable: true,
        readOnly: false,
        scrollIntoView() {},
        tagName: "DIV",
    };
    document.querySelector = () => editor;
    const call = contentHarness(document);

    const focused = await call("prepare_native_input", { selector: "#editor" });
    assert.equal(focused.error, null);
    assert.equal(focused.data, "Focused <div> for native typing");

    document.querySelector = () => ({
        disabled: false,
        isContentEditable: false,
        readOnly: false,
        tagName: "BUTTON",
    });
    const unsupported = await call("prepare_native_input", { selector: "button" });
    assert.equal(unsupported.errorCode, "unsupported_native_target");
    assert.equal(unsupported.recoveryAction, "use_synthetic_input");
});

test("native input preparation foregrounds the target Safari tab", async () => {
    const handleRequest = backgroundHarness({ data: "Focused", error: null });
    const response = await handleRequest({
        id: "request-1",
        action: "native_type_text",
        params: { tabId: 1, selector: "#editor", text: "/hello" },
    });

    assert.equal(response.success, true);
    assert.equal(response.data, "Safari is ready for native input");
    assert.equal(handleRequest.tabUpdates.length, 1);
    assert.equal(handleRequest.tabUpdates[0][0], 1);
    assert.equal(handleRequest.tabUpdates[0][1].active, true);
    assert.equal(handleRequest.windowUpdates.length, 1);
    assert.equal(handleRequest.windowUpdates[0][0], 7);
    assert.equal(handleRequest.windowUpdates[0][1].focused, true);
});
