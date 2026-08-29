import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/content.js", import.meta.url),
    "utf8"
);

const ELEMENT_NODE = 1;

function el(tag, id) {
    const node = {
        nodeType: ELEMENT_NODE,
        tagName: tag.toUpperCase(),
        attributes: {},
        hidden: false,
        id: id || "",
        childNodes: [],
        textContent: "",
        getAttribute: () => null,
        getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
        scrollIntoView() {},
        focus() {},
        dispatchEvent() { return true; },
    };
    Object.defineProperty(node, "children", {
        get: () => node.childNodes.filter((c) => c.nodeType === ELEMENT_NODE),
    });
    return node;
}

// Drives collection by hand: nothing here is left to a real GC.
function loadContent(body) {
    let listener;
    const registrations = [];
    let finalizerCallback;
    const collected = new Set();

    class ControlledWeakRef {
        constructor(target) { this.target = target; }
        deref() { return collected.has(this.target) ? undefined : this.target; }
    }

    class ControlledFinalizationRegistry {
        constructor(callback) { finalizerCallback = callback; }
        register(target, token) { registrations.push({ target, token }); }
    }

    vm.runInNewContext(source, {
        browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
        document: {
            body,
            documentElement: body,
            activeElement: null,
            getElementById: () => null,
            querySelector: () => null,
            querySelectorAll: () => [],
            createTreeWalker(root, _show, filter) {
                const queue = [...root.childNodes];
                return {
                    nextNode() {
                        while (queue.length) {
                            const n = queue.shift();
                            if (filter.acceptNode(n) === 1) return n;
                        }
                        return null;
                    },
                };
            },
        },
        Node: { ELEMENT_NODE, TEXT_NODE: 3 },
        NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
        WeakRef: ControlledWeakRef,
        FinalizationRegistry: ControlledFinalizationRegistry,
        setTimeout,
        clearTimeout,
        window: {
            addEventListener: () => {},
            removeEventListener: () => {},
            postMessage: () => {},
            innerHeight: 800,
            getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
        },
    });

    return {
        call: (action, params) => new Promise((r) => listener({ action, params }, {}, r)),
        registrations,
        collect: (node) => collected.add(node),
        runFinalizer: (token) => finalizerCallback(token),
    };
}

const uidFor = (registrations, node) =>
    registrations.find((r) => r.target === node)?.token;

test("every minted uid is registered for cleanup", async () => {
    const first = el("button");
    const second = el("button");
    const body = el("body");
    body.childNodes = [first, second];
    const { call, registrations } = loadContent(body);

    await call("snapshot", {});

    // Registered against the element, so the token is dropped when it goes.
    assert.equal(registrations.length, 3, "body and both buttons");
    for (const node of [body, first, second]) {
        assert.match(uidFor(registrations, node) ?? "", /^e\d+$/);
    }
});

test("a uid whose element was collected stops resolving", async () => {
    const button = el("button");
    const body = el("body");
    body.childNodes = [button];
    const { call, registrations, collect, runFinalizer } = loadContent(body);

    await call("snapshot", {});
    const uid = uidFor(registrations, button);

    collect(button);
    runFinalizer(uid);

    const response = await call("click", { uid });
    assert.equal(response.errorCode, "stale_uid");
});

test("a collected element is swept on read even before the finalizer runs", async () => {
    // Finalization is not prompt, so the read path cannot assume it has happened.
    const button = el("button");
    const body = el("body");
    body.childNodes = [button];
    const { call, registrations, collect } = loadContent(body);

    await call("snapshot", {});
    const uid = uidFor(registrations, button);

    collect(button);

    const response = await call("click", { uid });
    assert.equal(response.errorCode, "stale_uid");
});
