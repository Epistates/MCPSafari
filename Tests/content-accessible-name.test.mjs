import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { contentScriptSource } from "./helpers/extension-sources.mjs";

const source = contentScriptSource();

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function text(value) {
    return { nodeType: TEXT_NODE, textContent: value };
}

// Tags a browser lays out inline. Everything else is a block, which is what
// separates `<div>A</div><div>B</div>` into two words.
const INLINE_TAGS = new Set(["a", "b", "strong", "em", "i", "span", "svg", "img", "code", "my-label"]);

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

function el(tag, options = {}, children = []) {
    const node = {
        nodeType: ELEMENT_NODE,
        tagName: tag.toUpperCase(),
        attributes: options.attributes || {},
        hidden: false,
        id: options.id || "",
        childNodes: children,
        parentElement: null,
        shadowRoot: null,
        events: [],
        display: options.display || (INLINE_TAGS.has(tag) ? "inline" : "block"),
        getAttribute(name) {
            return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
        },
        getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 100, height: 20 }),
        getClientRects: () => [{}],
        getRootNode: () => fakeDocument,
        contains(other) {
            for (let n = other; n; n = n.parentElement) if (n === this) return true;
            return false;
        },
        closest(selector) {
            const parts = selector.split(/,\s*/);
            for (let n = this; n; n = n.parentElement) {
                if (parts.some((part) => n.tagName.toLowerCase() === part)) return n;
            }
            return null;
        },
        scrollIntoView() { lastScrolled = node; },
        focus() {},
        dispatchEvent(event) {
            node.events.push(event.type);
            return true;
        },
        ...(options.props || {}),
    };
    for (const child of children) if (child.nodeType === ELEMENT_NODE) child.parentElement = node;
    Object.defineProperty(node, "children", {
        get: () => node.childNodes.filter((c) => c.nodeType === ELEMENT_NODE),
    });
    Object.defineProperty(node, "textContent", {
        get: () => node.childNodes.map((c) => c.textContent ?? "").join(""),
    });
    if (options.assigned) {
        node.assignedNodes = () => options.assigned;
        node.assignedElements = () => options.assigned.filter((n) => n.nodeType === ELEMENT_NODE);
    }
    return node;
}

function field(type, value, attributes = {}) {
    return el("input", { attributes: { type, ...attributes }, props: { type, value } });
}

// An open shadow root answering the queries root discovery and targeting make.
function attachShadow(host, children) {
    const root = { nodeType: 11, childNodes: children };
    Object.defineProperty(root, "children", {
        get: () => root.childNodes.filter((c) => c.nodeType === ELEMENT_NODE),
    });
    root.querySelectorAll = () => descendants(root);
    root.querySelector = () => null;
    host.shadowRoot = root;
    for (const child of children) if (child.nodeType === ELEMENT_NODE) child.parentElement = host;
    return host;
}

let fakeDocument;
let lastScrolled = null;

function loadContent(body) {
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
        querySelector: () => null,
        querySelectorAll: () => descendants(body),
        elementFromPoint: () => lastScrolled,
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
            getComputedStyle: (node) => ({ display: node.display, visibility: "visible", opacity: "1" }),
        },
    });
    return (action, params) => new Promise((resolve) => listener({ action, params }, {}, resolve));
}

function flatten(node, out = []) {
    if (!node) return out;
    out.push(node);
    for (const child of node.children || []) flatten(child, out);
    return out;
}

async function snapshotOf(body) {
    const call = loadContent(body);
    const { data } = await call("snapshot", {});
    return data;
}

const TITLE = "Modeling Sporadic Alzheimer's Disease in Human Brain Organoids under Serum Exposure.";

function titleLink() {
    return el("a", { attributes: { href: "/34337898/" }, props: { href: "https://example.test/34337898/" } }, [
        text("Modeling Sporadic Alzheimer's Disease in Human "),
        el("b", {}, [text("Brain")]),
        text(" Organoids under "),
        el("b", {}, [text("Serum")]),
        text(" Exposure."),
    ]);
}

test("a link with inline markup is named by its whole text in reading order", async () => {
    const tree = await snapshotOf(el("body", {}, [titleLink()]));
    const link = tree.children[0];

    assert.equal(link.role, "link");
    assert.equal(link.name, TITLE);
});

test("the markup's words stay reachable as children while text stays the element's own", async () => {
    const tree = await snapshotOf(el("body", {}, [titleLink()]));
    const link = tree.children[0];

    // text is documented as the element's own text nodes; name carries the label.
    assert.equal(link.text, "Modeling Sporadic Alzheimer's Disease in Human  Organoids under  Exposure.");
    assert.equal(link.children.map((child) => child.text).join("|"), "Brain|Serum");
    assert.ok(link.children.every((child) => /^f0e\d+$/.test(child.uid)));
});

