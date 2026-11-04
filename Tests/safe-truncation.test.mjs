import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { contentScriptSource, extensionSource } from "./helpers/extension-sources.mjs";

// Cutting page text with a plain slice ends between the halves of a surrogate
// pair whenever an emoji straddles the limit, and the lone half is not valid
// Unicode. The cut is written once for the content scripts and once more for
// each MAIN-world script, which cannot read the content scripts' scope. These
// tests are the reason that is tolerable: the copies must be the same text, and
// every site that cuts page text must come out well formed.

const BEGIN = "// BEGIN safe-truncate";
const END = "// END safe-truncate";
const COPIES = ["content-core.js", "console-interceptor.js", "dialog-interceptor.js", "trace-interceptor.js"];

function clipBlock(file) {
    const text = extensionSource(file);
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    assert.ok(start !== -1 && end > start, `${file} should mark the truncation helper`);
    return text.slice(start + BEGIN.length, end).trim();
}

function loadClip(file) {
    const context = vm.createContext({});
    vm.runInContext(`${clipBlock(file)}\nthis.clipText = clipText;`, context);
    return context.clipText;
}

const EMOJI = "\u{1F600}";

// A string whose emoji occupies units `limit - 1` and `limit`, so any cut at
// `limit` falls between its halves.
const straddling = (limit) => `${"x".repeat(limit - 1)}${EMOJI}tail`;

test("every copy of the truncation helper is the same text", () => {
    const [first, ...rest] = COPIES.map(clipBlock);
    for (const other of rest) assert.equal(other, first);
});

for (const file of COPIES) {
    test(`${file} never ends a cut inside a surrogate pair`, () => {
        const clipText = loadClip(file);

        const cut = clipText(straddling(10), 10);

        assert.equal(cut, "x".repeat(9));
        assert.ok(cut.isWellFormed());
        assert.equal(clipText(`${"x".repeat(8)}${EMOJI}tail`, 10), `${"x".repeat(8)}${EMOJI}`);
        assert.equal(clipText("short", 10), "short");
        assert.equal(clipText("abcdef", 3), "abc");
        assert.equal(clipText(EMOJI, 0), "");
    });
}

// ─── Content script sites ────────────────────────────────────────────

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function el(tag, options = {}, children = []) {
    const node = {
        nodeType: ELEMENT_NODE,
        tagName: tag.toUpperCase(),
        attributes: options.attributes || {},
        hidden: false,
        id: options.id || "",
        className: options.className || "",
        childNodes: children,
        getAttribute(name) {
            return name in this.attributes ? this.attributes[name] : null;
        },
        getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 10, height: 10 }),
        getClientRects: () => [{}],
        scrollIntoView() {},
        focus() {},
        dispatchEvent() { return true; },
        getRootNode: () => ({ elementFromPoint: () => node, querySelector: () => null }),
        closest: () => null,
        contains: (other) => other === node,
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

const text = (value) => ({ nodeType: TEXT_NODE, textContent: value });

