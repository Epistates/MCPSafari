import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const background = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/background.js", import.meta.url),
    "utf8"
);
const content = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/content.js", import.meta.url),
    "utf8"
);

// Background harness: records what reaches the content script and in what
// order relative to the frame capture.
function loadBackground({ contentReply }) {
    const log = [];
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        scripting: {
            executeScript: async () => {
                log.push("context");
                return [{ result: { visible: true, hasFocus: true } }];
            },
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            get: async (id) => ({ id, active: true, windowId: 1 }),
            captureVisibleTab: async () => {
                log.push("capture");
                return "data:image/png;base64,AAAB";
            },
            sendMessage: async (_tabId, message) => {
                log.push(`content:${message.action}`);
                return contentReply(message);
            },
            onUpdated: { addListener() {}, removeListener() {} },
            update: async () => {},
        },
    };
    const context = vm.createContext({
        browser,
        clearTimeout() {},
        console: { error() {}, log() {}, warn() {} },
        Date,
        Promise,
        setTimeout: () => {},
        WebSocket: class { send() {} },
    });
    vm.runInContext(background, context);
    return { evaluate: (expression) => vm.runInContext(expression, context), log };
}

test("screenshot with uid asks the content script for the element rect before the frame", async () => {
    const { evaluate, log } = loadBackground({
        contentReply: (message) => {
            assert.deepEqual({ ...message.params }, { uid: "e7", selector: undefined });
            return { data: { x: 10, y: 20, width: 30, height: 40 }, error: null };
        },
    });

    const capture = await evaluate('handleScreenshot({ tabId: 1, uid: "e7" })');

    assert.deepEqual(log, ["content:element_rect", "context", "capture"]);
    assert.equal(capture.image, "AAAB");
    assert.equal(capture.target.x, 10);
    assert.equal(capture.target.height, 40);
});

test("screenshot without a target never touches the content script", async () => {
    const { evaluate, log } = loadBackground({
        contentReply: () => { throw new Error("must not be called"); },
    });

    const capture = await evaluate("handleScreenshot({ tabId: 1 })");

    assert.deepEqual(log, ["context", "capture"]);
    assert.equal("target" in capture, false);
});

test("a content-script rect error fails the screenshot with its code", async () => {
    const { evaluate, log } = loadBackground({
        contentReply: () => ({
            data: null,
            error: "No element found for uid: e9",
            errorCode: "stale_uid",
            retryable: false,
            recoveryAction: "take_snapshot",
        }),
    });

    await assert.rejects(evaluate('handleScreenshot({ tabId: 1, uid: "e9" })'), (err) => {
        assert.equal(err.code, "stale_uid");
        return true;
    });
    assert.deepEqual(log, ["content:element_rect"]);
});

// Content harness: one element, resolvable by selector, with a controllable rect.
// `settled`, when given, is the rect a scroll handler produces after the
// scroll; the frame callback stands in for that handler having run.
function loadContent(rect, settled, { paints = true } = {}) {
    let listener;
    const scrolls = [];
    let current = rect;
    const element = {
        nodeType: 1,
        tagName: "DIV",
        getAttribute: () => null,
        getBoundingClientRect: () => current,
        scrollIntoView: (options) => scrolls.push(options),
    };
    vm.runInNewContext(content, {
        browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
        document: {
            body: element,
            querySelector: (selector) => (selector === "#row" ? element : null),
            querySelectorAll: () => [],
        },
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
        WeakRef,
        setTimeout,
        clearTimeout,
        requestAnimationFrame: (callback) => {
            if (!paints) return 0;
            return setTimeout(() => {
                if (settled) current = settled;
                callback();
            }, 0);
        },
        window: { addEventListener() {}, removeEventListener() {}, postMessage() {} },
    });
    const call = (action, params) => new Promise((r) => listener({ action, params }, {}, r));
    call.scrolls = scrolls;
    return call;
}

test("element_rect scrolls the target into view and returns its rect", async () => {
    const call = loadContent({ left: 12.5, top: 300, width: 200, height: 40 });

    const { data, error } = await call("element_rect", { selector: "#row" });

    assert.equal(error, null);
    // Plain-object copies: the VM realm's objects carry a different prototype.
    assert.deepEqual({ ...data }, { x: 12.5, y: 300, width: 200, height: 40 });
    assert.deepEqual(call.scrolls.map((s) => ({ ...s })), [{ behavior: "instant", block: "center", inline: "center" }]);
});

test("element_rect measures after the frame in which scroll handlers run", async () => {
    const call = loadContent({ left: 0, top: 300, width: 200, height: 40 }, { left: 0, top: 240, width: 200, height: 40 });

    const { data } = await call("element_rect", { selector: "#row" });

    // A collapsing header moved the target 60px up after the scroll.
    assert.equal(data.y, 240);
});

test("element_rect still returns when the page never paints", async () => {
    // A hidden page runs no animation frames; only the timeout fallback fires.
    const call = loadContent({ left: 0, top: 0, width: 5, height: 5 }, null, { paints: false });
    const started = Date.now();
    const { data } = await call("element_rect", { selector: "#row" });
    assert.equal(data.width, 5);
    assert.ok(Date.now() - started < 1000);
});

test("element_rect refuses an element with no rendered size", async () => {
    const call = loadContent({ left: 0, top: 0, width: 0, height: 0 });

    const { data, error, errorCode } = await call("element_rect", { selector: "#row" });

    assert.equal(data, null);
    assert.match(error, /no rendered size/);
    assert.equal(errorCode, "target_not_found");
});

test("element_rect reports a missing target", async () => {
    const call = loadContent({ left: 0, top: 0, width: 5, height: 5 });

    const { errorCode } = await call("element_rect", { selector: "#missing" });

    assert.equal(errorCode, "target_not_found");
});
