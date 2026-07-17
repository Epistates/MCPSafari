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

function contentHarness() {
    let listener;
    const context = vm.createContext({
        browser: {
            runtime: {
                onMessage: { addListener: (value) => { listener = value; } },
            },
        },
        document: {
            activeElement: null,
            body: { innerText: "" },
            createTreeWalker: () => ({ nextNode: () => null }),
            elementFromPoint: () => null,
            querySelector: () => null,
        },
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
    const browser = {
        alarms: {
            create() {},
            onAlarm: { addListener() {} },
        },
        runtime: {
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            get: async () => ({ id: 1 }),
            sendMessage: async () => contentResponses.shift(),
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
    return (request) => vm.runInContext(
        `handleRequest(${JSON.stringify(request)})`,
        context
    );
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