function loadContent(body) {
    let listener;
    const document = {
        body,
        documentElement: body,
        activeElement: null,
        getElementById: () => null,
        querySelector: (selector) => document.querySelectorAll(selector)[0] || null,
        querySelectorAll: (selector) => {
            const all = [];
            const collect = (node) => { for (const child of node.children) { all.push(child); collect(child); } };
            collect(body);
            return selector === "*" ? all : all.filter((node) => `#${node.id}` === selector);
        },
        createTreeWalker(root, _show, filter) {
            const queue = [];
            const collect = (node) => { for (const child of node.children) { queue.push(child); collect(child); } };
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
    vm.runInNewContext(contentScriptSource(), {
        browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
        document,
        Node: { ELEMENT_NODE, TEXT_NODE },
        NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
        WeakRef,
        setTimeout,
        clearTimeout,
        MouseEvent: class { constructor(type) { this.type = type; } },
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

test("read_page text is cut on a code point", async () => {
    const body = el("body");
    body.innerText = straddling(100) + "x".repeat(50);
    const call = loadContent(body);

    const { data } = await call("read_page", { format: "text", maxChars: 100 });

    const kept = data.slice(0, data.indexOf("\n\n[truncated"));
    assert.equal(kept, "x".repeat(99));
    assert.ok(data.isWellFormed());
    assert.match(data, /99 returned/);
});

test("snapshot text and names are cut on a code point", async () => {
    // 497 units are kept before the ellipsis, so the emoji sits at 496 and 497.
    const long = straddling(497) + "y".repeat(100);
    const body = el("body", {}, [el("p", {}, [text(long)])]);
    const call = loadContent(body);

    const { data } = await call("snapshot", {});

    const paragraph = data.children[0];
    assert.equal(paragraph.text, `${"x".repeat(496)}...`);
    assert.ok(JSON.stringify(data).length > 0 && paragraph.text.isWellFormed());
});

test("find cuts text and class names on a code point", async () => {
    const target = el("div", { id: "t", className: straddling(100) + "z" }, [text(straddling(100) + "z")]);
    const call = loadContent(el("body", {}, [target]));

    const { data, error } = await call("find", { selector: "#t" });
    assert.equal(error, null);

    assert.equal(data[0].text, "x".repeat(99));
    assert.equal(data[0].className, "x".repeat(99));
    assert.ok(JSON.stringify(data).isWellFormed());
});

test("click reports the label it hit cut on a code point", async () => {
    const target = el("button", { id: "b" }, [text(straddling(50) + "z")]);
    const call = loadContent(el("body", {}, [target]));

    const { data } = await call("click", { selector: "#b", force: true });

    assert.equal(data, `Clicked <button>: "${"x".repeat(49)}"`);
});

// ─── Page-world replies ──────────────────────────────────────────────

function replyHarness() {
    let runtimeListener;
    const listeners = new Set();
    const posted = [];
    const window = {
        addEventListener: (type, fn) => { if (type === "message") listeners.add(fn); },
        removeEventListener: (type, fn) => { if (type === "message") listeners.delete(fn); },
        postMessage: (message) => posted.push(message),
    };
    vm.runInNewContext(contentScriptSource(), {
        browser: { runtime: { onMessage: { addListener: (fn) => { runtimeListener = fn; } } } },
        document: {},
        crypto: globalThis.crypto,
        setTimeout: () => 0,
        clearTimeout() {},
        window,
    });
    return async (action, payload) => {
        const pending = new Promise((resolve) => runtimeListener({ action, params: {} }, {}, resolve));
        await new Promise((resolve) => setImmediate(resolve));
        for (const listener of [...listeners]) {
            listener({ source: window, data: { source: "MCPSafariPage", id: posted.at(-1).id, ...payload } });
        }
        return pending;
    };
}

test("a page-world reply string is cut on a code point", async () => {
    const ask = replyHarness();

    const response = await ask("get_console_messages", { data: [{ text: straddling(8192) }] });

    assert.equal(response.data[0].text, "x".repeat(8191));
    assert.ok(JSON.stringify(response.data).isWellFormed());
});

test("a page-world error message is cut on a code point", async () => {
    const ask = replyHarness();

    const response = await ask("get_console_messages", { error: straddling(1024) });

    assert.equal(response.error, "x".repeat(1023));
});

// ─── MAIN-world scripts ──────────────────────────────────────────────

test("console capture is cut on a code point", () => {
    const context = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        window: { addEventListener() {}, postMessage() {} },
        Date, JSON, RegExp, String, Set,
    };
    context.window.window = context.window;
    vm.runInNewContext(extensionSource("console-interceptor.js"), context);

    context.console.log(straddling(8192));
    context.console.log({ nested: straddling(512) });
    context.console.log(Object.assign(new Error("m"), { stack: "" }), straddling(512));
    const messages = Array.from(context.window.__mcpGetConsoleMessages({}));

    assert.equal(messages[0].text, "x".repeat(8191));
    assert.equal(messages[0].truncated, true);
    assert.equal(messages[1].text, `{"nested":"${"x".repeat(511)}"}`);
    for (const message of messages) assert.ok(message.text.isWellFormed());
});

test("console error stacks are cut on a code point", () => {
    const context = {
        console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
        window: { addEventListener() {}, postMessage() {} },
        Date, JSON, RegExp, String, Set, Error,
    };
    context.window.window = context.window;
    vm.runInNewContext(extensionSource("console-interceptor.js"), context);
    const error = new Error("boom");
    error.stack = straddling(2048);

    context.console.error(error);
    const [message] = Array.from(context.window.__mcpGetConsoleMessages({}));

    assert.ok(message.text.isWellFormed());
    assert.equal(message.text, `Error: boom\n${"x".repeat(2047)}`);
});

test("dialog text is cut on a code point", () => {
    const native = { alert: () => undefined, confirm: () => "native", prompt: () => "native" };
    const window = { ...native, addEventListener() {}, postMessage() {} };
    vm.runInNewContext(extensionSource("dialog-interceptor.js"), { window, Date, setTimeout: () => 0, clearTimeout() {} });

    window.__mcpHandleDialog({ action: "accept", promptText: "ok" });
    window.prompt(straddling(4096), straddling(4096));
    const result = window.__mcpHandleDialog({ action: "dismiss" });

    assert.equal(result.message, "x".repeat(4095));
    assert.equal(result.defaultValue, "x".repeat(4095));
    assert.equal(result.truncated, true);
});

test("trace attribute values are cut on a code point", () => {
    const window = { CSS: { escape: String }, addEventListener() {}, postMessage() {} };
    class MutationObserver {
        constructor(callback) { window.observe = callback; }
        observe() {}
        disconnect() {}
    }
    vm.runInNewContext(extensionSource("trace-interceptor.js"), {
        window,
        location: { href: "https://example.test/" },
        history: { pushState() {}, replaceState() {} },
        document: { documentElement: {} },
        MutationObserver,
        Node: { ELEMENT_NODE: 1 },
        setInterval: () => 1,
        clearInterval() {},
    });
    const long = straddling(512);
    const target = {
        nodeType: 1,
        tagName: "DIV",
        id: "",
        classList: [],
        parentElement: null,
        getAttribute: () => long,
    };
    const { id } = window.__mcpStartTrace({});

    window.observe([{ type: "attributes", target, attributeName: "style", oldValue: long }]);
    const [event] = window.__mcpStopTrace({ id }).events.filter((e) => e.type === "dom.mutation");

    assert.equal(event.value, "x".repeat(511));
    assert.equal(event.oldValue, "x".repeat(511));
    assert.equal(event.truncated, true);
});
