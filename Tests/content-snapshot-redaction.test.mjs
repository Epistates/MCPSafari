import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { contentScriptSource } from "./helpers/extension-sources.mjs";

const source = contentScriptSource();

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const REDACTED = "[redacted]";

function textNode(value) {
    return { nodeType: TEXT_NODE, textContent: value };
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

// Tag selectors and `*` are all the content script's root discovery asks for.
function addQueries(node) {
    node.querySelectorAll = (selector) =>
        descendants(node).filter((el) => selector === "*" || el.tagName.toLowerCase() === selector);
    node.querySelector = (selector) => node.querySelectorAll(selector)[0] || null;
    return node;
}

function el(tag, { id = "", attributes = {}, props = {} } = {}, children = []) {
    const node = {
        nodeType: ELEMENT_NODE,
        tagName: tag.toUpperCase(),
        hidden: false,
        id,
        attributes,
        childNodes: children,
        shadowRoot: null,
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
        },
        getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 10, height: 10 }),
        ...props,
    };
    Object.defineProperty(node, "children", {
        get: () => node.childNodes.filter((c) => c.nodeType === ELEMENT_NODE),
    });
    Object.defineProperty(node, "textContent", {
        get: () => node.childNodes.map((c) => c.textContent ?? "").join(""),
    });
    return addQueries(node);
}

function field(tag, { type = "text", value = "s3cret", id = "", attributes = {} } = {}, children = []) {
    return el(tag, { id, attributes, props: { type, value } }, children);
}

function attachShadow(host, children) {
    const root = { nodeType: 11, childNodes: children };
    Object.defineProperty(root, "children", {
        get: () => root.childNodes.filter((c) => c.nodeType === ELEMENT_NODE),
    });
    host.shadowRoot = addQueries(root);
    return host;
}

function loadContent(body) {
    let listener;
    const observers = [];
    class FakeMutationObserver {
        constructor(callback) {
            this.callback = callback;
            this.observed = [];
            observers.push(this);
        }
        observe(root, options) { this.observed.push({ root, options }); }
        disconnect() {}
    }
    const document = {
        body,
        documentElement: body,
        activeElement: null,
        getElementById: () => null,
        querySelectorAll: (selector) =>
            descendants(body).concat([body]).filter((e) => selector === "*" || e.tagName.toLowerCase() === selector),
    };
    document.querySelector = (selector) => document.querySelectorAll(selector)[0] || null;

    vm.runInNewContext(source, {
        browser: { runtime: { onMessage: { addListener: (fn) => { listener = fn; } } } },
        document,
        MutationObserver: FakeMutationObserver,
        Node: { ELEMENT_NODE, TEXT_NODE },
        NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
        WeakRef,
        setTimeout,
        clearTimeout,
        window: {
            addEventListener: () => {},
            removeEventListener: () => {},
            postMessage: () => {},
            innerWidth: 1200,
            innerHeight: 800,
            getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
        },
    });

    const call = (action, params) => new Promise((resolve) => listener({ action, params }, {}, resolve));
    call.observers = observers;
    return call;
}

async function snapshotValues(...fields) {
    const call = loadContent(el("body", {}, fields));
    const { data, error } = await call("snapshot", {});
    assert.equal(error, null);
    return data.children.map((child) => child.value);
}

// Every token the browser vocabulary uses for a secret. Pinning all eight
// matters because a typo in one is invisible until that field type is filled.
for (const token of [
    "current-password", "new-password", "one-time-code",
    "cc-number", "cc-csc", "cc-exp", "cc-exp-month", "cc-exp-year",
]) {
    test(`autocomplete="${token}" is redacted`, async () => {
        const [value] = await snapshotValues(field("input", { attributes: { autocomplete: token } }));
        assert.equal(value, REDACTED);
    });
}

test("a sensitive token among section and hint tokens is still found", async () => {
    const [value] = await snapshotValues(field("input", { attributes: { autocomplete: "section-x cc-csc" } }));
    assert.equal(value, REDACTED);
});

test("an upper-case type=PASSWORD is redacted", async () => {
    const [value] = await snapshotValues(field("input", { type: "PASSWORD" }));
    assert.equal(value, REDACTED);
});

test("a password input inside a shadow root is redacted", async () => {
    const host = attachShadow(el("login-form"), [field("input", { type: "password" })]);
    const call = loadContent(el("body", {}, [host]));

    const { data } = await call("snapshot", {});

    assert.equal(data.children[0].children[0].value, REDACTED);
});

