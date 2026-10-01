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

function text(value) {
    return { nodeType: TEXT_NODE, textContent: value };
}

// Enough selector matching for tags, [role="x"], and bare [attr].
function matchesPart(node, part) {
    const role = part.match(/^\[role="(.+)"\]$/);
    if (role) return node.attributes.role === role[1];
    const attr = part.match(/^\[([a-z-]+)\]$/);
    if (attr) return attr[1] in node.attributes;
    return node.tagName.toLowerCase() === part;
}

let fakeDocument;
// Uncovered by default: a hit lands on whatever was just scrolled to.
let lastScrolled = null;

function el(tag, options = {}, children = []) {
    const node = {
        nodeType: ELEMENT_NODE,
        tagName: tag.toUpperCase(),
        attributes: options.attributes || {},
        hidden: false,
        id: options.id || "",
        childNodes: children,
        parentElement: null,
        rendered: options.rendered !== false,
        events: [],
        getAttribute(name) {
            return name in this.attributes ? this.attributes[name] : null;
        },
        getBoundingClientRect: () => options.rect || { x: 0, y: 0, left: 0, top: 0, width: 100, height: 20 },
        getClientRects() {
            let n = this;
            for (; n; n = n.parentElement) if (!n.rendered) return [];
            return [{}];
        },
        getRootNode: () => fakeDocument,
        contains(other) {
            for (let n = other; n; n = n.parentElement) if (n === this) return true;
            return false;
        },
        closest(selector) {
            const parts = selector.split(/,\s*/);
            for (let n = this; n; n = n.parentElement) {
                if (parts.some((part) => matchesPart(n, part))) return n;
            }
            return null;
        },
        scrollIntoView() { lastScrolled = node; },
        focus() { node.focused = true; },
        dispatchEvent(event) {
            node.events.push(event.type);
            return true;
        },
    };
    for (const child of children) if (child.nodeType === ELEMENT_NODE) child.parentElement = node;
    Object.defineProperty(node, "children", {
        get: () => node.childNodes.filter((c) => c.nodeType === ELEMENT_NODE),
    });
    Object.defineProperty(node, "textContent", {
        get: () => node.childNodes.map((c) => c.textContent).join(""),
    });
    return node;
}

function descendants(root) {
    const all = [];
    const collect = (node) => {
        for (const child of node.children) {
            all.push(child);
            collect(child);
        }
    };
    collect(root);
    return all;
}

