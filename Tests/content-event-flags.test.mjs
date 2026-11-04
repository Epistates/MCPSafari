import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { contentScriptSource } from "./helpers/extension-sources.mjs";

const source = contentScriptSource();

// A synthetic event that is not composed stops at the edge of the shadow root
// it was dispatched in, so a listener on the host, or anywhere outside, never
// sees what a real click, key or input would have reached it with. These
// dispatch into a component's shadow root and ask the host what arrived, using
// the propagation rule the browser applies: up the parents while the event
// bubbles, and across the root to its host only when it is composed.

const ELEMENT_NODE = 1;

class FakeEvent {
    constructor(type, options = {}) {
        this.type = type;
        Object.assign(this, options);
    }
}

function dispatch(target, event) {
    let current = target;
    while (current) {
        current.seen.push(event);
        if (!event.bubbles) break;
        const up = current.parent;
        current = up && up.host ? (event.composed ? up.host : null) : up;
    }
    return !event.defaultPrevented;
}

function node(tag, props = {}) {
    const element = {
        nodeType: ELEMENT_NODE,
        tagName: tag.toUpperCase(),
        id: props.id || "",
        hidden: false,
        parent: null,
        seen: [],
        childNodes: [],
        getAttribute: () => null,
        getBoundingClientRect: () => ({ left: 0, top: 0, x: 0, y: 0, width: 10, height: 10 }),
        scrollIntoView() {},
        focus() {},
        dispatchEvent(event) { return dispatch(element, event); },
        ...props,
    };
    Object.defineProperty(element, "children", { get: () => element.childNodes });
    return element;
}

// A component whose shadow root holds a button, a text field and a select, with
// the host as the only thing in the document.
function page() {
    const host = node("my-widget");
    const button = node("button", { id: "b" });
    const field = node("input", { id: "f", type: "text", value: "" });
    const chosen = { index: 0 };
    const options = ["a", "b"].map((value, index) => ({
        value,
        textContent: value,
        disabled: false,
        get selected() { return chosen.index === index; },
        set selected(on) { if (on) chosen.index = index; },
    }));
    const select = node("select", { id: "s", options, multiple: false });
    const inside = [button, field, select];
    const root = {
        host,
        childNodes: inside,
        children: inside,
        elementFromPoint: () => button,
        querySelectorAll: (selector) => (selector === "*" ? inside : inside.filter((n) => `#${n.id}` === selector)),
        querySelector: (selector) => root.querySelectorAll(selector)[0] || null,
    };
    for (const child of inside) child.parent = root;
    host.shadowRoot = root;
    host.childNodes = [];
    const body = node("body");
    body.childNodes = [host];
    host.parent = body;

    let listener;
    const document = {
        body,
        documentElement: body,
        activeElement: button,
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: (selector) => (selector === "*" ? [host] : []),
        elementFromPoint: () => host,
        hasFocus: () => true,
    };
    vm.runInNewContext(source, {
        browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
        document,
        Node: { ELEMENT_NODE, TEXT_NODE: 3 },
        NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
        WeakRef,
        setTimeout,
        clearTimeout,
        Event: FakeEvent,
        KeyboardEvent: FakeEvent,
        MouseEvent: FakeEvent,
        PointerEvent: FakeEvent,
        InputEvent: FakeEvent,
        HTMLInputElement: class {},
        HTMLTextAreaElement: class {},
        window: {
            addEventListener() {},
            removeEventListener() {},
            postMessage() {},
            innerWidth: 1200,
            innerHeight: 800,
            getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
        },
    });
    const call = (action, params) => new Promise((resolve) => listener({ action, params }, {}, resolve));
    return { call, host, button, field, select };
}

const typesAt = (target) => target.seen.map((event) => event.type);

test("a click on an element inside a shadow root reaches a listener on the host", async () => {
    const { call, host, button } = page();

    const response = await call("click", { x: 10, y: 20 });

    assert.equal(response.error, null);
    assert.match(response.data, /<button>/);
    const reached = typesAt(host);
    for (const type of ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        assert.ok(reached.includes(type), `${type} reached the host`);
    }
    assert.ok(typesAt(button).includes("click"));
    assert.ok(host.seen.every((event) => event.composed === true));
});

test("a double click, hover and keys all cross the shadow boundary", async () => {
    const { call, host } = page();

    await call("click", { x: 10, y: 20, doubleClick: true });
    await call("hover", { x: 10, y: 20 });
    await call("press_key", { key: "Enter" });
    const reached = typesAt(host);

    for (const type of ["dblclick", "pointermove", "mousemove", "keydown", "keypress", "keyup"]) {
        assert.ok(reached.includes(type), `${type} reached the host`);
    }
});

test("hover's enter events are composed but stay on their target", async () => {
    const { call, host, button } = page();

    await call("hover", { x: 10, y: 20 });

    const enters = button.seen.filter((event) => event.type.endsWith("enter"));
    assert.deepEqual(enters.map((event) => event.type), ["pointerenter", "mouseenter"]);
    for (const event of enters) {
        assert.equal(event.composed, true);
        assert.equal(event.bubbles, false);
        assert.equal(event.cancelable, false);
    }
    assert.ok(!typesAt(host).some((type) => type.endsWith("enter")), "an enter event does not bubble to the host");
});

test("type_text's key and input events cross the boundary, and change stays inside", async () => {
    const { call, host, field } = page();

    const response = await call("type_text", { selector: "#f", text: "hi", submitKey: "Tab" });

    assert.equal(response.error, null);
    const reached = typesAt(host);
    assert.ok(reached.includes("input"), "input is composed");
    assert.ok(reached.includes("keydown") && reached.includes("keyup"));
    assert.ok(!reached.includes("change"), "change is not composed and does not leave the root");
    assert.ok(typesAt(field).includes("change"), "but the field itself gets it");
});

test("select_option's input crosses the boundary and change stays inside", async () => {
    const { call, host, select } = page();

    const response = await call("select_option", { selector: "#s", value: "b" });

    assert.equal(response.error, null);
    assert.ok(typesAt(host).includes("input"));
    assert.ok(!typesAt(host).includes("change"));
    assert.deepEqual(typesAt(select), ["input", "change"]);
});

test("every event carries the flags the browser's own would", async () => {
    const { call, button, field, select } = page();

    await call("click", { x: 10, y: 20, doubleClick: true });
    await call("hover", { x: 10, y: 20 });
    await call("press_key", { key: "a" });
    await call("type_text", { selector: "#f", text: "x", submitKey: "Enter" });
    await call("select_option", { selector: "#s", value: "b" });

    const events = [...button.seen, ...field.seen, ...select.seen];
    assert.ok(events.length > 20);
    for (const event of events) {
        const label = `${event.type} composed`;
        assert.equal(event.composed, event.type !== "change", label);
        const enters = ["pointerenter", "mouseenter"].includes(event.type);
        assert.equal(event.bubbles, !enters, `${event.type} bubbles`);
        const fixed = enters || ["input", "change"].includes(event.type);
        assert.equal(event.cancelable, !fixed, `${event.type} cancelable`);
    }
});
