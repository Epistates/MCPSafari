import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { backgroundScriptSource, contentScriptSource } from "./helpers/extension-sources.mjs";

const contentSource = contentScriptSource();
const backgroundSource = backgroundScriptSource();

function contentHarness(document = {
    activeElement: null,
    body: { innerText: "" },
    createTreeWalker: () => ({ nextNode: () => null }),
    elementFromPoint: () => null,
    querySelector: () => null,
    // Shadow-root discovery asks every root for its elements.
    querySelectorAll: () => [],
}) {
    let listener;
    const context = vm.createContext({
        browser: {
            runtime: {
                onMessage: { addListener: (value) => { listener = value; } },
            },
        },
        document,
        setTimeout,
        clearTimeout,
        window: {},
    });
    vm.runInContext(contentSource, context);

    return (action, params) => new Promise((resolve) => {
        listener({ action, params }, {}, resolve);
    });
}

// `listening` is whether the tab has a content script yet. `silence` is how the
// browser reports a message nobody is listening for: Safari resolves undefined,
// other engines throw the no-receiver error. Injecting the content script makes
// the tab listen, unless `injectionTakes` is false.
function backgroundHarness(contentResponse, { listening = true, silence = "undefined", injectionTakes = true } = {}) {
    const contentResponses = Array.isArray(contentResponse)
        ? [...contentResponse]
        : [contentResponse];
    const tabUpdates = [];
    const windowUpdates = [];
    // What the content script was asked, not counting pings, which are counted
    // on their own.
    const sends = [];
    const pings = [];
    const injections = [];
    const nobodyListening = () => {
        if (silence === "throw") throw new Error("Could not establish connection. Receiving end does not exist.");
        return undefined;
    };
    const browser = {
        alarms: {
            create() {},
            onAlarm: { addListener() {} },
        },
        runtime: {
            getManifest: () => ({ version: "0.2.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            get: async () => ({ id: 1, windowId: 7 }),
            query: async () => [{ id: 1, active: true, windowId: 7 }],
            // An Error in the list is thrown, as the browser does for a message
            // that never reached a page; undefined is a reply that never came.
            sendMessage: async (tabId, message) => {
                if (message.action === "ping") {
                    pings.push(message.frameId);
                    return listening ? { data: { ready: true }, error: null } : nobodyListening();
                }
                sends.push(message.action);
                if (!listening) return nobodyListening();
                const next = contentResponses.shift();
                if (next instanceof Error) throw next;
                return next;
            },
            update: async (...args) => { tabUpdates.push(args); },
            // Both listeners are registered at load: the access probe cache is
            // cleared when a tab closes and when it navigates, since Safari
            // grants per origin.
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
        windows: {
            update: async (...args) => { windowUpdates.push(args); },
        },
        scripting: {
            executeScript: async (options) => {
                if (!options.files) return;
                injections.push(options.files);
                if (injectionTakes && options.files.includes("content.js")) listening = true;
            },
        },
    };
    const context = vm.createContext({
        browser,
        console: { error() {}, log() {}, warn() {} },
        Promise,
        // Short waits run inline so the handlers progress; the permission
        // deadline must not, or every gated call fails as though it stalled.
        setTimeout: (callback, ms) => { if ((ms || 0) <= 200) callback(); return 0; },
        clearTimeout() {},
        WebSocket: class { static OPEN = 1; static CONNECTING = 0; },
    });
    vm.runInContext(backgroundSource, context);
    const handleRequest = (request) => vm.runInContext(
        `handleRequest(${JSON.stringify(request)})`,
        context
    );
    handleRequest.tabUpdates = tabUpdates;
    handleRequest.windowUpdates = windowUpdates;
    handleRequest.evaluate = (source) => vm.runInContext(source, context);
    handleRequest.sends = sends;
    handleRequest.pings = pings;
    handleRequest.injections = injections;
    return handleRequest;
}

test("content errors identify stale UIDs and missing targets", async () => {
    const call = contentHarness();

    const stale = await call("click", { uid: "e999" });
    assert.equal(stale.errorCode, "stale_uid");
    assert.equal(stale.retryable, false);
    assert.equal(stale.recoveryAction, "take_snapshot");

    const missing = await call("click", { selector: "#missing" });
    assert.equal(missing.errorCode, "target_not_found");
    assert.equal(missing.retryable, false);
    assert.equal(missing.recoveryAction, "take_snapshot");
});

test("wait timeouts are retryable", async () => {
    const response = await contentHarness()("wait", {
        selector: "#later",
        timeout: 0.001,
    });

    assert.equal(response.errorCode, "wait_timeout");
    assert.equal(response.retryable, true);
    assert.equal(response.recoveryAction, "retry");
});

test("background preserves content error metadata in bridge responses", async () => {
    const handleRequest = backgroundHarness({
        data: null,
        error: "UID expired",
        errorCode: "stale_uid",
        retryable: false,
        recoveryAction: "take_snapshot",
    });

    const response = await handleRequest({
        id: "request-1",
        action: "click",
        params: { tabId: 1, uid: "e999" },
    });

    assert.equal(response.success, false);
    assert.equal(response.errorCode, "stale_uid");
    assert.equal(response.retryable, false);
    assert.equal(response.recoveryAction, "take_snapshot");
});

test("background injects the content script and sends again when the browser says nothing is listening", async () => {
    // The call never reached a page, so sending it again cannot repeat anything.
    const handleRequest = backgroundHarness([
        new Error("Could not establish connection. Receiving end does not exist."),
        { data: "Hovered <button>", error: null },
    ]);

    const response = await handleRequest({
        id: "request-1",
        action: "hover",
        params: { tabId: 1, selector: "button" },
    });

    assert.equal(response.success, true);
    assert.equal(response.data, "Hovered <button>");
    assert.deepEqual(handleRequest.sends, ["hover", "hover"]);
    assert.equal(handleRequest.injections.length, 2, "the main-world interceptors and the content script");
});

test("a reply that never came is reported, and the call is not sent again", async () => {
    // Safari answers undefined when the document goes away before it replies,
    // which is what a click that navigates looks like. The click has run, so
    // injecting and sending it again clicked twice: a pagination "Next" went two
    // pages on, and a uid click then failed on the new document. The actions
    // that wait out a navigation are covered in the interaction tests.
    for (const action of ["hover", "scroll", "drag", "upload_file"]) {
        // A content script is there (it answers the ping), and drops the reply.
        const handleRequest = backgroundHarness([undefined, {
            data: "done",
            error: null,
        }]);

        const response = await handleRequest({
            id: "request-1",
            action,
            params: { tabId: 1, uid: "f0e12" },
        });

        assert.equal(response.success, false, action);
        assert.equal(response.errorCode, "reply_lost", action);
        assert.equal(response.retryable, false, action);
        assert.match(response.error, /not sent again/, action);
        assert.deepEqual(handleRequest.sends, [action], `${action} was sent a second time`);
        assert.equal(handleRequest.injections.length, 0, `${action} re-injected the content script`);
    }
});

// ─── A tab with no content script ────────────────────────────────────

// Safari's tabs.sendMessage does not throw when nothing is listening: it
// resolves undefined, the same as when the document goes away before replying.
// Telling them apart after the fact is guesswork, so an action that must not run
// twice asks with a ping first.

for (const [how, options] of [
    ["Safari resolves undefined", { silence: "undefined" }],
    ["another engine throws the no-receiver error", { silence: "throw" }],
]) {
    test(`an action on a tab with no content script injects it and is delivered once (${how})`, async () => {
        for (const action of ["hover", "scroll", "drag", "upload_file"]) {
            const handleRequest = backgroundHarness([{ data: "done", error: null }], { listening: false, ...options });

            const response = await handleRequest({
                id: "request-1",
                action,
                params: { tabId: 1, uid: "f0e12" },
            });

            assert.equal(response.success, true, `${action}: ${response.error}`);
            assert.equal(response.data, "done", action);
            assert.deepEqual(handleRequest.sends, [action], `${action} was delivered other than once`);
            assert.equal(handleRequest.injections.length, 2, `${action}: the interceptors and the content script`);
            assert.equal(handleRequest.pings.length, 2, `${action}: asked before and after injecting`);
        }
    });
}

test("a tab that still has no content script after injection fails without the action being sent", async () => {
    const handleRequest = backgroundHarness([{ data: "done", error: null }], { listening: false, injectionTakes: false });

    const response = await handleRequest({ id: "request-1", action: "hover", params: { tabId: 1, uid: "f0e12" } });

    assert.equal(response.success, false);
    assert.match(response.error, /did not respond after injection/);
    assert.deepEqual(handleRequest.sends, [], "the action was sent to a page that could not take it");
});

test("a tab that has the content script is not injected into for an action that must not repeat", async () => {
    const handleRequest = backgroundHarness([{ data: "done", error: null }]);

    await handleRequest({ id: "request-1", action: "hover", params: { tabId: 1, uid: "f0e12" } });

    assert.equal(handleRequest.injections.length, 0);
    assert.equal(handleRequest.pings.length, 1);
});

test("an action that is safe to repeat recovers from a lost reply by injecting, with no ping", async () => {
    for (const action of ["snapshot", "read_page", "find", "get_page_text"]) {
        const handleRequest = backgroundHarness([undefined, { data: "done", error: null }]);

        const response = await handleRequest({ id: "request-1", action, params: { tabId: 1, uid: "f0e12" } });

        assert.equal(response.success, true, `${action}: ${response.error}`);
        assert.deepEqual(handleRequest.sends, [action, action], action);
        assert.equal(handleRequest.injections.length, 2, action);
        assert.equal(handleRequest.pings.length, 0, `${action} pinged before a send it can repeat`);
    }
});

test("only actions that change nothing are sent a second time", () => {
    const handleRequest = backgroundHarness([]);
    const repeatable = (action, params = {}) =>
        handleRequest.evaluate(`isRepeatSafe(${JSON.stringify({ action, params })})`);

    for (const action of [
        "read_page", "get_page_text", "snapshot", "find", "element_rect", "native_pointer_points",
        "prepare_native_input", "prepare_native_key", "wait", "get_console_messages", "get_network_requests", "ping",
    ]) {
        assert.equal(repeatable(action), true, action);
    }
    for (const action of [
        "click", "type_text", "form_input", "select_option", "scroll", "press_key", "hover", "drag",
        "upload_file", "drop_file", "start_trace", "stop_trace", "handle_dialog",
    ]) {
        assert.equal(repeatable(action), false, action);
    }
    assert.equal(repeatable("get_console_messages", { clear: true }), false);
    assert.equal(repeatable("get_network_requests", { clearIds: [1] }), false);
});

test("a read that clears what it read is not repeated", async () => {
    // A second read would answer with whatever the first had not already taken.
    for (const [action, params] of [
        ["read_console", { clear: true }],
        ["read_network", { clear: true }],
    ]) {
        const handleRequest = backgroundHarness([undefined, { data: [], error: null }]);

        const response = await handleRequest({ id: "request-1", action, params: { tabId: 1, ...params } });

        assert.equal(response.errorCode, "reply_lost", action);
        assert.equal(handleRequest.sends.length, 1, `${action} was sent a second time`);
    }
});

test("the content script answers a ping", async () => {
    const reply = await contentHarness()("ping", {});

    assert.deepEqual({ ...reply.data }, { ready: true });
    assert.equal(reply.error, null);
});

test("a reply that is lost after an injection is reported the same way", async () => {
    // The first send never arrived, so the injection was right. The second one
    // did arrive, and what happened to it is as unknown as anywhere else.
    const handleRequest = backgroundHarness([
        new Error("Could not establish connection. Receiving end does not exist."),
        undefined,
        { data: "Hovered <button>", error: null },
    ]);

    const response = await handleRequest({
        id: "request-1",
        action: "hover",
        params: { tabId: 1, selector: "button" },
    });

    assert.equal(response.errorCode, "reply_lost");
    assert.deepEqual(handleRequest.sends, ["hover", "hover"]);
});

test("native input preparation focuses only editable text targets", async () => {
    const document = { activeElement: null, hasFocus: () => true };
    const editor = {
        contains: (element) => element === editor,
        disabled: false,
        focus: () => { document.activeElement = editor; },
        isContentEditable: true,
        readOnly: false,
        scrollIntoView() {},
        tagName: "DIV",
    };
    document.querySelector = () => editor;
    const call = contentHarness(document);

    const focused = await call("prepare_native_input", { selector: "#editor" });
    assert.equal(focused.error, null);
    assert.equal(focused.data, "Focused <div> for native typing");

    document.querySelector = () => ({
        disabled: false,
        isContentEditable: false,
        readOnly: false,
        tagName: "BUTTON",
    });
    const unsupported = await call("prepare_native_input", { selector: "button" });
    assert.equal(unsupported.errorCode, "unsupported_native_target");
    assert.equal(unsupported.recoveryAction, "use_synthetic_input");
});

// With Safari's address bar or find bar focused, the page's `activeElement`
// still names the element it last focused, so that check passes while the
// keyboard is somewhere else entirely and the server types into the bar.
test("native typing refuses when the page does not hold focus", async () => {
    const document = { activeElement: null, hasFocus: () => false };
    const editor = {
        contains: (element) => element === editor,
        disabled: false,
        focus: () => { document.activeElement = editor; },
        isContentEditable: true,
        readOnly: false,
        scrollIntoView() {},
        tagName: "INPUT",
    };
    document.querySelector = () => editor;
    const call = contentHarness(document);

    const refused = await call("prepare_native_input", { selector: "#editor", clearFirst: true });

    assert.equal(refused.data, null);
    assert.equal(refused.errorCode, "native_input_focus_failed");
    assert.equal(refused.retryable, true);
    assert.equal(refused.recoveryAction, "retry");
    assert.match(refused.error, /address bar/);

    // The same page, once it holds focus, is accepted.
    document.hasFocus = () => true;
    const accepted = await call("prepare_native_input", { selector: "#editor" });
    assert.equal(accepted.error, null);
});

test("a native key refuses when focus cannot be pulled into the page", async () => {
    const body = { setAttribute() {}, focus() {} };
    const document = { activeElement: null, body, hasFocus: () => false };
    const call = contentHarness(document);

    const refused = await call("prepare_native_key", {});

    assert.equal(refused.errorCode, "native_input_focus_failed");

    // Pulling focus in, which is what the call exists to do, still counts.
    body.focus = () => { document.hasFocus = () => true; };
    document.hasFocus = () => false;
    const pulled = await call("prepare_native_key", {});
    assert.equal(pulled.error, null);
    assert.equal(pulled.data, "Page ready for native key");
});

test("native input preparation foregrounds the target Safari tab", async () => {
    const handleRequest = backgroundHarness({ data: "Focused", error: null });
    const response = await handleRequest({
        id: "request-1",
        action: "native_type_text",
        params: { tabId: 1, selector: "#editor", text: "/hello" },
    });

    assert.equal(response.success, true);
    assert.equal(response.data, "Safari is ready for native input");
    assert.equal(handleRequest.tabUpdates.length, 1);
    assert.equal(handleRequest.tabUpdates[0][0], 1);
    assert.equal(handleRequest.tabUpdates[0][1].active, true);
    assert.equal(handleRequest.windowUpdates.length, 1);
    assert.equal(handleRequest.windowUpdates[0][0], 7);
    assert.equal(handleRequest.windowUpdates[0][1].focused, true);
});

test("resize_window uses the tab it was given rather than the current window", async () => {
    const handleRequest = backgroundHarness({ data: null, error: null });

    const response = await handleRequest({
        id: "r1",
        action: "resize_window",
        params: { tabId: 1, width: 900, height: 700 },
    });

    assert.equal(response.success, true);
    // windowId 7 is the one `tabs.get` reports for the named tab. Reading
    // `tabs.query({ currentWindow: true })` instead resizes whichever window
    // the user happens to be looking at, which on a two-window setup is not
    // the one the agent is driving.
    const [windowId, size] = handleRequest.windowUpdates[0];
    assert.equal(windowId, 7);
    assert.equal(size.width, 900);
    assert.equal(size.height, 700);
});
