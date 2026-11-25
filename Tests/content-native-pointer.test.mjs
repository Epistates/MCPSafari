import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { contentScriptSource } from "./helpers/extension-sources.mjs";

const source = contentScriptSource();

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
    scrollX: 0,
    scrollY: 0,
};

// The screen guess each point carries, which the tests below were written for.
// Where the point is on the page is checked on its own further down.
function screenPoints(data) {
    const plain = JSON.parse(JSON.stringify(data));
    const screen = (p) => p && { x: p.x, y: p.y };
    return plain.to ? { from: screen(plain.from), to: screen(plain.to) } : { from: screen(plain.from) };
}

// `covering` stands in for what the hit test lands on: the element itself
// unless something is on top of it.
function el(rect, covering) {
    const node = {
        nodeType: ELEMENT_NODE,
        tagName: "DIV",
        hidden: false,
        id: "",
        getAttribute: () => null,
        scrollIntoView() {},
        getBoundingClientRect: () => rect,
        getRootNode: () => ({ elementFromPoint: () => covering || node, querySelector: () => null }),
        closest: () => null,
        contains: (other) => other === node,
    };
    return node;
}

function loadContent({ target, toTarget, window: windowValues, hasFocus = true } = {}) {
    let listener;
    vm.runInNewContext(source, {
        browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
        document: {
            body: null,
            documentElement: null,
            activeElement: null,
            hasFocus: () => hasFocus,
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
    assert.deepEqual(screenPoints(data), { from: { x: 160, y: 290 } });
});

// Safari measures screenY from the top of the window's own display, so the
// server places a point from where the page is, and needs the point on the page.
test("native_pointer_points says where each point is on the page, scroll included", async () => {
    const target = el({ left: 50, top: 60, width: 20, height: 10 });
    const toTarget = el({ left: 200, top: 300, width: 40, height: 20 });
    const call = loadContent({ target, toTarget, window: { scrollX: 30, scrollY: 500 } });

    const { data } = await call("native_pointer_points", { fromSelector: "#from", toSelector: "#to" });

    const plain = JSON.parse(JSON.stringify(data));
    assert.deepEqual([plain.from.pageX, plain.from.pageY], [60 + 30, 65 + 500]);
    assert.deepEqual([plain.to.pageX, plain.to.pageY], [220 + 30, 310 + 500]);
});

test("native_pointer_points passes x/y through the same conversion", async () => {
    const call = loadContent();

    const { data } = await call("native_pointer_points", { x: 10, y: 20 });

    assert.deepEqual(screenPoints(data), { from: { x: 110, y: 245 } });
});

test("native_pointer_points resolves drag endpoints", async () => {
    const target = el({ left: 0, top: 0, width: 10, height: 10 });
    const toTarget = el({ left: 200, top: 300, width: 40, height: 20 });
    const call = loadContent({ target, toTarget });

    const { data } = await call("native_pointer_points", {
        fromSelector: "#from",
        toSelector: "#to",
    });

    assert.deepEqual(screenPoints(data), { from: { x: 105, y: 230 }, to: { x: 320, y: 535 } });
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
    const scrollingEl = (baseTop) => {
        const node = el({ left: 0, top: 0, width: 10, height: 10 });
        node.scrollIntoView = () => { scrollOffset = baseTop; };
        node.getBoundingClientRect = () => ({
            left: 0,
            top: baseTop - scrollOffset,
            width: 10,
            height: 10,
        });
        return node;
    };
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

    assert.deepEqual(screenPoints(data), {
        from: { x: 100 + 320 + 60, y: 290 },
    });
});

test("native_pointer_points rejects points outside the viewport", async () => {
    const call = loadContent();

    const response = await call("native_pointer_points", { x: 5000, y: -50 });

    assert.equal(response.data, null);
    assert.equal(response.errorCode, "invalid_input");
});

test("x/y overrides a resolvable selector, matching the synthetic path", async () => {
    // The schema states x/y takes precedence over uid/selector/text. Synthetic
    // hover honours that; the native path must land on the same point rather
    // than the element's centre.
    const target = el({ left: 10, top: 10, x: 10, y: 10, width: 100, height: 100 });
    const call = loadContent({ target });

    const { data } = await call("native_pointer_points", { selector: "#target", x: 400, y: 300 });

    assert.deepEqual(screenPoints(data), {
        from: { x: 100 + 400, y: 125 + 100 + 300 },
    });
});

// ─── Reachability ────────────────────────────────────────────────────
//
// A real pointer lands on whatever is at the point. The synthetic path refuses
// a covered target; the native path used to answer with its centre and let the
// click land on the overlay, reporting success for it.

test("native_pointer_points refuses a target covered by an overlay and names it", async () => {
    const overlay = el({ left: 0, top: 0, width: 1000, height: 800 });
    overlay.id = "cookie-banner";
    const target = el({ left: 50, top: 60, width: 20, height: 10 }, overlay);
    const call = loadContent({ target });

    const response = await call("native_pointer_points", { selector: "#target" });

    assert.equal(response.data, null);
    assert.equal(response.errorCode, "target_covered", response.error);
    assert.match(response.error, /<div>#cookie-banner/);
});

test("force waives the cover for native points", async () => {
    const overlay = el({ left: 0, top: 0, width: 1000, height: 800 });
    const target = el({ left: 50, top: 60, width: 20, height: 10 }, overlay);
    const call = loadContent({ target });

    const { data, error } = await call("native_pointer_points", { selector: "#target", force: true });

    assert.equal(error, null);
    assert.deepEqual(screenPoints(data), { from: { x: 160, y: 290 } });
});

test("native_pointer_points checks both ends of a drag", async () => {
    const overlay = el({ left: 0, top: 0, width: 1000, height: 800 });
    const target = el({ left: 0, top: 0, width: 10, height: 10 });
    const toTarget = el({ left: 200, top: 300, width: 40, height: 20 }, overlay);
    const call = loadContent({ target, toTarget });

    const covered = await call("native_pointer_points", { fromSelector: "#from", toSelector: "#to" });
    const forced = await call("native_pointer_points", { fromSelector: "#from", toSelector: "#to", force: true });

    assert.equal(covered.data, null);
    assert.equal(covered.errorCode, "target_covered");
    assert.equal(forced.error, null);
});

test("native_pointer_points refuses an element with no area, forced or not", async () => {
    const target = el({ left: 50, top: 60, width: 0, height: 0 });
    const call = loadContent({ target });

    const plain = await call("native_pointer_points", { selector: "#target" });
    const forced = await call("native_pointer_points", { selector: "#target", force: true });

    assert.equal(plain.errorCode, "target_not_visible");
    assert.equal(forced.errorCode, "target_not_visible");
    assert.equal(plain.data, null);
});

test("native_pointer_points aims at the visible part of an element larger than the viewport", async () => {
    const target = el({ left: -500, top: 100, width: 3000, height: 40 });
    const call = loadContent({ target });

    const { data, error } = await call("native_pointer_points", { selector: "#target" });

    assert.equal(error, null);
    assert.deepEqual(screenPoints(data), { from: { x: 100 + 500, y: 125 + 100 + 120 } });
});

// The points are screen coordinates. If Safari is not the window in front, they
// land on whatever is, in another application.
test("native_pointer_points refuses when the page does not hold focus", async () => {
    const target = el({ left: 50, top: 60, width: 20, height: 10 });
    const call = loadContent({ target, hasFocus: false });

    const response = await call("native_pointer_points", { selector: "#target" });

    assert.equal(response.data, null);
    assert.equal(response.errorCode, "native_input_focus_failed");
    assert.equal(response.retryable, true);
    assert.equal(response.recoveryAction, "retry");
    assert.match(response.error, /native mouse events/);
});

// Safari's address bar holding the keyboard leaves the page without focus while
// its window is in front. Once the server has confirmed through Accessibility
// that the window in front is this tab's, a click is safe, and it's what gives
// the page focus.
test("native_pointer_points goes on without page focus once the server has verified the window", async () => {
    const target = el({ left: 50, top: 60, width: 20, height: 10 });
    const call = loadContent({ target, hasFocus: false });

    const { data, error } = await call("native_pointer_points", { selector: "#target", windowVerified: true });

    assert.equal(error, null);
    assert.deepEqual(screenPoints(data), { from: { x: 160, y: 290 } });
});

// Anything but an explicit true from the server leaves the check in place.
test("native_pointer_points keeps the focus check for anything but windowVerified true", async () => {
    const target = el({ left: 50, top: 60, width: 20, height: 10 });
    const call = loadContent({ target, hasFocus: false });

    const response = await call("native_pointer_points", { selector: "#target", windowVerified: "true" });

    assert.equal(response.errorCode, "native_input_focus_failed");
});