function loadContent(body, { hit = () => lastScrolled } = {}) {
    let listener;
    class FakeMouseEvent {
        constructor(type, options = {}) {
            this.type = type;
            Object.assign(this, options);
        }
    }
    const document = fakeDocument = {
        body,
        documentElement: body,
        activeElement: null,
        getElementById: () => null,
        querySelector: (selector) => document.querySelectorAll(selector)[0] || null,
        querySelectorAll: (selector) => descendants(body).filter(
            (node) => selector === "*" || `#${node.id}` === selector
        ),
        elementFromPoint: hit,
        createTreeWalker(root, _whatToShow, filter) {
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
    vm.runInNewContext(source, {
        browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
        document,
        Node: { ELEMENT_NODE, TEXT_NODE },
        NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
        WeakRef,
        setTimeout,
        clearTimeout,
        MouseEvent: FakeMouseEvent,
        PointerEvent: FakeMouseEvent,
        window: {
            addEventListener() {},
            removeEventListener() {},
            postMessage() {},
            innerWidth: 1200,
            innerHeight: 800,
            getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
        },
    });
    return (action, params) => new Promise((resolve) => listener({ action, params }, {}, resolve));
}

const clicked = (node) => node.events.includes("click");

test("text that matches two equally good controls is refused with their uids", async () => {
    const first = el("button", {}, [text("Delete")]);
    const second = el("button", {}, [text("Delete")]);
    const call = loadContent(el("body", {}, [el("li", {}, [first]), el("li", {}, [second])]));

    const response = await call("click", { text: "delete" });

    assert.equal(response.errorCode, "ambiguous_target");
    assert.equal(response.recoveryAction, "fix_input");
    assert.match(response.error, /matches 2 elements/);
    assert.match(response.error, /f0e\d+ <button>.*; f0e\d+ <button>/);
    assert.ok(!clicked(first) && !clicked(second));
});

test("the listed uids target the candidates they name", async () => {
    const first = el("button", { id: "a" }, [text("Delete")]);
    const second = el("button", { id: "b" }, [text("Delete")]);
    const call = loadContent(el("body", {}, [first, second]));

    const { error } = await call("click", { text: "Delete" });
    const uid = error.match(/f0e\d+/g)[1];
    const response = await call("click", { uid });

    assert.equal(response.error, null);
    assert.ok(clicked(second) && !clicked(first));
});

test("an exact match wins over a longer label containing the text", async () => {
    const save = el("button", {}, [text("Save")]);
    const draft = el("button", {}, [text("Save as draft")]);
    const call = loadContent(el("body", {}, [draft, save]));

    assert.equal((await call("click", { text: "Save" })).error, null);
    assert.ok(clicked(save) && !clicked(draft));
});

test("a control wins over plain text with the same words", async () => {
    const heading = el("h2", {}, [text("Delete")]);
    const button = el("div", { attributes: { role: "button" } }, [text("Delete")]);
    const call = loadContent(el("body", {}, [heading, button]));

    assert.equal((await call("click", { text: "Delete" })).error, null);
    assert.ok(clicked(button) && !clicked(heading));
});

test("text wrapped inside a button targets and focuses the button", async () => {
    const label = el("span", {}, [text("Save")]);
    const button = el("button", {}, [label]);
    const call = loadContent(el("body", {}, [el("li", {}, [button])]));

    assert.equal((await call("click", { text: "Save" })).error, null);
    assert.ok(clicked(button) && button.focused);
});

test("a copy inside an unrendered subtree is not a candidate", async () => {
    const hidden = el("button", {}, [text("Menu")]);
    const shown = el("button", {}, [text("Menu")]);
    const call = loadContent(el("body", {}, [el("nav", { rendered: false }, [hidden]), shown]));

    assert.equal((await call("click", { text: "Menu" })).error, null);
    assert.ok(clicked(shown) && !clicked(hidden));
});

test("click refuses a target covered by another element and names it", async () => {
    const target = el("button", { id: "buy" }, [text("Buy")]);
    const overlay = el("div", { id: "cookie-banner" });
    const call = loadContent(el("body", {}, [target, overlay]), { hit: () => overlay });

    const response = await call("click", { selector: "#buy" });

    assert.equal(response.errorCode, "target_covered");
    assert.match(response.error, /<div>#cookie-banner/);
    assert.deepEqual(target.events, []);
});

test("force dispatches to a covered target", async () => {
    const target = el("button", {}, [text("Buy")]);
    const overlay = el("div");
    const call = loadContent(el("body", {}, [target, overlay]), { hit: () => overlay });

    assert.equal((await call("click", { text: "Buy", force: true })).error, null);
    assert.ok(clicked(target));
});

test("a hit on the control's own content is not covered", async () => {
    const icon = el("span", { id: "icon" }, [text("Buy")]);
    const target = el("button", {}, [icon]);
    const call = loadContent(el("body", {}, [target]), { hit: () => icon });

    assert.equal((await call("click", { selector: "#icon" })).error, null);
    assert.equal((await call("click", { text: "Buy" })).error, null);
});

test("a hit that falls through to an ancestor is covered", async () => {
    // A pointer-events:none button: the real click lands on what is behind it.
    const target = el("button", { id: "buy" }, [text("Buy")]);
    const body = el("body", {}, [el("div", {}, [target])]);
    const call = loadContent(body, { hit: () => body });

    assert.equal((await call("click", { selector: "#buy" })).errorCode, "target_covered");
    assert.deepEqual(target.events, []);
});

test("a focusable container is not a control that swallows its children", async () => {
    const child = el("span", { id: "child" }, [text("Open")]);
    const overlay = el("div", { id: "cover" });
    const card = el("div", { attributes: { tabindex: "0" } }, [child, overlay]);
    const call = loadContent(el("body", {}, [card]), { hit: () => overlay });

    assert.equal((await call("click", { text: "Open" })).errorCode, "target_covered");
    assert.equal((await call("click", { text: "Open", force: true })).error, null);
    assert.ok(clicked(child) && card.events.length === 0);
});

test("an element with no area in the viewport is not visible", async () => {
    const target = el("button", { id: "tiny", rect: { x: 0, y: 0, left: 0, top: 0, width: 0, height: 0 } });
    const call = loadContent(el("body", {}, [target]));

    const response = await call("click", { selector: "#tiny" });

    assert.equal(response.errorCode, "target_not_visible");
    assert.deepEqual(target.events, []);
});

test("an element wider than the viewport is aimed inside it", async () => {
    const rect = { x: -500, y: 100, left: -500, top: 100, width: 3000, height: 40 };
    const target = el("div", { id: "wide", rect }, [text("Banner")]);
    let aimed;
    const call = loadContent(el("body", {}, [target]), { hit: (x, y) => { aimed = { x, y }; return target; } });

    assert.equal((await call("click", { selector: "#wide" })).error, null);
    assert.deepEqual(aimed, { x: 600, y: 120 });
});

test("a styled checkbox under its own label is not covered", async () => {
    const input = el("input", { id: "terms", attributes: { type: "checkbox" } });
    const box = el("span", {}, [text("I agree")]);
    const label = el("label", {}, [input, box]);
    label.control = input;
    const call = loadContent(el("body", {}, [label]), { hit: () => box });

    assert.equal((await call("click", { selector: "#terms" })).error, null);
    assert.ok(clicked(input));
});

test("hover refuses a covered target", async () => {
    const target = el("a", {}, [text("Help")]);
    const overlay = el("div");
    const call = loadContent(el("body", {}, [target, overlay]), { hit: () => overlay });

    const response = await call("hover", { text: "Help" });

    assert.equal(response.errorCode, "target_covered");
    assert.deepEqual(target.events, []);
});