test("a link whose own text is empty is named by its child's text", async () => {
    const link = el("a", {}, [el("span", {}, [text("Create RSS")])]);
    const tree = await snapshotOf(el("body", {}, [link]));

    assert.equal(tree.children[0].name, "Create RSS");
    assert.equal(tree.children[0].text, undefined);
});

test("whitespace between and inside the pieces collapses to single spaces", async () => {
    const link = el("a", {}, [text("\n   Human\n  "), el("b", {}, [text("Brain")]), text("\t\n Organoids  \n")]);
    const tree = await snapshotOf(el("body", {}, [link]));

    assert.equal(tree.children[0].name, "Human Brain Organoids");
});

test("an aria-hidden icon beside a label does not enter the name", async () => {
    const icon = el("svg", { attributes: { "aria-hidden": "true" } }, [
        el("title", {}, [text("floppy disk icon")]),
    ]);
    const button = el("button", {}, [icon, text(" Save")]);
    const tree = await snapshotOf(el("body", {}, [button]));

    assert.equal(tree.children[0].name, "Save");
});

test("text in a display:none child does not enter the name", async () => {
    const button = el("button", {}, [
        text("Save"),
        el("span", { display: "none" }, [text(" (opens a dialog)")]),
    ]);
    const tree = await snapshotOf(el("body", {}, [button]));

    assert.equal(tree.children[0].name, "Save");
});

test("aria-label wins over content", async () => {
    const button = el("button", { attributes: { "aria-label": "Open Trash" } }, [text("🗑"), el("b", {}, [text("9")])]);
    const tree = await snapshotOf(el("body", {}, [button]));

    assert.equal(tree.children[0].name, "Open Trash");
});

test("block-level children are separate words and inline ones are not", async () => {
    const stacked = el("button", {}, [el("div", {}, [text("Title")]), el("div", {}, [text("Subtitle")])]);
    const joined = el("a", {}, [el("b", {}, [text("Fo")]), text("o")]);
    const tree = await snapshotOf(el("body", {}, [stacked, joined]));

    assert.equal(tree.children[0].name, "Title Subtitle");
    assert.equal(tree.children[1].name, "Foo");
});

test("an image or labelled icon inside a link contributes its alt or aria-label", async () => {
    const logo = el("a", {}, [el("img", { props: { alt: "Acme home" } })]);
    const cart = el("a", {}, [el("span", { attributes: { "aria-label": "Cart" } }, [text("(3)")]), text(" items")]);
    const tree = await snapshotOf(el("body", {}, [logo, cart]));

    assert.equal(tree.children[0].name, "Acme home");
    assert.equal(tree.children[1].name, "Cart items");
});

test("a field's value inside a link never reaches the name", async () => {
    const secret = "hunter2-sekret";
    const link = el("a", {}, [
        text("Sign in as "),
        field("password", secret),
        field("text", secret, { name: "otp" }),
        el("textarea", { props: { value: secret } }, [text(secret)]),
    ]);
    const call = loadContent(el("body", {}, [link]));

    // find reports the name even when the tree omits one equal to the text.
    const { data } = await call("find", { selector: "a" });
    assert.equal(data[0].name, "Sign in as");

    const tree = (await call("snapshot", {})).data;
    assert.ok(!(tree.children[0].name || "").includes(secret));
});

test("a heading with inline markup is named by its whole text", async () => {
    const heading = el("h2", {}, [text("Latest "), el("em", {}, [text("news")]), text(" today")]);
    const tree = await snapshotOf(el("body", {}, [heading]));

    assert.equal(tree.children[0].name, "Latest news today");
});

test("roles that are not named by content get no name from it", async () => {
    const paragraph = el("p", {}, [text("Hello "), el("b", {}, [text("world")])]);
    const tree = await snapshotOf(el("body", {}, [paragraph]));

    assert.equal(tree.children[0].name, undefined);
});

test("an explicit role opts a div into name from content", async () => {
    const tab = el("div", { attributes: { role: "tab" } }, [text("Inbox "), el("b", {}, [text("(4)")])]);
    const tree = await snapshotOf(el("body", {}, [tab]));

    assert.equal(tree.children[0].name, "Inbox (4)");
});

test("a long name is cut at the same cap the snapshot uses for text", async () => {
    const long = "word ".repeat(300).trim();
    const link = el("a", {}, [el("span", {}, [text(long)])]);
    const tree = await snapshotOf(el("body", {}, [link]));
    const node = tree.children[0];

    assert.equal(node.name.length, 500);
    assert.ok(node.name.endsWith("..."));
    assert.equal(node.name.length, node.children[0].text.length);
});

test("inside an open shadow root a link is named by its content", async () => {
    const inner = el("a", {}, [text("Read "), el("b", {}, [text("more")])]);
    const host = attachShadow(el("my-card"), [inner]);
    const tree = await snapshotOf(el("body", {}, [host]));

    const link = flatten(tree).find((node) => node.tag === "a");
    assert.equal(link.name, "Read more");
});

