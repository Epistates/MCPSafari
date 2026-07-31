import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/content.js", import.meta.url),
    "utf8"
);

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

// Minimal DOM stand-ins, same shape as content-tool-safety.test.mjs, plus the
// event constructors and MutationObserver the input handlers use.
function text(value) {
    return { nodeType: TEXT_NODE, textContent: value };
}

function el(tag, options = {}, children = []) {
    const node = {
        nodeType: ELEMENT_NODE,
        tagName: tag.toUpperCase(),
        attributes: options.attributes || {},
        hidden: false,
        id: options.id || "",
        childNodes: children,
        getAttribute(name) {
            return name in this.attributes ? this.attributes[name] : null;
        },
        getBoundingClientRect: () => ({ left: 0, top: 0, x: 0, y: 0, width: 10, height: 10 }),
        scrollIntoView() {},
        focus() {},
        dispatchEvent() { return true; },
        ...options.extra,
    };
    Object.defineProperty(node, "children", {
        get: () => node.childNodes.filter((c) => c.nodeType === ELEMENT_NODE),
    });
    if (!("textContent" in (options.extra || {}))) {
        Object.defineProperty(node, "textContent", {
            get: () => node.childNodes.map((c) => c.textContent).join(""),
        });
    }
    return node;
}

class FakeDataTransfer {
    constructor() {
        this.items = [];
    }
}

class FakeMutationObserver {
    constructor(callback) {
        this.callback = callback;
        this.records = [];
    }
    observe() {
        FakeMutationObserver.active = this;
    }
    disconnect() {
        if (FakeMutationObserver.active === this) FakeMutationObserver.active = null;
    }
    takeRecords() {
        // Mirror the real DOM: queued records are delivered to the callback,
        // not held for takeRecords, so the handler must count callback deliveries.
        const records = this.records;
        this.records = [];
        if (records.length > 0) this.callback(records);
        return [];
    }
    // Test hook: simulate the page reacting to the synthetic gesture.
    mutate(record = { type: "childList" }) {
        this.records.push(record);
    }
}
FakeMutationObserver.active = null;

