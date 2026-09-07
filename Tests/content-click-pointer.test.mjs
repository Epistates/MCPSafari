import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/content.js", import.meta.url),
    "utf8"
);

class FakeMouseEvent {
    constructor(type, options = {}) {
        this.type = type;
        Object.assign(this, options);
    }
}
class FakePointerEvent extends FakeMouseEvent {}

// A button that behaves like a Radix DropdownMenu trigger when `cancelsPointerDown`
// is set: it toggles on pointerdown and cancels it, so a real browser would not
// deliver mousedown/mouseup or move focus.
function loadClick({ cancelsPointerDown = false, cancelsMouseDown = false } = {}) {
    const seen = [];
    let focused = 0;
    let open = false;
    const target = {
        nodeType: 1,
        tagName: "BUTTON",
        hidden: false,
        textContent: "Account menu",
        scrollIntoView() {},
        getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 300, height: 100 }),
        focus() { focused += 1; },
        dispatchEvent(event) {
            seen.push(`${event instanceof FakePointerEvent ? "P" : "M"}:${event.type}`);
            if (event.type === "pointerdown" && cancelsPointerDown) {
                open = !open;
                return false;
            }
            return !(event.type === "mousedown" && cancelsMouseDown);
        },
    };
    let listener;
    vm.runInNewContext(source, {
        browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
        document: { body: null, documentElement: null, activeElement: null, querySelector: () => target },
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
        NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
        WeakRef,
        setTimeout,
        clearTimeout,
        MouseEvent: FakeMouseEvent,
        PointerEvent: FakePointerEvent,
        window: { addEventListener() {}, removeEventListener() {} },
    });
    const call = (action, params) => new Promise((r) => listener({ action, params }, {}, r));
    return { call, seen, focused: () => focused, open: () => open };
}

test("click dispatches the pointer family ahead of each mouse event", async () => {
    const page = loadClick();
    const { error } = await page.call("click", { selector: "#trigger" });
    assert.equal(error, null);
    assert.deepEqual(page.seen, [
        "P:pointerover", "M:mouseover",
        "P:pointerdown", "M:mousedown", "P:pointerup", "M:mouseup", "M:click",
    ]);
    assert.equal(page.focused(), 1);
});

test("a cancelled pointerdown suppresses the mouse press and the focus change", async () => {
    const page = loadClick({ cancelsPointerDown: true });
    await page.call("click", { selector: "#trigger" });
    assert.deepEqual(page.seen, ["P:pointerover", "M:mouseover", "P:pointerdown", "P:pointerup", "M:click"]);
    assert.equal(page.focused(), 0);
    assert.equal(page.open(), true);
});

test("a cancelled mousedown keeps focus where it was, as the browser does", async () => {
    const page = loadClick({ cancelsMouseDown: true });
    await page.call("click", { selector: "#trigger", doubleClick: true });
    assert.equal(page.focused(), 0);
    assert.ok(page.seen.includes("M:mouseup") && page.seen.includes("M:dblclick"));
});

test("double click presses twice with pointer events and ends in dblclick", async () => {
    const page = loadClick();
    await page.call("click", { selector: "#trigger", doubleClick: true });
    const press = ["P:pointerdown", "M:mousedown", "P:pointerup", "M:mouseup", "M:click"];
    assert.deepEqual(page.seen, ["P:pointerover", "M:mouseover", ...press, ...press, "M:dblclick"]);
});
