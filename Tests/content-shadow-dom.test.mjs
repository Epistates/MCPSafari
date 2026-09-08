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

function textNode(value) {
    return { nodeType: TEXT_NODE, textContent: value };
}

// Enough of a selector engine for the fixtures below: tag, #id, and .class.
function matchesSelector(node, selector) {
    if (selector === "*") return true;
    if (selector.startsWith("#")) return node.id === selector.slice(1);
    if (selector.startsWith(".")) {
        return String(node.attributes.class || "").split(/\s+/).includes(selector.slice(1));
    }
    return node.tagName.toLowerCase() === selector.toLowerCase();
}

function descendants(root) {
    const found = [];
    const collect = (node) => {
        for (const child of node.children) {
            found.push(child);
            collect(child);
        }
    };
    collect(root);
    return found;
}

// querySelectorAll stops at the shadow boundary in a real browser, and so does
// this: descendants() never crosses into a host's shadowRoot. That boundary is
// the whole point of the fixtures.
function addQueries(node) {
    node.querySelectorAll = (selector) =>
        descendants(node).filter((el) => matchesSelector(el, selector));
    node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null;
    return node;
}

function el(tag, options = {}, children = []) {
    const node = {
        nodeType: ELEMENT_NODE,
        tagName: tag.toUpperCase(),
        hidden: false,
        id: options.id || "",
        attributes: options.attributes || {},
        childNodes: children,
        shadowRoot: null,
        clicked: 0,
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name)
                ? this.attributes[name]
                : null;
        },
        getBoundingClientRect: () => options.rect || { x: 0, y: 0, left: 0, top: 0, width: 10, height: 10 },
        scrollIntoView() {},
        focus() {},
        dispatchEvent() {
            node.clicked += 1;
            return true;
        },
    };
    Object.defineProperty(node, "children", {
        get: () => node.childNodes.filter((c) => c.nodeType === ELEMENT_NODE),
    });
    Object.defineProperty(node, "textContent", {
        get: () => node.childNodes.map((c) => c.textContent ?? "").join(""),
    });
    node.getRootNode = () => node.ownerRoot || documentRef;
    if (options.slot) {
        node.assignedElements = ({ flatten } = {}) =>
            options.assigned && options.assigned.length
                ? options.assigned
                : (flatten ? node.children : []);
    }
    return addQueries(node);
}

// An open shadow root: a container that answers queries about its own tree.
function shadowRoot(children) {
    const root = { nodeType: 11, childNodes: children };
    Object.defineProperty(root, "children", {
        get: () => root.childNodes.filter((c) => c.nodeType === ELEMENT_NODE),
    });
    Object.defineProperty(root, "textContent", {
        get: () => root.childNodes.map((c) => c.textContent ?? "").join(""),
    });
    return addQueries(root);
}

function attachShadow(host, children) {
    host.shadowRoot = shadowRoot(children);
    for (const child of children) markRoot(child, host.shadowRoot);
    return host;
}

function markRoot(node, root) {
    node.ownerRoot = root;
    for (const child of node.children) markRoot(child, root);
}

let documentRef;

// The click path constructs real event objects; only the type and the options
// matter to these fixtures.
class FakeEvent {
    constructor(type, options = {}) {
        this.type = type;
        Object.assign(this, options);
    }
}