test("a link's name follows its content into a shadow host and through a slot", async () => {
    const slotted = el("b", {}, [text("light")]);
    const slot = el("slot", { assigned: [text("slotted "), slotted] });
    const label = attachShadow(el("my-label", {}, [text("ignored light child")]), [text("shadow "), slot]);
    const link = el("a", {}, [label]);
    const tree = await snapshotOf(el("body", {}, [link]));

    assert.equal(tree.children[0].name, "shadow slotted light");
});

test("find matches a link by its full visible title", async () => {
    const call = loadContent(el("body", {}, [titleLink()]));

    const { data } = await call("find", { text: "Brain Organoids under Serum" });

    assert.equal(data.length, 1);
    assert.equal(data[0].tag, "a");
    assert.equal(data[0].name, TITLE);
});

test("click by the full visible title acts on the link", async () => {
    const link = titleLink();
    const call = loadContent(el("body", {}, [el("li", {}, [link])]));

    const response = await call("click", { text: TITLE });

    assert.equal(response.error, null);
    assert.ok(link.events.includes("click"));
});

test("click by the title as snapshots report it matches markup that wraps across lines", async () => {
    // Source formatting puts newlines and runs of spaces between the pieces,
    // and the name an agent copies from a snapshot has them collapsed.
    const link = el("a", {}, [
        text("Human\n        "),
        el("b", {}, [text("Brain")]),
        text("\n        Organoids"),
    ]);
    const call = loadContent(el("body", {}, [link]));

    const response = await call("click", { text: "Human Brain Organoids" });

    assert.equal(response.error, null);
    assert.ok(link.events.includes("click"));
});

test("hover by the full visible title acts on the link", async () => {
    const link = titleLink();
    const call = loadContent(el("body", {}, [link]));

    const response = await call("hover", { text: TITLE });

    assert.equal(response.error, null);
    assert.ok(link.events.length > 0);
});

test("a title does not replace the content of a link", async () => {
    const link = el("a", { props: { title: "Read the full story" } }, [text("Read more")]);
    const call = loadContent(el("body", {}, [link]));

    const { data } = await call("find", { selector: "a" });

    assert.equal(data[0].name, "Read more");
});

test("a link with no content is named by its title", async () => {
    const link = el("a", { props: { title: "Home" } }, [el("svg", { attributes: { "aria-hidden": "true" } })]);
    const call = loadContent(el("body", {}, [link]));

    const { data } = await call("find", { selector: "a" });

    assert.equal(data[0].name, "Home");
});

test("the inline-markup link keeps its content name when it also has a title", async () => {
    const link = titleLink();
    link.title = "Open abstract";
    const tree = await snapshotOf(el("body", {}, [link]));

    assert.equal(tree.children[0].name, TITLE);
});

test("a title still names an element that is not named by its content", async () => {
    const note = el("p", { props: { title: "Tooltip" } }, [text("Body")]);
    const call = loadContent(el("body", {}, [note]));

    const { data } = await call("find", { selector: "p" });

    assert.equal(data[0].name, "Tooltip");
});

test("a name that only repeats the node's text is left out of the tree", async () => {
    const tree = await snapshotOf(el("body", {}, [
        el("a", {}, [text("Home")]),
        el("button", {}, [text("  Save\n   draft ")]),
        el("h1", {}, [text("Welcome")]),
    ]));

    for (const node of tree.children) {
        assert.equal(node.name, undefined, `${node.tag} repeated its text as a name`);
    }
    assert.equal(tree.children[0].text, "Home");
    assert.equal(tree.children[1].text, "Save\n   draft");
});

test("a name that differs from the node's text stays in the tree", async () => {
    const tree = await snapshotOf(el("body", {}, [
        el("button", { attributes: { "aria-label": "Open Trash" } }, [text("Trash")]),
        el("a", {}, [el("img", { props: { alt: "Acme home" } })]),
        titleLink(),
    ]));

    assert.equal(tree.children[0].name, "Open Trash");
    assert.equal(tree.children[1].name, "Acme home");
    assert.equal(tree.children[2].name, TITLE);
});

test("find still reports the name of a node whose tree entry omits it", async () => {
    const link = el("a", {}, [text("Home")]);
    const call = loadContent(el("body", {}, [link]));

    const tree = (await call("snapshot", {})).data;
    const { data } = await call("find", { selector: "a" });

    assert.equal(tree.children[0].name, undefined);
    assert.equal(data[0].name, "Home");
});

test("click and hover by a name the tree omits still act on the element", async () => {
    const link = el("a", {}, [text("Home")]);
    const call = loadContent(el("body", {}, [link]));

    assert.equal((await call("click", { text: "Home" })).error, null);
    assert.equal((await call("hover", { text: "Home" })).error, null);
    assert.ok(link.events.includes("click"));
});