test("a textarea marked sensitive is redacted and does not leak through its default text", async () => {
    const secret = field("textarea", { value: "recovery words", attributes: { name: "recovery_secret" } }, [
        textNode("recovery words"),
    ]);
    const call = loadContent(el("body", {}, [secret]));

    const { data } = await call("snapshot", {});
    const node = data.children[0];

    assert.equal(node.value, REDACTED);
    assert.equal(node.text, undefined);
});

test("an ordinary textarea keeps its value", async () => {
    const [value] = await snapshotValues(field("textarea", { value: "Dear team", attributes: { name: "message" } }));
    assert.equal(value, "Dear team");
});

// The name, id, label and input mode are only hints, so the table is as much
// about what must stay readable as about what must not.
const SECRET_HINTS = [
    { attributes: { name: "password_confirm" } },
    { attributes: { name: "userPwd" } },
    { attributes: { name: "newPassword" } },
    { id: "otpCode" },
    { id: "login-pin" },
    { attributes: { "aria-label": "Enter your PIN" } },
    { attributes: { name: "CVV" } },
    { attributes: { name: "card_cvc" } },
    { attributes: { name: "ssn" } },
    { attributes: { name: "api_secret" } },
    { attributes: { name: "authToken" } },
    { attributes: { name: "2fa_code" } },
    { attributes: { name: "one-time-passcode" } },
    { attributes: { name: "OTPCode" } },
    { attributes: { inputmode: "one-time-code" } },
    { attributes: { autocomplete: "off", name: "pass" } },
];

for (const hint of SECRET_HINTS) {
    test(`a field hinted ${JSON.stringify(hint)} is redacted`, async () => {
        const [value] = await snapshotValues(field("input", hint));
        assert.equal(value, REDACTED);
    });
}

test("names that merely resemble a secret stay readable", async () => {
    const values = await snapshotValues(
        field("input", { value: "a", attributes: { name: "shipping_address" } }),
        field("input", { value: "b", attributes: { name: "passenger" } }),
        field("input", { value: "c", attributes: { name: "compass" } }),
        field("input", { value: "d", attributes: { name: "username" } }),
        field("input", { value: "e", attributes: { name: "email" } }),
        field("input", { value: "f", attributes: { "aria-label": "Search" } }),
        field("input", { value: "g", attributes: { name: "bypass_cache" } })
    );
    assert.deepEqual([...values], ["a", "b", "c", "d", "e", "f", "g"]);
});

test("a checkbox or button named like a secret keeps its fixed value", async () => {
    const values = await snapshotValues(
        field("input", { type: "checkbox", value: "on", attributes: { name: "remember_token" } }),
        field("input", { type: "submit", value: "Save", attributes: { name: "token" } })
    );
    assert.deepEqual([...values], ["on", "Save"]);
});

// A show-password toggle flips the field to type=text, after which nothing on
// the element says it was ever a password.
test("a field that was a password stays redacted after a show-password toggle", async () => {
    const toggled = field("input", { type: "password", attributes: { name: "field1" } });
    const call = loadContent(el("body", {}, [toggled]));

    // The page flips it, and the observer set up at load is told about it.
    toggled.type = "text";
    for (const observer of call.observers) {
        observer.callback([{ target: toggled, oldValue: "password" }]);
    }
    const { data } = await call("snapshot", {});

    assert.equal(data.children[0].value, REDACTED);
});

test("the same field is not redacted if it never was a password", async () => {
    const plain = field("input", { type: "text", attributes: { name: "field1" } });
    const call = loadContent(el("body", {}, [plain]));
    for (const observer of call.observers) {
        observer.callback([{ target: plain, oldValue: "search" }]);
    }

    const { data } = await call("snapshot", {});

    assert.equal(data.children[0].value, "s3cret");
});

test("password fields already on the page at the first snapshot are remembered", async () => {
    const pw = field("input", { type: "password", attributes: { name: "field1" } });
    const host = attachShadow(el("login-form"), [pw]);
    const call = loadContent(el("body", {}, [host]));

    await call("snapshot", {});
    // The shadow root was first reached by that snapshot, which is when it began
    // being watched and scanned.
    pw.type = "text";
    const { data } = await call("snapshot", {});

    assert.equal(data.children[0].children[0].value, REDACTED);
});
