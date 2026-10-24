import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// Safari returns a URL and title for every tab, granted site or not. These pin
// down what the extension says about a tab, given what it has learned about the
// site: reached (granted), refused, or never touched (unknown).
const TABS = [
    { id: 1, windowId: 1, index: 0, active: true, pinned: true, url: "https://granted.example/inbox?token=abc123", title: "Inbox (3)" },
    { id: 2, windowId: 1, index: 1, active: false, url: "https://untouched.example/account", title: "Your account" },
    { id: 3, windowId: 2, index: 0, active: true, url: "https://refused.example/", title: "Refused site" },
    { id: 4, windowId: 2, index: 1, active: false, url: "about:blank", title: "" },
    { id: 5, windowId: 2, index: 2, active: false, title: "Restored, not loaded" },
    { id: 6, windowId: 2, index: 3, active: false, url: "file:///Users/someone/secret.txt", title: "secret.txt" },
];

function loadBackground({ sessionStore = {} } = {}) {
    const calls = { scripting: 0, permissionsContains: 0 };
    const stored = { ...sessionStore };
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        permissions: {
            // Answers yes for everything, as Safari does for an origin the
            // manifest asks for: it says nothing about a grant.
            contains: async () => { calls.permissionsContains += 1; return true; },
        },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        scripting: {
            executeScript: async ({ target }) => {
                calls.scripting += 1;
                const tab = TABS.find((candidate) => candidate.id === target.tabId);
                if (tab && tab.url && tab.url.startsWith("https://refused.example")) {
                    throw new Error("This extension does not have access to this tab");
                }
                return [{ result: true }];
            },
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: {
                get: async (key) => (key in stored ? { [key]: stored[key] } : {}),
                set: (values) => { Object.assign(stored, values); },
                remove: async () => {},
            },
        },
        tabs: {
            query: async () => TABS,
            get: async (id) => TABS.find((tab) => tab.id === id),
            create: async ({ url }) => ({ id: 9, url, title: "Opened page" }),
            update: async () => {},
            reload: async () => {},
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
        windows: { update: async () => {} },
    };

    const context = vm.createContext({
        browser,
        clearTimeout() {},
        console: { error() {}, log() {}, warn() {} },
        Date,
        Error,
        Promise,
        URL,
        setTimeout: () => 0,
        WebSocket: class { send() {} },
    });
    vm.runInContext(source, context);

    return {
        calls,
        stored,
        evaluate: (expression) => vm.runInContext(expression, context),
    };
}

async function listing(harness) {
    const tabs = await harness.evaluate("handleTabsQuery()");
    return new Map(tabs.map((tab) => [tab.id, { ...tab }]));
}

test("a tab on a reached site is described in full, with its secrets still redacted", async () => {
    const harness = loadBackground();
    await harness.evaluate("ensureTabAccess(1)");

    const tabs = await listing(harness);

    assert.deepEqual(tabs.get(1), {
        id: 1,
        url: "https://granted.example/inbox?token=[redacted]",
        title: "Inbox (3)",
        active: true,
        pinned: true,
        audible: false,
        muted: false,
        status: "complete",
        windowId: 1,
        index: 0,
        access: "granted",
    });
});

