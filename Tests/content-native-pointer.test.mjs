import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/content.js", import.meta.url),
    "utf8"
);

const ELEMENT_NODE = 1;

// Geometry: window at screen (100, 125), 100 px of top chrome, no side
// borders. Element rect center (60, 65) must land at screen (160, 290).
const WINDOW = {
    screenX: 100,
    screenY: 125,
    outerWidth: 1000,
    innerWidth: 1000,
    outerHeight: 900,
    innerHeight: 800,
};

function el(rect) {
    return {
        nodeType: ELEMENT_NODE,
        tagName: "DIV",
        hidden: false,
        scrollIntoView() {},
        getBoundingClientRect: () => rect,
    };
}

function loadContent({ target, toTarget, window: windowValues } = {}) {
    let listener;
    vm.runInNewContext(source, {
        browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
        document: {
            body: null,
            documentElement: null,
            activeElement: null,
            querySelector: (selector) => {
                if (selector === "#to") return toTarget || null;
                return target || null;
            },
        },
        Node: { ELEMENT_NODE, TEXT_NODE: 3 },
        NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
        WeakRef,
        setTimeout,
        clearTimeout,
        window: {
            addEventListener: () => {},
            removeEventListener: () => {},
            ...WINDOW,
            ...windowValues,
        },
    });
    return (action, params) => new Promise((r) => listener({ action, params }, {}, r));
}

test("native_pointer_points converts an element center to screen points", async () => {
    const target = el({ left: 50, top: 60, width: 20, height: 10 });
    const call = loadContent({ target });

    const { data, error } = await call("native_pointer_points", { selector: "#target" });

    assert.equal(error, null);
    assert.deepEqual(JSON.parse(JSON.stringify(data)), { from: { x: 160, y: 290 } });
});

test("native_pointer_points passes x/y through the same conversion", async () => {
    const call = loadContent();

    const { data } = await call("native_pointer_points", { x: 10, y: 20 });

    assert.deepEqual(JSON.parse(JSON.stringify(data)), { from: { x: 110, y: 245 } });
});

test("native_pointer_points resolves drag endpoints", async () => {
    const target = el({ left: 0, top: 0, width: 10, height: 10 });
    const toTarget = el({ left: 200, top: 300, width: 40, height: 20 });
    const call = loadContent({ target, toTarget });

    const { data } = await call("native_pointer_points", {
        fromSelector: "#from",
        toSelector: "#to",
    });

    assert.deepEqual(JSON.parse(JSON.stringify(data)), { from: { x: 105, y: 230 }, to: { x: 320, y: 535 } });
});

test("native_pointer_points rejects calls without a target", async () => {
    const call = loadContent();

    const response = await call("native_pointer_points", {});

    assert.equal(response.data, null);
    assert.equal(response.errorCode, "invalid_input");
});

test("native_pointer_points measures both drag endpoints after all scrolling", async () => {
    // A distant drag target scrolls the source off-screen; the source point
    // must be measured after all scrolling (and here fails the bounds check
    // rather than dragging whatever sits at the stale point).
    let scrollOffset = 0;
    const scrollingEl = (baseTop) => ({
        nodeType: ELEMENT_NODE,
        tagName: "DIV",
        hidden: false,
        scrollIntoView() {
            scrollOffset = baseTop;
        },
        getBoundingClientRect: () => ({
            left: 0,
            top: baseTop - scrollOffset,
            width: 10,
            height: 10,
        }),
    });
    const target = scrollingEl(100);
    const toTarget = scrollingEl(2000);
    const call = loadContent({ target, toTarget });

    const response = await call("native_pointer_points", {
        fromSelector: "#from",
        toSelector: "#to",
    });

    assert.equal(response.data, null);
    assert.equal(response.errorCode, "invalid_input");
    assert.equal(scrollOffset, 2000);
});

test("native_pointer_points puts the full side-chrome width on the left", async () => {
    // Safari's sidebar shrinks innerWidth from the left only.
    const target = el({ left: 50, top: 60, width: 20, height: 10 });
    const call = loadContent({
        target,
        window: { outerWidth: 1320, innerWidth: 1000 },
    });

    const { data } = await call("native_pointer_points", { selector: "#target" });

    assert.deepEqual(JSON.parse(JSON.stringify(data)), {
        from: { x: 100 + 320 + 60, y: 290 },
    });
});

test("native_pointer_points rejects points outside the viewport", async () => {
    const call = loadContent();

    const response = await call("native_pointer_points", { x: 5000, y: -50 });

    assert.equal(response.data, null);
    assert.equal(response.errorCode, "invalid_input");
});