function loadContent(body) {
    let listener;
    const document = {
        body,
        documentElement: body,
        activeElement: null,
        elementFromPoint: () => null,
        getElementById: () => null,
        createTreeWalker(root, _show, filter) {
            const queue = descendants(root);
            return {
                nextNode() {
                    while (queue.length) {
                        const node = queue.shift();
                        if (filter.acceptNode(node) === 1) return node;
                    }
                    return null;
                },
            };
        },
    };
    addQueries({ ...document, children: body.children });
    // Queries on the document run against the light tree rooted at body.
    document.querySelectorAll = (selector) =>
        descendants(body)
            .concat(matchesSelector(body, selector) ? [body] : [])
            .filter((element) => matchesSelector(element, selector));
    document.querySelector = (selector) => document.querySelectorAll(selector)[0] || null;
    documentRef = document;

    vm.runInNewContext(source, {
        browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
        document,
        Node: { ELEMENT_NODE, TEXT_NODE },
        NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
        Event: FakeEvent,
        MouseEvent: FakeEvent,
        PointerEvent: FakeEvent,
        KeyboardEvent: FakeEvent,
        WeakRef,
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

    return (action, params) => new Promise((r) => listener({ action, params }, {}, r));
}

// <my-card> hides a button behind an open shadow root, which is exactly what a
// Lit or Stencil component looks like from the outside.
function cardFixture() {
    const shadowButton = el("button", { id: "inner" }, [textNode("Submit order")]);
    const host = attachShadow(el("my-card"), [shadowButton]);
    const body = el("body", {}, [el("h1", {}, [textNode("Checkout")]), host]);
    return { body, shadowButton, host };
}

function flatten(node, out = []) {
    if (!node) return out;
    out.push(node);
    for (const child of node.children || []) flatten(child, out);
    return out;
}

test("snapshot descends an open shadow root", async () => {
    const { body, shadowButton } = cardFixture();
    const call = loadContent(body);

    const { data: tree } = await call("snapshot", {});
    const nodes = flatten(tree);

    const button = nodes.find((n) => n.tag === "button");
    assert.ok(button, "the shadow button is missing from the snapshot");
    assert.equal(button.text, "Submit order");
    assert.equal(shadowButton.clicked, 0);
});

test("find reaches a shadow element by selector, text, and role", async () => {
    const { body } = cardFixture();
    const call = loadContent(body);

    const { data: bySelector } = await call("find", { selector: "button" });
    assert.equal(bySelector.length, 1);
    assert.equal(bySelector[0].tag, "button");

    const { data: byText } = await call("find", { text: "Submit order" });
    assert.ok(byText.some((r) => r.tag === "button"), "text search missed the shadow button");

    const { data: byRole } = await call("find", { role: "button" });
    assert.ok(byRole.some((r) => r.tag === "button"), "role search missed the shadow button");
});

test("a uid minted inside a shadow root still resolves for a click", async () => {
    const { body, shadowButton } = cardFixture();
    const call = loadContent(body);

    const { data: tree } = await call("snapshot", {});
    const button = flatten(tree).find((n) => n.tag === "button");

    const response = await call("click", { uid: button.uid });

    assert.equal(response.errorCode, undefined);
    assert.ok(shadowButton.clicked > 0, "click never reached the shadow element");
});

test("click and form_input resolve a selector across the shadow boundary", async () => {
    const { body, shadowButton } = cardFixture();
    const call = loadContent(body);

    const response = await call("click", { selector: "#inner" });

    assert.equal(response.errorCode, undefined);
    assert.ok(shadowButton.clicked > 0, "selector click never reached the shadow element");
});

test("slotted light content is reported once, not twice", async () => {
    // The host slots its light child, so the flattened tree shows the label
    // exactly where the slot puts it and nowhere else.
    const lightLabel = el("span", { id: "label" }, [textNode("Buy now")]);
    const slot = el("slot", { slot: true, assigned: [lightLabel] });
    const host = attachShadow(el("my-button", {}, [lightLabel]), [slot]);
    const body = el("body", {}, [host]);
    const call = loadContent(body);

    const { data: tree } = await call("snapshot", {});
    const spans = flatten(tree).filter((n) => n.tag === "span");

    assert.equal(spans.length, 1, "slotted content was reported twice");
    assert.equal(spans[0].text, "Buy now");
});

test("a closed shadow root is marked instead of reading as an empty element", async () => {
    // A custom element that occupies space while reporting no content of its
    // own is rendering something behind a closed root.
    const closed = el("x-secret", { rect: { x: 0, y: 0, left: 0, top: 0, width: 40, height: 20 } });
    const body = el("body", {}, [closed]);
    const call = loadContent(body);

    const { data: tree } = await call("snapshot", {});
    const node = flatten(tree).find((n) => n.tag === "x-secret");

    assert.ok(node, "the host itself should still be reported");
    assert.equal(node.shadowClosed, true);
});

test("an ordinary element with no shadow root is not marked closed", async () => {
    const body = el("body", {}, [el("div", {}, [textNode("plain")]), el("span")]);
    const call = loadContent(body);

    const { data: tree } = await call("snapshot", {});
    for (const node of flatten(tree)) {
        assert.equal(node.shadowClosed, undefined, `${node.tag} was wrongly marked closed`);
    }
});