test("a tab on a site nothing has reached keeps its entry but loses its URL and title", async () => {
    const harness = loadBackground();
    await harness.evaluate("ensureTabAccess(1)");

    const tab = (await listing(harness)).get(2);

    // The handle, window, position and state stay, so the tab is still usable.
    assert.equal(tab.id, 2);
    assert.equal(tab.windowId, 1);
    assert.equal(tab.index, 1);
    assert.equal(tab.active, false);
    assert.equal(tab.status, "complete");
    assert.equal("url" in tab, false);
    assert.equal("title" in tab, false);
    assert.equal(tab.access, "not_granted");
    assert.match(tab.accessHint, /MCPSafari button in Safari's toolbar/);
    assert.doesNotMatch(JSON.stringify(tab), /untouched\.example|Your account/);
});

test("a site that refused access is not described either, and a refusal revokes what was learned", async () => {
    const harness = loadBackground();
    await assert.rejects(harness.evaluate("ensureTabAccess(3)"), (error) => error.code === "permission_required");

    const tab = (await listing(harness)).get(3);
    assert.equal(tab.access, "not_granted");
    assert.equal("url" in tab || "title" in tab, false);

    // Reached once, then no longer: the earlier answer must not outlive it.
    const revoked = loadBackground();
    revoked.evaluate("grantedOrigins.add('https://refused.example')");
    assert.equal((await listing(revoked)).get(3).access, "granted");
    revoked.evaluate("tabAccessProbes.clear()");
    await assert.rejects(revoked.evaluate("ensureTabAccess(3)"));
    assert.equal((await listing(revoked)).get(3).access, "not_granted");
});

test("tabs with no origin to grant are not mistaken for granted ones", async () => {
    const harness = loadBackground();

    const tabs = await listing(harness);

    // A blank page has nothing to protect and nothing to grant.
    assert.equal(tabs.get(4).url, "about:blank");
    assert.equal(tabs.get(4).access, "granted");
    // A file URL names the user's filesystem, and an unloaded tab has no URL.
    assert.equal(tabs.get(5).access, "not_granted");
    assert.equal(tabs.get(6).access, "not_granted");
    assert.equal("url" in tabs.get(6), false);
});

test("listing tabs never probes a site, so it cannot raise a dialog", async () => {
    const harness = loadBackground();

    await listing(harness);

    assert.equal(harness.calls.scripting, 0);
});

test("permissions.contains is not taken as a grant", async () => {
    const harness = loadBackground();

    const tabs = await listing(harness);

    // It answers true for every site here, as it does on Safari for an origin the
    // manifest merely requests. Believing it would withhold nothing.
    assert.equal(tabs.get(2).access, "not_granted");
    assert.equal(harness.calls.permissionsContains, 0);
});

test("what was learned survives the background page being suspended", async () => {
    const first = loadBackground();
    await first.evaluate("ensureTabAccess(1)");
    assert.deepEqual([...first.stored.grantedOrigins], ["https://granted.example"]);

    const resumed = loadBackground({ sessionStore: { grantedOrigins: first.stored.grantedOrigins } });
    await resumed.evaluate("restoreSessionState()");

    assert.equal((await listing(resumed)).get(1).access, "granted");
});

test("tabs_create reports the URL it was given but withholds the title of an unreached site", async () => {
    const harness = loadBackground();

    const unreached = await harness.evaluate('handleTabsCreate({ url: "https://untouched.example/new" })');
    assert.equal(unreached.url, "https://untouched.example/new");
    assert.equal("title" in unreached, false);
    assert.equal(unreached.access, "not_granted");

    await harness.evaluate("ensureTabAccess(1)");
    const reached = await harness.evaluate('handleTabsCreate({ url: "https://granted.example/new" })');
    assert.equal(reached.title, "Opened page");
    assert.equal(reached.access, "granted");
});

test("navigate reports a title only for a site that has been reached", async () => {
    const harness = loadBackground();
    harness.evaluate("waitForTabLoad = async (tabId) => browser.tabs.get(tabId)");

    const unreached = await harness.evaluate('handleNavigate({ tabId: 2, action: "reload" })');
    assert.match(unreached, /^Reloaded https:\/\/untouched\.example\/account \(title withheld/);
    assert.doesNotMatch(unreached, /Your account/);

    await harness.evaluate("ensureTabAccess(1)");
    const reached = await harness.evaluate('handleNavigate({ tabId: 1, action: "reload" })');
    assert.equal(reached, "Reloaded https://granted.example/inbox?token=[redacted] (Inbox (3))");
});
