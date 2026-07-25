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

// Minimal DOM stand-ins: enough for snapshot tree building and find(), which
// only need node types, children, text, attributes, and visibility.
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
        getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }),
    };
    Object.defineProperty(node, "children", {
        get: () => node.childNodes.filter((c) => c.nodeType === ELEMENT_NODE),
    });
    Object.defineProperty(node, "textContent", {
        get: () => node.childNodes.map((c) => c.textContent).join(""),
    });
    return node;
}

function loadContent(body) {
    let runtimeListener;

    const document = {
        body,
        documentElement: body,
        getElementById: () => null,
        querySelector: () => null,
        createTreeWalker(root, _whatToShow, filter) {
            const queue = [];
            const collect = (node) => {
                for (const child of node.children) {
                    queue.push(child);
                    collect(child);
                }
            };
            collect(root);
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
        browser: {
            runtime: {
                onMessage: { addListener: (fn) => { runtimeListener = fn; } },
            },
        },
        document,
        Node: { ELEMENT_NODE, TEXT_NODE },
        NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
        WeakRef,
        setTimeout,
        clearTimeout,
        window: {
            addEventListener: () => {},
            removeEventListener: () => {},
            postMessage: () => {},
            getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
        },
    });

    return (action, params) => new Promise((resolve) => {
        runtimeListener({ action, params }, {}, resolve);
    });
}

test("snapshot keeps an element's own text when it also has element children", async () => {
    const call = loadContent(
        el("body", {}, [
            el("h2", {}, [text("Trash"), el("span", {}, [text(".")])]),
            el("button", {}, [el("span", {}, [text("9")]), text("All")]),
        ])
    );

    const { data } = await call("snapshot", {});
    const [heading, button] = data.children;

    assert.equal(heading.text, "Trash");
    assert.equal(heading.children[0].text, ".");
    assert.equal(button.text, "All");
    assert.equal(button.children[0].text, "9");
});

test("snapshot still reports full text for leaf elements", async () => {
    const call = loadContent(el("body", {}, [el("p", {}, [text("only text")])]));

    const { data } = await call("snapshot", {});

    assert.equal(data.children[0].text, "only text");
});

test("find matches an accessible name that is not visible text", async () => {
    const call = loadContent(
        el("body", {}, [
            el("button", { attributes: { "aria-label": "Open Trash" }, id: "icon" }, [
                text("🗑"),
            ]),
        ])
    );

    const { data } = await call("find", { text: "Open Trash" });

    assert.equal(data.length, 1);
    assert.equal(data[0].id, "icon");
    assert.equal(data[0].name, "Open Trash");
});

test("find still matches visible text", async () => {
    const call = loadContent(
        el("body", {}, [el("button", { id: "restore" }, [text("Restore")])])
    );

    const { data } = await call("find", { text: "restore" });

    assert.equal(data.length, 1);
    assert.equal(data[0].id, "restore");
});

test("find rejects a call with no target argument", async () => {
    const call = loadContent(el("body", {}, []));

    const response = await call("find", { query: "Restore" });

    assert.equal(response.data, null);
    assert.equal(response.errorCode, "invalid_input");
    assert.equal(response.recoveryAction, "fix_input");
    assert.match(response.error, /selector, text, or role/);
});
