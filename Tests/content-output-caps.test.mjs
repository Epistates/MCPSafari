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

function loadContent(body) {
    let listener;
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

    return { call: (action, params) => new Promise((r) => listener({ action, params }, {}, r)) };
}

function tree(width) {
    const body = el("body");
    body.childNodes = Array.from({ length: width }, () => el("button"));
    return body;
}

test("snapshot stops at maxNodes and marks where it cut", async () => {
    const { call } = loadContent(tree(10));

    const { data } = await call("snapshot", { maxNodes: 4 });

    assert.equal(data.truncated, true, "the root says the tree is incomplete");
    assert.equal(data.childrenTruncated, true, "and the parent whose children were dropped says so");
    assert.equal(data.children.length, 3, "root plus three children fills a budget of four");
});

test("a tree inside the budget is not marked", async () => {
    const { call } = loadContent(tree(3));

    const { data } = await call("snapshot", { maxNodes: 100 });

    assert.equal(data.truncated, undefined);
    assert.equal(data.childrenTruncated, undefined);
    assert.equal(data.children.length, 3);
});

test("read_page text is capped and reports the full size", async () => {
    const body = el("body");
    body.innerText = "x".repeat(500);
    const { call } = loadContent(body);

    const { data } = await call("read_page", { format: "text", maxChars: 100 });

    assert.equal(data.slice(0, 100), "x".repeat(100));
    assert.match(data, /truncated: 500 characters total, 100 returned/);
    assert.match(data, /find or snapshot/, "and points at a way to get less");
});

test("read_page text under the cap comes back whole", async () => {
    const body = el("body");
    body.innerText = "short page";
    const { call } = loadContent(body);

    const { data } = await call("read_page", { format: "text", maxChars: 100 });

    assert.equal(data, "short page");
});
