import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { contentScriptSource } from "./helpers/extension-sources.mjs";

const source = contentScriptSource();

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

function loadContent(body, documentOverrides = {}) {
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
            ...documentOverrides,
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

// ─── Strings a node carries ──────────────────────────────────────────

const MEGABYTE = "x".repeat(1024 * 1024);

// An element whose attributes and properties come from the page, which is the
// only place the strings in a snapshot can come from.
function pageEl(tag, { attributes = {}, ...props } = {}) {
    const node = el(tag);
    node.getAttribute = (name) => (name in attributes ? attributes[name] : null);
    return Object.assign(node, props);
}

test("every string a snapshot node carries is capped", async () => {
    const field = pageEl("input", { value: MEGABYTE, attributes: { "aria-label": MEGABYTE } });
    const link = pageEl("a", { href: `https://example.test/${MEGABYTE}`, textContent: MEGABYTE });
    const frame = pageEl("iframe", { src: `https://example.test/${MEGABYTE}` });
    const labelled = pageEl("div", { attributes: { "aria-labelledby": "big" } });
    const body = el("body");
    body.childNodes = [field, link, frame, labelled];
    const { call } = loadContent(body, { getElementById: () => ({ textContent: MEGABYTE }) });

    const { data } = await call("snapshot", {});

    const [input, anchor, iframe, byReference] = data.children;
    assert.equal(input.value.length, 500);
    assert.equal(input.name.length, 500);
    assert.equal(anchor.href.length, 2048);
    assert.equal(anchor.text.length, 500);
    assert.equal(iframe.frameSrc.length, 2048);
    assert.equal(byReference.name.length, 500);
    assert.ok(JSON.stringify(data).length < 10000);
});

test("find caps the strings it describes", async () => {
    const big = pageEl("button", { id: MEGABYTE, attributes: { "aria-label": MEGABYTE }, className: MEGABYTE });
    big.textContent = MEGABYTE;
    const body = el("body");
    body.childNodes = [big];
    const { call } = loadContent(body, { querySelectorAll: () => [big] });

    const { data } = await call("find", { selector: "button" });

    assert.equal(data[0].id.length, 500);
    assert.equal(data[0].name.length, 500);
    assert.equal(data[0].text.length, 100);
    assert.equal(data[0].className.length, 100);
});

test("a snapshot stops at its character budget and says so", async () => {
    // Each link carries about 3,000 characters, so a thousand of them are three
    // million: well past the budget but nowhere near the node limit.
    const body = el("body");
    body.childNodes = Array.from({ length: 1000 }, () => pageEl("a", {
        href: `https://example.test/${MEGABYTE}`,
        textContent: "y".repeat(500),
        attributes: { "aria-label": MEGABYTE },
    }));
    const { call } = loadContent(body);

    const { data } = await call("snapshot", { maxNodes: 5000 });

    assert.equal(data.truncated, true);
    assert.equal(data.childrenTruncated, true);
    assert.ok(data.children.length > 100 && data.children.length < 1000, `kept ${data.children.length}`);
    // The budget counts the strings, not the keys around them.
    assert.ok(JSON.stringify(data).length < 2200000, "stopped near the budget, not at the end");
});

test("a snapshot well inside the character budget is not cut by it", async () => {
    const body = el("body");
    body.childNodes = Array.from({ length: 1500 }, () => pageEl("a", {
        href: "https://example.test/some/path?with=query",
        textContent: "z".repeat(200),
    }));
    const { call } = loadContent(body);

    const { data } = await call("snapshot", {});

    assert.equal(data.truncated, undefined);
    assert.equal(data.children.length, 1500);
});