function loadContent(body, documentOverrides = {}, windowOverrides = {}) {
    let listener;
    const document = {
        body,
        documentElement: body,
        activeElement: null,
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        elementFromPoint: () => null,
        execCommand: () => false,
        createRange: () => ({ selectNodeContents() {}, collapse() {} }),
        createTreeWalker(root, _show, filter) {
            const queue = [];
            const collect = (n) => { for (const c of n.children) { queue.push(c); collect(c); } };
            collect(root);
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
        ...documentOverrides,
    };

    class FakeEvent {
        constructor(type, options = {}) {
            this.type = type;
            Object.assign(this, options);
        }
    }

    const scrolls = [];
    vm.runInNewContext(source, {
        browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
        document,
        Node: { ELEMENT_NODE, TEXT_NODE },
        NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
        WeakRef,
        setTimeout,
        clearTimeout,
        Event: FakeEvent,
        KeyboardEvent: FakeEvent,
        MouseEvent: FakeEvent,
        PointerEvent: FakeEvent,
        DragEvent: FakeEvent,
        InputEvent: FakeEvent,
        DataTransfer: FakeDataTransfer,
        MutationObserver: FakeMutationObserver,
        HTMLInputElement: class {},
        HTMLTextAreaElement: class {},
        window: {
            addEventListener: () => {},
            removeEventListener: () => {},
            postMessage: () => {},
            innerHeight: 800,
            scrollBy: (options) => scrolls.push(options),
            getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
            getSelection: () => ({
                rangeCount: 0,
                removeAllRanges() {},
                addRange() {},
                getRangeAt() { return null; },
            }),
            ...windowOverrides,
        },
    });

    const call = (action, params) => new Promise((r) => listener({ action, params }, {}, r));
    call.scrolls = scrolls;
    return call;
}

function pressedKeys() {
    const events = [];
    const body = el("body", {}, []);
    body.dispatchEvent = (event) => { events.push(event.type); return true; };
    const call = loadContent(body, { activeElement: null, body });
    return { events, call };
}

// ─── press_key keypress fidelity ─────────────────────────────────────

test("press_key fires keypress only for character-producing keys", async () => {
    const { events, call } = pressedKeys();

    await call("press_key", { key: "a" });
    await call("press_key", { key: "Escape" });
    await call("press_key", { key: "ArrowDown" });
    await call("press_key", { key: "Tab" });

    assert.deepEqual(events, [
        "keydown", "keypress", "keyup",
        "keydown", "keyup",
        "keydown", "keyup",
        "keydown", "keyup",
    ]);
});

test("press_key keeps keypress for Enter but drops it for Ctrl/Meta combos", async () => {
    const { events, call } = pressedKeys();

    await call("press_key", { key: "Enter" });
    await call("press_key", { key: "Control+a" });
    await call("press_key", { key: "Meta+c" });

    assert.deepEqual(events, [
        "keydown", "keypress", "keyup",
        "keydown", "keyup",
        "keydown", "keyup",
    ]);
});

test("type_text submitKey follows the same keypress rule", async () => {
    const events = [];
    const field = el("input", {
        id: "a",
        extra: {
            type: "text",
            value: "",
            dispatchEvent(event) { events.push(event.type); return true; },
        },
    });
    const call = loadContent(el("body", {}, [field]), { querySelector: () => field });

    await call("type_text", { selector: "#a", text: "x", submitKey: "Tab" });
    assert.deepEqual(events.slice(-2), ["keydown", "keyup"]);

    events.length = 0;
    await call("type_text", { selector: "#a", text: "x", submitKey: "Enter" });
    assert.deepEqual(events.slice(-3), ["keydown", "keypress", "keyup"]);
});

// ─── hover pointer events and parity ─────────────────────────────────

test("hover dispatches pointer and mouse families in real pointer order", async () => {
    const events = [];
    const target = el("a", {
        id: "t",
        extra: { dispatchEvent(event) { events.push(event); return true; } },
    });
    const call = loadContent(el("body", {}, [target]), { querySelector: () => target });

    const response = await call("hover", { selector: "#t" });

    assert.equal(response.error, null);
    assert.deepEqual(events.map((e) => e.type), [
        "pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove",
    ]);
    assert.equal(events[0].pointerType, "mouse");
    assert.match(response.data, /CSS :hover is not applied/);
});

test("hover accepts x and y like click", async () => {
    const events = [];
    const target = el("div", {
        extra: { dispatchEvent(event) { events.push(event.type); return true; } },
    });
    const call = loadContent(el("body", {}, [target]), { elementFromPoint: () => target });

    const response = await call("hover", { x: 10, y: 20 });

    assert.equal(response.error, null);
    assert.ok(events.length > 0, "the element at the point received the hover");

    const missing = await loadContent(el("body", {}, []))("hover", { x: 10, y: 20 });
    assert.equal(missing.errorCode, "target_not_found");
});

// ─── drag pointer path and no-op detection ───────────────────────────

function dragHarness() {
    const fromEvents = [];
    const toEvents = [];
    const fromEl = el("div", {
        id: "from",
        extra: {
            getBoundingClientRect: () => ({ left: 0, top: 0, x: 0, y: 0, width: 10, height: 10 }),
            dispatchEvent(event) { fromEvents.push(event); return true; },
        },
    });
    const toEl = el("div", {
        id: "to",
        extra: {
            getBoundingClientRect: () => ({ left: 100, top: 100, x: 100, y: 100, width: 10, height: 10 }),
            dispatchEvent(event) { toEvents.push(event); return true; },
        },
    });
    const call = loadContent(el("body", {}, [fromEl, toEl]), {
        querySelector: (selector) => (selector === "#from" ? fromEl : toEl),
    });
    return { fromEvents, toEvents, call };
}

test("drag moves along an interpolated pointer path and completes at the target", async () => {
    const { fromEvents, toEvents, call } = dragHarness();
    const done = call("drag", { fromSelector: "#from", toSelector: "#to" });
    // The page reacts mid-gesture, as a drag library mounting an overlay would.
    setTimeout(() => FakeMutationObserver.active?.mutate(), 100);

    const response = await done;

    assert.equal(response.error, null);
    assert.equal(response.data, "Dragged <div> to <div>");

    const types = fromEvents.map((e) => e.type);
    assert.equal(types[0], "pointerdown");
    assert.equal(types[1], "mousedown");
    assert.ok(types.includes("dragstart"), "HTML5 dragstart still fires for native draggable handlers");
    assert.equal(types.at(-1), "dragend");

    const moves = fromEvents.filter((e) => e.type === "pointermove");
    assert.ok(moves.length >= 8, "the pointer path is interpolated, not a single jump");
    assert.ok(moves.every((e) => e.buttons === 1), "moves carry the pressed button");
    const xs = moves.map((e) => e.clientX);
    assert.ok(xs.every((x, i) => i === 0 || x > xs[i - 1]), "moves advance toward the target");
    const last = moves.at(-1);
    assert.equal(last.clientX, 105);
    assert.equal(last.clientY, 105);

    const toTypes = toEvents.map((e) => e.type);
    assert.deepEqual(toTypes.slice(0, 3), ["dragenter", "dragover", "drop"]);
    assert.ok(toTypes.includes("pointerup"), "pointer-sensor libraries see the gesture end");
    const up = toEvents.find((e) => e.type === "pointerup");
    assert.equal(up.clientX, 105);
    assert.equal(up.buttons, 0);
});

test("drag fails with input_not_applied when nothing reacts to the gesture", async () => {
    const { call } = dragHarness();

    const response = await call("drag", { fromSelector: "#from", toSelector: "#to" });

    assert.equal(response.errorCode, "input_not_applied");
    assert.equal(response.recoveryAction, "use_native_input");
    assert.match(response.error, /no DOM change/);
});
