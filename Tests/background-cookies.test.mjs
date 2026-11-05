import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// The cookie store as the fake browser holds it. `getAll({domain})` answers the
// way the WebExtension API documents it, the domain or a subdomain of it, and
// `remove` takes a cookie by the URL it would be sent to and its name.
function loadBackground({ cookies = [], granted = [], getAll } = {}) {
    const store = cookies.map((cookie) => ({ path: "/", secure: false, httpOnly: false, storeId: "0", ...cookie }));
    const removals = [];
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        cookies: {
            getAll: getAll || (async ({ domain }) => store.filter((cookie) => {
                const host = cookie.domain.replace(/^\./, "");
                return host === domain || host.endsWith(`.${domain}`);
            })),
            remove: async (details) => {
                removals.push(details);
                const url = new URL(details.url);
                const index = store.findIndex((cookie) => cookie.name === details.name
                    && cookie.domain.replace(/^\./, "") === url.hostname
                    && cookie.path === url.pathname
                    && (url.protocol === "https:" || !cookie.secure));
                if (index < 0) return null;
                store.splice(index, 1);
                return { url: details.url, name: details.name, storeId: details.storeId };
            },
        },
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
            get: async () => { throw new Error("clear_cookies must not look up a tab"); },
            query: async () => { throw new Error("clear_cookies must not look up a tab"); },
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
        webNavigation: { getAllFrames: async () => [] },
        windows: {},
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
    for (const origin of granted) vm.runInContext(`grantedOrigins.add(${JSON.stringify(origin)})`, context);

    return {
        store,
        removals,
        request: (params) => vm.runInContext(
            `handleRequest(${JSON.stringify({ id: "r1", action: "clear_cookies", params })})`,
            context
        ),
    };
}

const data = (response) => JSON.parse(response.data);

test("clear_cookies removes the domain's cookies and its subdomains', HttpOnly and Secure included", async () => {
    const harness = loadBackground({
        granted: ["https://idp.example.com"],
        cookies: [
            { name: "session", domain: "idp.example.com", httpOnly: true, secure: true },
            { name: "remembered", domain: ".idp.example.com", path: "/realms/x" },
            { name: "sub", domain: "login.idp.example.com", secure: true },
            // A parent's cookie and an unrelated site's are not the caller's to remove.
            { name: "parent", domain: ".example.com" },
            { name: "other", domain: "other.example" },
            { name: "lookalike", domain: "notidp.example.com" },
        ],
    });

    const response = await harness.request({ domain: "idp.example.com" });

    assert.equal(response.success, true, response.error);
    assert.deepEqual(data(response), { removed: 3 });
    assert.deepEqual(harness.store.map((cookie) => cookie.name).sort(), ["lookalike", "other", "parent"]);
    assert.equal(response.resolvedTabId, null);
});

// Safari's `getAll` filter is not verified to match the documented one, so the
// match is held here too: a parent's cookie is never removed.
test("cookies outside the domain are left alone even when the store returns them", async () => {
    const all = ["idp.example.com", ".example.com", "other.example"]
        .map((domain, index) => ({ name: `c${index}`, domain, path: "/", secure: false }));
    const harness = loadBackground({ granted: ["https://idp.example.com"], getAll: async () => all });
    harness.store.push(...all);

    const response = await harness.request({ domain: "idp.example.com" });

    assert.deepEqual(data(response), { removed: 1 });
    assert.deepEqual(harness.removals.map((removal) => removal.name), ["c0"]);
});

test("each removal names the cookie by a URL it is sent to, keeping its store and partition", async () => {
    const partitionKey = { topLevelSite: "https://app.example" };
    const harness = loadBackground({
        granted: ["https://idp.example.com"],
        cookies: [
            { name: "s", domain: ".idp.example.com", path: "/auth", secure: true, storeId: "7" },
            { name: "p", domain: "idp.example.com", partitionKey },
        ],
    });

    await harness.request({ domain: "idp.example.com" });

    assert.deepEqual(JSON.parse(JSON.stringify(harness.removals)), [
        { url: "https://idp.example.com/auth", name: "s", storeId: "7" },
        { url: "http://idp.example.com/", name: "p", storeId: "0", partitionKey },
    ]);
});

test("a cookie that was already gone is not counted", async () => {
    const harness = loadBackground({
        granted: ["https://idp.example.com"],
        getAll: async () => [{ name: "ghost", domain: "idp.example.com", path: "/", secure: false }],
    });

    const response = await harness.request({ domain: "idp.example.com" });

    assert.deepEqual(data(response), { removed: 0 });
});

// Safari hands the cookies API nothing for a site it has not granted, which is
// indistinguishable from a site with no cookies. Said rather than hidden.
test("nothing found on a site never reached says access may be missing", async () => {
    const harness = loadBackground();

    const response = await harness.request({ domain: "idp.example.com" });

    assert.equal(response.success, true, response.error);
    const result = data(response);
    assert.equal(result.removed, 0);
    assert.equal(result.access, "not_granted");
    assert.match(result.accessHint, /MCPSafari button/);
});

test("nothing found on a reached site is a plain removed: 0", async () => {
    const harness = loadBackground({ granted: ["https://login.idp.example.com"] });

    const response = await harness.request({ domain: "idp.example.com" });

    assert.deepEqual(data(response), { removed: 0 });
});

test("a domain that is not a bare hostname is refused before the store is read", async () => {
    for (const domain of [undefined, "", "com", "https://idp.example.com", "idp.example.com/x", ".example.com", "*.example.com"]) {
        let read = false;
        const harness = loadBackground({ getAll: async () => { read = true; return []; } });

        const response = await harness.request({ domain });

        assert.equal(response.success, false, String(domain));
        assert.equal(response.errorCode, "invalid_input");
        assert.equal(read, false, `${domain} reached the cookie store`);
    }
});
