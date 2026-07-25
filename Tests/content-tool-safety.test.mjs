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

// Minimal DOM stand-ins: enough for snapshot, find, and the interaction
// handlers, which need node types, children, text, attributes, and visibility.
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
        scrollIntoView() {},
        focus() {},
        dispatchEvent() { return true; },
        ...options.extra,
    };
    Object.defineProperty(node, "children", {
        get: () => node.childNodes.filter((c) => c.nodeType === ELEMENT_NODE),
    });
    if (!("textContent" in (options.extra || {}))) {
        Object.defineProperty(node, "textContent", {
            get: () => node.childNodes.map((c) => c.textContent).join(""),
        });
    }
    return node;
}

function loadContent(body, documentOverrides = {}) {
    let listener;
    const document = {
        body,
        documentElement: body,
        activeElement: null,
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createTreeWalker(root, _show, filter) {
            const queue = [];
            const collect = (n) => { for (const c of n.children) { queue.push(c); collect(c); } };
            collect(root);
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
    };

    class FakeEvent {
        constructor(type, options = {}) {
            this.type = type;
            Object.assign(this, options);
        }
    }

    const scrolls = [];
    vm.runInNewContext(source, {
        browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
        document,
        Node: { ELEMENT_NODE, TEXT_NODE },
        NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
        WeakRef,
        setTimeout,
        clearTimeout,
        Event: FakeEvent,
        KeyboardEvent: FakeEvent,
        MouseEvent: FakeEvent,
        // No native `value` descriptor, so setInputValue takes its direct-assign path.
        HTMLInputElement: class {},
        HTMLTextAreaElement: class {},
        window: {
            addEventListener: () => {},
            removeEventListener: () => {},
            postMessage: () => {},
            innerHeight: 800,
            scrollBy: (options) => scrolls.push(options),
            getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
        },
    });

    const call = (action, params) => new Promise((r) => listener({ action, params }, {}, r));
    call.scrolls = scrolls;
    return call;
}

// ─── Snapshot redaction ──────────────────────────────────────────────

test("snapshot redacts password field values but keeps ordinary ones", async () => {
    const password = el("input", { id: "pw", extra: { type: "password", value: "hunter2" } });
    const email = el("input", { id: "email", extra: { type: "email", value: "a@b.com" } });
    const call = loadContent(el("body", {}, [password, email]));

    const { data } = await call("snapshot", {});

    assert.equal(data.children[0].value, "[redacted]");
    assert.equal(data.children[1].value, "a@b.com");
});

test("snapshot redacts inputs marked sensitive by autocomplete", async () => {
    const otp = el("input", {
        attributes: { autocomplete: "one-time-code" },
        extra: { type: "text", value: "123456" },
    });
    const card = el("input", {
        attributes: { autocomplete: "section-payment cc-number" },
        extra: { type: "text", value: "4111111111111111" },
    });
    const name = el("input", {
        attributes: { autocomplete: "name" },
        extra: { type: "text", value: "Jane" },
    });
    const call = loadContent(el("body", {}, [otp, card, name]));

    const { data } = await call("snapshot", {});

    assert.equal(data.children[0].value, "[redacted]");
    assert.equal(data.children[1].value, "[redacted]");
    assert.equal(data.children[2].value, "Jane");
});

// ─── Accessible name resolution ──────────────────────────────────────

test("accessible name escapes ids that would build a malformed selector", async () => {
    const selectors = [];
    const target = el("div", { id: 'a"b' });
    const call = loadContent(el("body", {}, [target]), {
        querySelector: (selector) => {
            // A real DOM throws on an unescaped quote; fail loudly the same way.
            if (/[^\\]"[^\]]/.test(selector.slice('label[for="'.length))) {
                throw new Error(`invalid selector: ${selector}`);
            }
            selectors.push(selector);
            return null;
        },
    });

    const { data, error } = await call("snapshot", {});

    assert.equal(error, null);
    assert.equal(data.children.length, 1);
    assert.ok(selectors.length > 0, "the escaped selector was still queried");
});

test("aria-labelledby joins every referenced id", async () => {
    const call = loadContent(
        el("body", {}, [el("div", { attributes: { "aria-labelledby": "t1 t2" } })]),
        {
            getElementById: (id) => ({ textContent: id === "t1" ? "Delete" : "forever" }),
        }
    );

    const { data } = await call("snapshot", {});

    assert.equal(data.children[0].name, "Delete forever");
});

// ─── find caps ───────────────────────────────────────────────────────

test("find by selector is capped like the other match strategies", async () => {
    const many = Array.from({ length: 500 }, (_, i) => el("div", { id: `d${i}` }));
    const call = loadContent(el("body", {}, many), { querySelectorAll: () => many });

    const { data } = await call("find", { selector: "div" });

    assert.equal(data.length, 50);
});

// ─── select_option ───────────────────────────────────────────────────

function selectHarness(optionValues) {
    const options = optionValues.map((value) => ({ value, textContent: value.toUpperCase() }));
    let stored = optionValues[0];
    const select = el("select", { id: "s" });
    select.options = options;
    // Mirrors the real setter: an unmatched value clears the selection.
    Object.defineProperty(select, "value", {
        get: () => stored,
        set: (v) => { stored = options.some((o) => o.value === v) ? v : ""; },
    });
    return {
        select,
        current: () => stored,
        call: loadContent(el("body", {}, [select]), { querySelector: () => select }),
    };
}

test("select_option fails instead of silently selecting nothing", async () => {
    const { call, current } = selectHarness(["a", "b"]);

    const response = await call("select_option", { selector: "#s", value: "nope" });

    assert.equal(response.errorCode, "target_not_found");
    assert.match(response.error, /No option with value "nope"/);
    assert.equal(current(), "a", "the previous selection is restored");
});

test("select_option still selects a real value and label", async () => {
    const byValue = selectHarness(["a", "b"]);
    const valueResponse = await byValue.call("select_option", { selector: "#s", value: "b" });
    assert.equal(valueResponse.error, null);
    assert.equal(byValue.current(), "b");

    const byLabel = selectHarness(["a", "b"]);
    const labelResponse = await byLabel.call("select_option", { selector: "#s", label: "B" });
    assert.equal(labelResponse.error, null);
    assert.equal(byLabel.current(), "b");
});

test("select_option requires a value or label", async () => {
    const { call } = selectHarness(["a"]);

    const response = await call("select_option", { selector: "#s" });

    assert.equal(response.errorCode, "invalid_input");
    assert.equal(response.recoveryAction, "fix_input");
});

// ─── form_input ──────────────────────────────────────────────────────

test("form_input fails when no field matched, but reports a partial fill", async () => {
    const field = el("input", { id: "a", extra: { value: "" } });
    const allMissing = loadContent(el("body", {}, []), { querySelector: () => null });

    const failed = await allMissing("form_input", { fields: { "#a": "1", "#b": "2" } });
    assert.equal(failed.errorCode, "target_not_found");
    assert.match(failed.error, /#a, #b/);

    const partial = loadContent(el("body", {}, [field]), {
        querySelector: (selector) => (selector === "#a" ? field : null),
    });
    const mixed = await partial("form_input", { fields: { "#a": "1", "#b": "2" } });
    assert.equal(mixed.error, null);
    assert.match(mixed.data, /#a: filled/);
    assert.match(mixed.data, /#b: not found/);
});

test("form_input requires at least one field", async () => {
    const response = await loadContent(el("body", {}, []))("form_input", { fields: {} });

    assert.equal(response.errorCode, "invalid_input");
    assert.equal(response.recoveryAction, "fix_input");
});

// ─── Required arguments ──────────────────────────────────────────────

test("missing required arguments return invalid_input, not a raw TypeError", async () => {
    const call = loadContent(el("body", {}, []));

    for (const [action, params] of [
        ["press_key", {}],
        ["click", {}],
        ["hover", {}],
        ["scroll", {}],
        ["drag", {}],
    ]) {
        const response = await call(action, params);
        assert.equal(response.errorCode, "invalid_input", `${action} should reject cleanly`);
        assert.equal(response.recoveryAction, "fix_input", `${action} should say how to recover`);
        assert.equal(response.data, null);
    }
});

test("press_key reports physical key codes for digits and letters", async () => {
    const events = [];
    const body = el("body", {}, []);
    body.dispatchEvent = (event) => { events.push(event); return true; };
    const call = loadContent(body, { activeElement: null, body });

    await call("press_key", { key: "1" });
    await call("press_key", { key: "a" });
    await call("press_key", { key: "Enter" });

    assert.equal(events[0].code, "Digit1");
    assert.equal(events[3].code, "KeyA");
    assert.equal(events[6].code, "Enter");
});

test("scroll treats amount 0 as an explicit no-op distance", async () => {
    const call = loadContent(el("body", {}, []));

    const response = await call("scroll", { direction: "down", amount: 0 });

    assert.equal(response.error, null);
    assert.match(response.data, /Scrolled down by 0px/);
    assert.equal(call.scrolls[0].top, 0);
    assert.equal(call.scrolls[0].left, 0);
});
