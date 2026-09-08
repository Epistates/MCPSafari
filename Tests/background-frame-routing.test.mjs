import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/background.js", import.meta.url),
    "utf8"
);

const TOP = { frameId: 0, parentFrameId: -1, url: "https://top.example/" };
const EMBED = { frameId: 3, parentFrameId: 0, url: "https://embed.example/form" };

// Every message the router sends is recorded with the frame it was aimed at,
// so the assertions can check routing and not just the returned value.
function loadBackground({ frames = [TOP, EMBED], respond }) {
    const sent = [];
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        scripting: { executeScript: async () => [] },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            query: async () => [{ id: 1, active: true, windowId: 1 }],
            get: async () => ({ id: 1, url: TOP.url, title: "Top", windowId: 1 }),
            update: async () => {},
            sendMessage: async (tabId, message, options) => {
                const frameId = options ? options.frameId : 0;
                sent.push({ tabId, frameId, action: message.action, params: message.params });
                return respond(frameId, message);
            },
            onUpdated: { addListener() {}, removeListener() {} },
        },
        webNavigation: { getAllFrames: async () => frames },
        windows: { update: async () => {} },
    };

    const context = vm.createContext({
        browser,
        clearTimeout,
        console: { error() {}, log() {}, warn() {} },
        Date,
        Promise,
        // The delay() after a re-injection has to resolve or the router hangs.
        // The reconnect backoff must not, or the harness loops forever.
        setTimeout: (fn, ms) => {
            if ((ms || 0) <= 200) queueMicrotask(fn);
            return 0;
        },
        WebSocket: class { send() {} },
    });
    vm.runInContext(source, context);

    return {
        sent,
        call: (expression) => vm.runInContext(expression, context),
    };
}

const ok = (data) => ({ data, error: null });

function topTree() {
    return {
        uid: "f0e1",
        tag: "body",
        children: [
            { uid: "f0e6", tag: "h1", text: "Checkout" },
            { uid: "f0e7", tag: "iframe", frameSrc: EMBED.url },
        ],
    };
}

const embedTree = () => ({
    uid: "f3e1",
    tag: "body",
    children: [{ uid: "f3e2", tag: "input", role: "textbox" }],
});

test("a uid routes to the frame that minted it", async () => {
    const { call, sent } = loadBackground({ respond: () => ok("Clicked <input>") });

    await call('dispatchToContent("click", { tabId: 1, uid: "f3e2" })');

    assert.equal(sent.length, 1, "a uid should not need a search");
    assert.equal(sent[0].frameId, 3);
    assert.equal(sent[0].action, "click");
});

test("a top-frame uid still goes to frame 0", async () => {
    const { call, sent } = loadBackground({ respond: () => ok("Clicked <button>") });

    await call('dispatchToContent("click", { tabId: 1, uid: "f0e7" })');

    assert.equal(sent[0].frameId, 0);
});

test("snapshot hangs each frame's tree on the iframe that hosts it", async () => {
    const { call } = loadBackground({
        respond: (frameId) => ok(frameId === 0 ? topTree() : embedTree()),
    });

    const tree = await call('dispatchToContent("snapshot", { tabId: 1 })');
    const iframe = tree.children.find((c) => c.tag === "iframe");

    assert.ok(iframe, "the iframe node should survive splicing");
    assert.equal(iframe.children.length, 1);
    assert.equal(iframe.children[0].children[0].uid, "f3e2");
    // The marker exists to match frames, so it does not reach the caller.
    assert.equal("frameSrc" in iframe, false);
    assert.equal(tree.unmatchedFrames, undefined);
});

test("a frame whose host cannot be identified is attached, not dropped", async () => {
    const orphan = { frameId: 4, parentFrameId: 0, url: "https://other.example/widget" };
    const { call } = loadBackground({
        frames: [TOP, orphan],
        respond: (frameId) => ok(frameId === 0 ? topTree() : embedTree()),
    });

    const tree = await call('dispatchToContent("snapshot", { tabId: 1 })');

    assert.equal(tree.unmatchedFrames, 1);
    assert.ok(
        tree.children.some((c) => c.children?.[0]?.uid === "f3e2"),
        "the unmatched frame's content should still be reachable"
    );
});

test("find fans out and returns matches from every frame", async () => {
    const { call, sent } = loadBackground({
        respond: (frameId) =>
            ok(frameId === 0
                ? [{ uid: "f0e6", tag: "h1" }]
                : [{ uid: "f3e2", tag: "input" }]),
    });

    const results = await call('dispatchToContent("find", { tabId: 1, text: "a" })');

    // Arrays built inside the vm carry that realm's prototype, so copy first.
    assert.deepEqual([...results].map((r) => r.uid), ["f0e6", "f3e2"]);
    assert.deepEqual(sent.map((s) => s.frameId), [0, 3]);
});

test("a selector target searches frames until one resolves it", async () => {
    // The top frame does not have the element; the router must keep going.
    const { call, sent } = loadBackground({
        respond: (frameId) => {
            if (frameId === 0) return { data: null, error: "No element found", errorCode: "target_not_found" };
            return ok("Clicked <input>");
        },
    });

    const result = await call('dispatchToContent("click", { tabId: 1, selector: "#card" })');

    assert.equal(result, "Clicked <input>");
    assert.deepEqual(sent.map((s) => s.frameId), [0, 3]);
});

test("a subframe that refuses the content script does not fail the whole read", async () => {
    const { call } = loadBackground({
        respond: (frameId) => {
            if (frameId === 0) return ok([{ uid: "f0e6", tag: "h1" }]);
            throw new Error("Could not establish connection");
        },
    });

    const results = await call('dispatchToContent("find", { tabId: 1, text: "a" })');

    assert.deepEqual([...results].map((r) => r.uid), ["f0e6"]);
});

test("the content script is told which frame it is answering for", async () => {
    const { call, sent } = loadBackground({ respond: () => ok(null) });

    await call('dispatchToContent("click", { tabId: 1, uid: "f3e2" })');

    // The uid counter in that frame depends on this arriving with the request.
    assert.equal(sent[0].frameId, 3);
});

test("native input refuses a subframe target instead of clicking the wrong point", async () => {
    const { call } = loadBackground({ respond: () => ok(null) });

    await assert.rejects(
        () => call('handleNativePointer({ tabId: 1, uid: "f3e2" })'),
        /top frame only/i
    );

    // A top-frame uid is still allowed through.
    await call('handleNativePointer({ tabId: 1, uid: "f0e7" })');
});
