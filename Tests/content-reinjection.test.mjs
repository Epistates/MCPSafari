import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { CONTENT_SCRIPT_FILES, contentScriptSource } from "./helpers/extension-sources.mjs";

// The background script re-injects the content script by name whenever it finds
// it missing, and that re-runs every one of these files in a realm where the
// previous run is still live. Without a guard in each file, the second pass
// either throws on a redeclaration or registers a second message listener, and
// then every tool call is answered twice.
function loadInto(context) {
    vm.runInContext(contentScriptSource(), context);
}

function makeContext() {
    const listeners = [];
    const element = {
        nodeType: 1,
        tagName: "BODY",
        attributes: {},
        childNodes: [],
        children: [],
        textContent: "",
        getAttribute: () => null,
        getBoundingClientRect: () => ({ x: 0, y: 0, left: 0, top: 0, width: 0, height: 0 }),
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    const windowStub = {
        addEventListener() {},
        removeEventListener() {},
        postMessage() {},
        innerWidth: 1200,
        innerHeight: 800,
        getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    };
    const context = vm.createContext({
        browser: { runtime: { onMessage: { addListener: (fn) => listeners.push(fn) } } },
        console: { error() {}, log() {}, warn() {} },
        document: { body: element, documentElement: element, activeElement: null },
        Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
        NodeFilter: { SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_SKIP: 3 },
        WeakRef,
        setTimeout,
        clearTimeout,
        window: windowStub,
    });
    // The scripts read `window` for the namespace, so the stub has to be the
    // same object the context hands them.
    vm.runInContext("window.self = window", context);
    return { context, listeners };
}

test("re-injecting the content script does not throw or answer twice", () => {
    const { context, listeners } = makeContext();

    loadInto(context);
    assert.equal(listeners.length, 1, "the first load registers the message listener");

    // Exactly what `injectContentScripts` does when a tab has lost its content
    // script: the same files, by name, into a frame that may still have them.
    loadInto(context);
    loadInto(context);

    assert.equal(listeners.length, 1, "a re-injection must not add another listener");
});

test("every file guards itself, so the namespace survives a re-injection intact", () => {
    const { context } = makeContext();
    loadInto(context);

    const before = vm.runInContext("Object.keys(window.__mcpSafari).sort().join()", context);
    const loaded = vm.runInContext("[...window.__mcpSafari.loaded].sort().join()", context);
    loadInto(context);
    const after = vm.runInContext("Object.keys(window.__mcpSafari).sort().join()", context);

    assert.equal(after, before, "a second pass neither adds nor drops published functions");
    // One entry per file, so a file that forgot its guard would be visible here
    // rather than only as a duplicated side effect somewhere else.
    assert.equal(loaded.split(",").length, CONTENT_SCRIPT_FILES.length);
});
