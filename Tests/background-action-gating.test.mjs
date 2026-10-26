import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// Safari parks every extension call that touches a page on a permission dialog
// until it is answered, and the dialog can sit behind another window. An action
// that reaches the page without first asking `ensureTabAccess` therefore rides
// the server's 30-second bridge timeout instead of reporting
// `permission_required`, which is the one error that tells the user what to do.
//
// Gating was added action by action, so a new action, or one reached through a
// different path, could miss it without any test noticing. This enumerates what
// the router can dispatch and holds every one of them to the rule.

// What reaching a page looks like to the fake browser. A refused action must
// have made none of these calls.
const PAGE_TOUCHING_CALLS = [
    "scripting.executeScript",
    "tabs.sendMessage",
    "tabs.captureVisibleTab",
    "tabs.update",
    "tabs.reload",
    "windows.update",
];

function loadBackground() {
    const touched = [];
    const touch = (name, result) => async () => {
        touched.push(name);
        return result;
    };

    const tab = { id: 1, active: true, windowId: 1, url: "https://blocked.example/page", title: "T" };
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        scripting: {
            executeScript: async (options) => {
                // The probe is refused outright, the way an ungranted origin is.
                if (options && options.func && options.func.name === "probeTabAccess") {
                    throw new Error("This extension does not have access to this tab");
                }
                touched.push("scripting.executeScript");
                return [{ result: true }];
            },
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            get: async () => tab,
            query: async () => [tab],
            create: async () => ({ id: 2, url: "https://new.example/", title: "" }),
            remove: async () => {},
            sendMessage: touch("tabs.sendMessage", { data: "ok", error: null }),
            captureVisibleTab: touch("tabs.captureVisibleTab", "data:image/png;base64,AAAB"),
            update: touch("tabs.update"),
            reload: touch("tabs.reload"),
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
        webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: tab.url }] },
        windows: { update: touch("windows.update") },
    };

    const context = vm.createContext({
        browser,
        clearTimeout() {},
        console: { error() {}, log() {}, warn() {} },
        Date,
        Error,
        Promise,
        URL,
        setTimeout: (callback, ms) => { if ((ms || 0) <= 400) queueMicrotask(callback); return 0; },
        WebSocket: class { send() {} },
    });
    vm.runInContext(source, context);
    // `reload` and `goto` wait for a load event this fake never fires.
    vm.runInContext("waitForTabLoad = async (tabId) => browser.tabs.get(tabId)", context);

    return {
        touched,
        evaluate: (expression) => vm.runInContext(expression, context),
        request: (action, params) => vm.runInContext(
            `handleRequest(${JSON.stringify({ id: "r1", action, params: { tabId: 1, ...params } })})`,
            context
        ),
    };
}

// Every action the router can dispatch, read from its own tables so a new one
// shows up here without anyone remembering to add it.
function allActions() {
    const { evaluate } = loadBackground();
    return [
        ...evaluate("[...BACKGROUND_HANDLERS.keys()]"),
        ...evaluate("[...CONTENT_ACTIONS]"),
        ...evaluate("[...CONTENT_PROXIES.keys()]"),
    ];
}

// Arguments an action needs to get as far as its gate. Nothing here is checked
// beyond that: the point is only that the gate comes first.
const PARAMS = {
    tabs_create: { url: "https://new.example/" },
    javascript_tool: { code: "1 + 1" },
    resize_window: { width: 800, height: 600 },
    find: { text: "Pay" },
    click: { selector: "#go" },
    type_text: { selector: "#q", text: "x" },
    form_input: { fields: { "#q": "x" } },
    select_option: { selector: "#s", value: "a" },
    wait: { selector: "#late" },
    upload_file: { selector: "#f", files: [] },
    drop_file: { selector: "#f", files: [] },
    drag: { fromSelector: "#a", toSelector: "#b" },
    handle_dialog: { action: "accept" },
    native_type_text: { selector: "#q", text: "x" },
    native_press_key: { key: "a" },
    native_pointer: { x: 10, y: 10 },
    press_key: { key: "a" },
    hover: { selector: "#h" },
    scroll: { direction: "down" },
};

// Actions that are deliberately not gated, with the reason. Each is asserted to
// still work when the page is refused, so an entry here cannot quietly outlive
// its reason or hide a gate that was added later.
const UNGATED = new Map([
    ["tabs_query", "lists tabs from the tabs API and is deadlined on its own; it is the call every session starts with"],
    ["tabs_create", "opens a new tab, a browser operation that needs no access to any page"],
    ["tabs_close", "closes a tab by id, a browser operation that needs no access to the page being closed"],
    ["select_tab", "pins a tab id and brings it forward, which is bookkeeping; the first call that reads the page is gated"],
]);

// `navigate` is two things. Going to a URL and reloading go through the tabs API
// and are how a caller leaves a page they cannot use, so they stay open. Going
// back or forward is a script run inside the page, so it is gated.
const NAVIGATE_UNGATED = ["goto", "reload"];
const NAVIGATE_GATED = ["back", "forward"];

const GATED = allActions().filter((action) => !UNGATED.has(action) && action !== "navigate");

for (const action of GATED) {
    test(`${action} on an ungranted tab reports permission_required without touching the page`, async () => {
        const harness = loadBackground();

        const response = await harness.request(action, PARAMS[action] ?? {});

        assert.equal(response.success, false, `${action} should have been refused`);
        assert.equal(response.errorCode, "permission_required");
        assert.equal(response.recoveryAction, "ask_user");
        assert.deepEqual(
            harness.touched.filter((call) => PAGE_TOUCHING_CALLS.includes(call)),
            [],
            `${action} reached the page before asking for access`
        );
    });
}

for (const navigation of NAVIGATE_GATED) {
    test(`navigate ${navigation} on an ungranted tab reports permission_required without touching the page`, async () => {
        const harness = loadBackground();

        const response = await harness.request("navigate", { action: navigation });

        assert.equal(response.success, false);
        assert.equal(response.errorCode, "permission_required");
        assert.deepEqual(harness.touched.filter((call) => PAGE_TOUCHING_CALLS.includes(call)), []);
    });
}

for (const [action, reason] of UNGATED) {
    test(`${action} stays available on an ungranted tab: ${reason}`, async () => {
        const harness = loadBackground();

        const response = await harness.request(action, PARAMS[action] ?? {});

        assert.equal(response.success, true, response.error);
    });
}

for (const navigation of NAVIGATE_UNGATED) {
    test(`navigate ${navigation} stays available on an ungranted tab so a caller can leave the page`, async () => {
        const harness = loadBackground();

        const response = await harness.request("navigate", { action: navigation, url: "https://elsewhere.example/" });

        assert.equal(response.success, true, response.error);
    });
}

test("the router's tables are fully classified", () => {
    const actions = allActions();
    const classified = new Set([...GATED, ...UNGATED.keys(), "navigate"]);

    // Guards the guard: a table that stopped being read would leave the loops
    // above with nothing to iterate and everything passing.
    assert.ok(actions.length >= 30, `only ${actions.length} actions found`);
    for (const action of actions) assert.ok(classified.has(action), `${action} is unclassified`);
    for (const action of UNGATED.keys()) assert.ok(actions.includes(action), `${action} is not an action`);
});
