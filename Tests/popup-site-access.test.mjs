import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const background = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/background.js", import.meta.url),
    "utf8"
);
const popup = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/popup.js", import.meta.url),
    "utf8"
);

// ─── background: what the popup is told ──────────────────────────────

function loadBackground({ probe, tabUrl = "https://example.com/a/page?q=1" }) {
    const timers = [];
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        scripting: {
            executeScript: async (options) =>
                options && options.func && options.func.name === "probeTabAccess"
                    ? probe(options)
                    : [{ result: true }],
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            query: async () => [{ id: 1, active: true, windowId: 1 }],
            get: async (id) => ({ id, active: true, windowId: 1, url: tabUrl, title: "T" }),
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
    };
    const context = vm.createContext({
        browser,
        clearTimeout: (id) => { const t = timers[id]; if (t) t.cancelled = true; },
        console: { error() {}, log() {}, warn() {} },
        Date, Promise, URL, Error,
        setTimeout: (fn, ms) => {
            if ((ms || 0) <= 200) { queueMicrotask(fn); return -1; }
            timers.push({ fn, cancelled: false });
            return timers.length - 1;
        },
        WebSocket: class { send() {} },
    });
    vm.runInContext(background, context);
    return {
        call: (expression) => vm.runInContext(expression, context),
        pending: () => timers.filter((t) => !t.cancelled).length,
        fire() { for (const t of timers) if (!t.cancelled) { t.cancelled = true; t.fn(); } },
    };
}

test("a reachable site reports the origin, without the path", async () => {
    const harness = loadBackground({ probe: async () => [{ result: true }] });

    const access = await harness.call("describeActiveTabAccess()");

    assert.equal(access.origin, "https://example.com");
    assert.equal(access.allowed, true);
    assert.equal(access.pending, false);
});

test("a site awaiting Safari's dialog is reported as asking, not as refused", async () => {
    const harness = loadBackground({ probe: () => new Promise(() => {}) });

    const running = harness.call("describeActiveTabAccess()");
    for (let i = 0; i < 100 && harness.pending() === 0; i += 1) {
        await new Promise((r) => setImmediate(r));
    }
    harness.fire();
    const access = await running;

    // The distinction is the whole point: "asking" resolves by itself once
    // someone finds the dialog, "refused" does not.
    assert.equal(access.allowed, false);
    assert.equal(access.pending, true);
    assert.equal(access.origin, "https://example.com");
});

test("a refused site is not reported as still asking", async () => {
    const harness = loadBackground({
        probe: async () => { throw new Error("no access"); },
    });

    const access = await harness.call("describeActiveTabAccess()");

    assert.equal(access.allowed, false);
    assert.equal(access.pending, false);
});

test("no active tab is survivable rather than an exception", async () => {
    const harness = loadBackground({ probe: async () => [{ result: true }] });
    harness.call("browser.tabs.query = async () => []");

    const access = await harness.call("describeActiveTabAccess()");

    assert.equal(access.origin, null);
    assert.equal(access.allowed, false);
});

// ─── popup: what the user reads ──────────────────────────────────────

function loadPopupMarkup() {
    // The module's top level touches the DOM, so only the pure renderer is
    // taken; everything below it needs a document to exist.
    const source = popup.slice(0, popup.indexOf("async function refreshSite"));
    const context = vm.createContext({});
    vm.runInContext(`${source}; globalThis.__render = siteAccessMarkup;`, context);
    return vm.runInContext("__render", context);
}

test("the popup names the host and its state", () => {
    const render = loadPopupMarkup();

    const allowed = render({ origin: "https://example.com", allowed: true, pending: false });
    assert.match(allowed, /example\.com/);
    assert.match(allowed, /Allowed/);
    // Nothing to do, so nothing is asked of the reader.
    assert.doesNotMatch(allowed, /site-hint/);

    const asking = render({ origin: "https://example.com", allowed: false, pending: true });
    assert.match(asking, /Asking/);
    assert.match(asking, /behind another window/);

    const blocked = render({ origin: "https://example.com", allowed: false, pending: false });
    assert.match(blocked, /No access/);
    assert.match(blocked, /Safari Settings/);
    // The reassurance belongs exactly here, where someone is deciding whether
    // to widen access.
    assert.match(blocked, /runs on this Mac/i);
});

test("a host with no origin renders nothing at all", () => {
    const render = loadPopupMarkup();

    assert.equal(render({ origin: null, allowed: false }), "");
    assert.equal(render(null), "");
});

test("a hostile host string cannot inject markup", () => {
    const render = loadPopupMarkup();

    const markup = render({
        origin: 'https://evil"><img src=x onerror=alert(1)>',
        allowed: true,
    });

    assert.doesNotMatch(markup, /<img/);
    assert.match(markup, /&lt;img/);
});
