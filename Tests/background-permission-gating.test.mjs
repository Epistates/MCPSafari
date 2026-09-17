import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/background.js", import.meta.url),
    "utf8"
);

// Safari asks for website access with a modal dialog and blocks every extension
// API for the tab until it is answered, and that dialog can open behind another
// window. These drive the blocked case directly, because the difference between
// a 2-second named refusal and a 30-second `bridge_timeout` is the whole point.
function loadBackground({
    // A promise that never settles stands in for a call parked on the dialog.
    probe = async () => [{ result: true }],
    sendMessage = async () => ({ data: "ok", error: null }),
    captureVisibleTab = async () => "data:image/png;base64,AAAB",
    tabUrl = "https://blocked.example/some/page?q=1",
} = {}) {
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
                    : [{ result: { visible: true, hasFocus: true } }],
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            query: async () => [{ id: 1, active: true, windowId: 1 }],
            get: async (id) => ({ id, active: true, windowId: 1, url: tabUrl, title: "T" }),
            update: async () => {},
            captureVisibleTab,
            sendMessage,
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
        webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: tabUrl }] },
        windows: { update: async () => {} },
    };

    const context = vm.createContext({
        browser,
        clearTimeout: (id) => { const t = timers[id]; if (t) t.cancelled = true; },
        console: { error() {}, log() {}, warn() {} },
        Date,
        Promise,
        URL,
        Error,
        // Deadlines are driven explicitly by `fireDeadlines` so the tests do not
        // wait real seconds; short waits still run inline so handlers progress.
        setTimeout: (fn, ms) => {
            if ((ms || 0) <= 200) { queueMicrotask(fn); return -1; }
            timers.push({ fn, cancelled: false });
            return timers.length - 1;
        },
        WebSocket: class { send() {} },
    });
    vm.runInContext(source, context);

    return {
        call: (expression) => vm.runInContext(expression, context),
        pendingDeadlines: () => timers.filter((timer) => !timer.cancelled).length,
        fireDeadlines() {
            for (const timer of timers) {
                if (!timer.cancelled) { timer.cancelled = true; timer.fn(); }
            }
        },
    };
}

// A handler may run through several awaits before it reaches the call that
// parks, so the deadline does not exist yet when the test resumes. Wait for one
// to be registered rather than guessing how many ticks that takes.
async function fireWhenParked(harness) {
    for (let attempt = 0; attempt < 100 && harness.pendingDeadlines() === 0; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(harness.pendingDeadlines() > 0, "expected a deadline to be armed");
    harness.fireDeadlines();
}

// A promise that never settles, the way a call parked on Safari's dialog behaves.
const parked = () => new Promise(() => {});

async function rejection(promise) {
    try {
        await promise;
        return null;
    } catch (err) {
        return err;
    }
}

test("a probe parked on the permission dialog becomes a named refusal", async () => {
    const harness = loadBackground({ probe: parked });

    const pending = rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));
    await fireWhenParked(harness);
    const err = await pending;

    assert.equal(err.code, "permission_required");
    assert.equal(err.recoveryAction, "ask_user");
    // Retryable on purpose: granting access makes the identical call work.
    assert.equal(err.retryable, true);
    // The message has to carry the origin and the fact that the dialog hides,
    // because that is the part nobody works out on their own.
    assert.match(err.message, /https:\/\/blocked\.example/);
    assert.match(err.message, /behind another window/);
    assert.match(err.message, /Always Allow on This Website/);
    // The origin belongs in the message, not just the page path, so the user is
    // told which site they are being asked about.
    assert.doesNotMatch(err.message, /some\/page/);
});

test("a probe refused outright says access is missing, not that a dialog is open", async () => {
    const harness = loadBackground({
        probe: async () => { throw new Error("This extension does not have access to this tab"); },
    });

    const err = await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));

    assert.equal(err.code, "permission_required");
    assert.match(err.message, /is not allowed on/);
    // No dialog is open in this case, so pointing at one would send the user
    // hunting for a window that is not there.
    assert.doesNotMatch(err.message, /behind another window/);
    // The one click that stops being asked per site belongs in the refusal that
    // sends someone to settings anyway.
    assert.match(err.message, /Always Allow on Every Website/);
});

test("a granted tab is not probed again for every frame in one request", async () => {
    let probes = 0;
    const harness = loadBackground({
        probe: async () => { probes += 1; return [{ result: true }]; },
        sendMessage: async () => ({ data: "ok", error: null }),
    });

    await harness.call('sendToContentScript(1, { action: "read_page" })');
    await harness.call('sendToContentScript(1, { action: "read_page" })');
    await harness.call('sendToContentScript(1, { action: "read_page" })');

    assert.equal(probes, 1, "the probe should be cached for the life of a request");
});

test("a capture parked on the dialog fails fast instead of riding the bridge timeout", async () => {
    const harness = loadBackground({ captureVisibleTab: parked });

    const pending = rejection(harness.call("handleScreenshot({ tabId: 1 })"));
    await fireWhenParked(harness);
    const err = await pending;

    assert.equal(err.code, "permission_required");
    assert.match(err.message, /behind another window/);
});

test("a screenshot still works when the page context read fails", async () => {
    // The context read is allowed to fail and still produce a picture. A probe
    // in front of the capture would have turned that into a refusal.
    const harness = loadBackground({
        probe: async () => { throw new Error("must not be probed for a capture"); },
    });

    const capture = await harness.call("handleScreenshot({ tabId: 1 })");

    assert.equal(capture.image, "AAAB");
});

test("tab listing parked on the dialog reports why instead of timing out", async () => {
    const harness = loadBackground();
    harness.call("browser.tabs.query = () => new Promise(() => {})");

    const pending = rejection(harness.call("handleTabsQuery()"));
    await fireWhenParked(harness);
    const err = await pending;

    assert.equal(err.code, "permission_required");
    assert.equal(err.recoveryAction, "ask_user");
    // No single tab owns this block, so no origin is claimed.
    assert.doesNotMatch(err.message, /https:/);
});

test("an unreadable tab url still produces a usable refusal", async () => {
    const harness = loadBackground({ probe: parked, tabUrl: undefined });

    const pending = rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));
    await fireWhenParked(harness);
    const err = await pending;

    assert.equal(err.code, "permission_required");
    assert.match(err.message, /this tab/);
});
