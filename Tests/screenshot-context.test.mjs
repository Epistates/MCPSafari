import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/background.js", import.meta.url),
    "utf8"
);

const DATA_URL = "data:image/png;base64,AAAB";

// Background harness with just enough browser API for handleScreenshot. `page`
// stands in for the globals the injected context function reads.
function loadBackground({ executeScript, page = {}, captureVisibleTab }) {
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        scripting: { executeScript },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            get: async (id) => ({ id, active: true, windowId: 1 }),
            captureVisibleTab: captureVisibleTab ?? (async () => DATA_URL),
            onUpdated: { addListener() {}, removeListener() {} },
            update: async () => {},
        },
    };

    const context = vm.createContext({
        browser,
        clearTimeout() {},
        console: { error() {}, log() {}, warn() {} },
        Date,
        document: {
            visibilityState: page.visibilityState ?? "visible",
            hasFocus: () => page.hasFocus ?? true,
        },
        Promise,
        setTimeout: () => {},
        WebSocket: class { send() {} },
        window: {
            innerWidth: page.innerWidth ?? 1200,
            innerHeight: page.innerHeight ?? 828,
            devicePixelRatio: page.devicePixelRatio ?? 2,
        },
    });
    vm.runInContext(source, context);

    return (expression) => vm.runInContext(expression, context);
}

test("screenshot reports viewport, scale, visibility, and focus with the image", async () => {
    const evaluate = loadBackground({
        executeScript: async () => [{
            result: {
                visible: false,
                hasFocus: false,
                viewport: { width: 1200, height: 828 },
                devicePixelRatio: 2,
            },
        }],
    });

    const capture = await evaluate("handleScreenshot({ tabId: 1 })");

    assert.equal(capture.image, "AAAB");
    assert.equal(capture.visible, false);
    assert.equal(capture.hasFocus, false);
    assert.deepEqual(capture.viewport, { width: 1200, height: 828 });
    assert.equal(capture.devicePixelRatio, 2);
});

test("the injected context function reads visibility, focus, and viewport from the page", async () => {
    const evaluate = loadBackground({
        // Run the real injected function instead of stubbing its result.
        executeScript: async ({ func }) => [{ result: func() }],
        page: {
            visibilityState: "hidden",
            hasFocus: false,
            innerWidth: 900,
            innerHeight: 600,
            devicePixelRatio: 1,
        },
    });

    const capture = await evaluate("handleScreenshot({ tabId: 1 })");

    assert.equal(capture.visible, false);
    assert.equal(capture.hasFocus, false);
    // Field-wise: the viewport object comes from the VM realm, so a deep
    // comparison against a plain object fails on the prototype alone.
    assert.equal(capture.viewport.width, 900);
    assert.equal(capture.viewport.height, 600);
    assert.equal(capture.devicePixelRatio, 1);
});

test("page context is read before the frame, not after it", async () => {
    const order = [];
    const evaluate = loadBackground({
        executeScript: async () => {
            order.push("context");
            return [{ result: { visible: true, hasFocus: true } }];
        },
        captureVisibleTab: async () => {
            order.push("capture");
            return DATA_URL;
        },
    });

    await evaluate("handleScreenshot({ tabId: 1 })");

    // Reading state after the frame can report a page as focused when it lost
    // focus during the capture, which is a false all-clear.
    assert.deepEqual(order, ["context", "capture"]);
});

test("screenshot still returns the image when page context is unavailable", async () => {
    const evaluate = loadBackground({
        executeScript: async () => { throw new Error("cannot access page"); },
    });

    const capture = await evaluate("handleScreenshot({ tabId: 1 })");

    assert.equal(capture.image, "AAAB");
    assert.deepEqual(Object.keys(capture), ["image"]);
});
