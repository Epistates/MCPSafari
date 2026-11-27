import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

// A site counts as granted only once a call has reached it, so a tab opened on a
// site the user allowed long ago came back "not_granted", without its title, and
// agents stopped to ask for access the user had already given (#169). The caller
// opened the tab to use it, so tabs_create asks Safari then: the answer is the
// one their next call would get.

const source = backgroundScriptSource();

/// A page whose Safari has allowed the origins in `allowed` and no others.
function loadBackground({ allowed = [] } = {}) {
    const probes = [];
    const tabs = new Map();
    let nextId = 40;
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        scripting: {
            executeScript: async ({ target }) => {
                const tab = tabs.get(target.tabId);
                probes.push(tab?.url);
                if (!tab || !allowed.includes(new URL(tab.url).origin)) {
                    throw new Error("This extension does not have access to this tab");
                }
                return [{ result: true }];
            },
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            create: async ({ url }) => {
                const tab = { id: nextId++, windowId: 1, url: url ?? "", title: url ? "Opened page" : "", status: "complete" };
                tabs.set(tab.id, tab);
                return tab;
            },
            get: async (id) => {
                if (!tabs.has(id)) throw new Error(`No tab with id: ${id}`);
                return tabs.get(id);
            },
            query: async () => [...tabs.values()],
            update: async () => {},
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
        windows: { update: async () => {}, getLastFocused: async () => ({ id: 1 }) },
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
    // The load itself is not under test: the tab is complete as created.
    vm.runInContext("waitForTabLoad = async (tabId) => browser.tabs.get(tabId)", context);
    return {
        probes,
        create: (params) => vm.runInContext(`handleTabsCreate(${JSON.stringify(params)})`, context),
        listed: async (id) => (await vm.runInContext("handleTabsQuery()", context)).find((tab) => tab.id === id),
    };
}

test("a tab opened on a site the user allowed, that nothing had reached yet, is reported granted with its title", async () => {
    const harness = loadBackground({ allowed: ["https://allowed.example"] });

    const created = await harness.create({ url: "https://allowed.example/inbox" });

    assert.equal(created.access, "granted");
    assert.equal(created.title, "Opened page");
    assert.equal("accessHint" in created, false);
    // Learned for good, so the next listing describes the tab too.
    assert.equal((await harness.listed(created.id)).access, "granted");
});

test("a tab opened on a site the user hasn't allowed is still created, and reported not granted", async () => {
    const harness = loadBackground();

    const created = await harness.create({ url: "https://elsewhere.example/" });

    assert.equal(typeof created.id, "number");
    assert.equal(created.url, "https://elsewhere.example/");
    assert.equal(created.access, "not_granted");
    assert.equal("title" in created, false);
    assert.match(created.accessHint, /permission_required/);
});

test("a site already reached isn't asked about again", async () => {
    const harness = loadBackground({ allowed: ["https://allowed.example"] });
    await harness.create({ url: "https://allowed.example/one" });
    const asked = harness.probes.length;

    const second = await harness.create({ url: "https://allowed.example/two" });

    assert.equal(second.access, "granted");
    assert.equal(harness.probes.length, asked);
});

test("a tab opened with no URL, or on one with no site to allow, isn't asked about", async () => {
    const harness = loadBackground({ allowed: ["https://allowed.example"] });

    await harness.create({});
    await harness.create({ url: "data:text/plain,hello" });

    assert.deepEqual(harness.probes, []);
});
