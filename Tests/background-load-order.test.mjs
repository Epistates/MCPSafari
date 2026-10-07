import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { BACKGROUND_SCRIPT_FILES, extensionSource } from "./helpers/extension-sources.mjs";

// Every other background test concatenates the files and runs them as one
// script. That is faithful for behaviour, and blind to exactly one thing: in a
// single script every function declaration hoists to the top, so a file may
// reference a function declared in a later file and still work. The browser
// loads these as separate scripts, where hoisting stops at the file boundary,
// and the same reference throws ReferenceError before the extension starts.
//
// So these tests run each file as its own script in one shared context, which
// is what Safari does, and assert the one invariant that keeps that safe: no
// file may use a declaration from a later file while it is loading.
function stubContext() {
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        scripting: { executeScript: async () => [{ result: true }] },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            get: async (id) => ({ id, active: true, windowId: 1, url: "https://ok.example/" }),
            query: async () => [],
            sendMessage: async () => ({ data: "ok", error: null }),
            remove: async () => {},
            update: async () => {},
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
        windows: { update: async () => {} },
    };

    return vm.createContext({
        browser,
        clearTimeout() {},
        console: { error() {}, log() {}, warn() {} },
        Date,
        Error,
        Promise,
        URL,
        setTimeout: () => 0,
        WebSocket: class {
            static CONNECTING = 0;
            static OPEN = 1;
            send() {}
            close() {}
        },
    });
}

test("each background file loads as its own script, in manifest order", () => {
    const context = stubContext();
    for (const file of BACKGROUND_SCRIPT_FILES) {
        assert.doesNotThrow(
            () => vm.runInContext(extensionSource(file), context, { filename: file }),
            `${file} failed to load in manifest order`
        );
    }
});

test("the files before the last one declare without running anything", () => {
    // Only the final file may act while loading, because it is the only one
    // that can see every declaration. If an earlier file started work, it
    // would be reaching for functions that do not exist yet.
    const context = stubContext();
    for (const file of BACKGROUND_SCRIPT_FILES.slice(0, -1)) {
        vm.runInContext(extensionSource(file), context, { filename: file });
    }
    // Nothing above should have registered a listener or opened a socket; the
    // startup file does that.
    assert.equal(vm.runInContext("typeof handleRequest", context), "function");
    assert.equal(vm.runInContext("connections.size", context), 0);
});

test("naming a handler directly in the router would be caught", () => {
    // Proves the test above can fail. The router's tables wrap each handler in
    // an arrow so the name resolves when the action runs. Undo that, so the
    // tables name the functions directly, and loading in order has to throw:
    // the router loads before the files declaring most of those handlers.
    const files = BACKGROUND_SCRIPT_FILES.map((file) => {
        const source = extensionSource(file);
        if (file !== "background-router.js") return [file, source];
        const direct = source.replace(/\(params\) => (handle\w+)\(params\)/g, "$1");
        assert.notEqual(direct, source, "the router no longer defers its handlers behind arrows");
        return [file, direct];
    });

    const context = stubContext();
    assert.throws(
        () => {
            for (const [file, source] of files) {
                vm.runInContext(source, context, { filename: file });
            }
        },
        // Matched by name rather than by constructor: the error is built by the
        // vm realm, so it is not an instance of this realm's ReferenceError.
        (err) => err.name === "ReferenceError" && /handleTabsCreate/.test(err.message)
    );
});

test("concatenating the files hides that failure", () => {
    // The reason the test above has to load file by file. Same broken router,
    // but concatenated: every declaration hoists into one script, so the
    // reference resolves and nothing fails.
    const source = BACKGROUND_SCRIPT_FILES
        .map((file) => {
            const text = extensionSource(file);
            return file === "background-router.js"
                ? text.replace(/\(params\) => (handle\w+)\(params\)/g, "$1")
                : text;
        })
        .join("\n");

    assert.doesNotThrow(() => vm.runInContext(source, stubContext()));
});
