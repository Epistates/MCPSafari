import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// Safari asks for website access with a modal dialog and blocks every extension
// API for the tab until it is answered, and that dialog can open behind another
// window. These drive the blocked case directly, because the difference between
// a 2-second named refusal and a 30-second `bridge_timeout` is the whole point.
function loadBackground({
    // A promise that never settles stands in for a call parked on the dialog.
    probe = async () => [{ result: true }],
    sendMessage = async () => ({ data: "ok", error: null }),
    captureVisibleTab = async () => "data:image/png;base64,AAAB",
    pageContext = async () => [{ result: { visible: true, hasFocus: true } }],
    tabUrl = "https://blocked.example/some/page?q=1",
    // Safari parks `tabs.get` and `tabs.query` on the same dialog as everything
    // else. Modelling that is what the first version of these tests missed, and
    // it hid three separate failures that only real Safari showed.
    tabsBlocked = false,
    blockTabsAfterProbe = false,
} = {}) {
    const timers = [];
    const tabUpdatedListeners = [];
    let probeStarted = false;
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        scripting: {
            executeScript: async (options) => {
                if (options && options.func && options.func.name === "probeTabAccess") {
                    probeStarted = true;
                    return probe(options);
                }
                return pageContext(options);
            },
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            query: async () => {
                if (tabsBlocked) return new Promise(() => {});
                return [{ id: 1, active: true, windowId: 1 }];
            },
            get: async (id) => {
                if (tabsBlocked || (blockTabsAfterProbe && probeStarted)) {
                    return new Promise(() => {});
                }
                return { id, active: true, windowId: 1, url: tabUrl, title: "T" };
            },
            update: async () => {},
            captureVisibleTab,
            sendMessage,
            onUpdated: {
                addListener: (listener) => { tabUpdatedListeners.push(listener); },
                removeListener() {},
            },
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
        /// Drives `tabs.onUpdated`, which the extension listens to so a tab
        /// that navigates loses its cached access grant.
        navigateTab(tabId, url) {
            for (const listener of tabUpdatedListeners) listener(tabId, { url });
        },
        pendingDeadlines: () => timers.filter((timer) => !timer.cancelled).length,
        fireDeadlines() {
            for (const timer of timers) {
                if (!timer.cancelled) { timer.cancelled = true; timer.fn(); }
            }
        },
    };
}

// A handler arms several deadlines in sequence, not one: reading the origin has
// its own, then the probe has another. So this drains ticks and fires whatever
// is armed, repeatedly, until the operation settles. Firing once catches only
// the first deadline and leaves the handler parked on the next.
//
// Each pass yields with setImmediate before firing, which lets any call that was
// going to resolve on its own get there first. That ordering is what keeps a
// successful `tabs.get` from being cut short by its own deadline.
async function fireWhenParked(harness, settled) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (settled.done) return;
        await new Promise((resolve) => setImmediate(resolve));
        harness.fireDeadlines();
    }
}

// Tracks settlement without consuming the rejection, so the assertions still see it.
function track(promise) {
    const state = { done: false };
    state.promise = promise.finally(() => { state.done = true; });
    return state;
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

    const pending = track(rejection(harness.call('sendToContentScript(1, { action: "read_page" })')));
    await fireWhenParked(harness, pending);
    const err = await pending.promise;

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

    const pending = track(rejection(harness.call("handleScreenshot({ tabId: 1 })")));
    await fireWhenParked(harness, pending);
    const err = await pending.promise;

    assert.equal(err.code, "permission_required");
    assert.match(err.message, /behind another window/);
});

test("a screenshot still works when the page context read fails", async () => {
    // Access is fine, the context read is not. That read is allowed to fail and
    // still produce a picture, so the probe must not be what decides it.
    const harness = loadBackground({
        pageContext: async () => { throw new Error("cannot read page context"); },
    });

    const capture = await harness.call("handleScreenshot({ tabId: 1 })");

    assert.equal(capture.image, "AAAB");
});

test("a screenshot on a blocked tab refuses before it waits on tabs.get", async () => {
    // Real Safari blocks `tabs.get` on the same dialog as the capture, so
    // deadlining only the capture left this call absorbing the whole wait and
    // reporting a bridge timeout. Every tab API is parked here to model that.
    const harness = loadBackground({ probe: parked, tabsBlocked: true });

    const pending = track(rejection(harness.call("handleScreenshot({ tabId: 1 })")));
    await fireWhenParked(harness, pending);
    const err = await pending.promise;

    assert.equal(err.code, "permission_required");
});

test("the refusal names the origin even though tabs.get is blocked too", async () => {
    // The probe raises the dialog, and from that moment `tabs.get` blocks on it
    // as well. Reading the origin afterwards returns nothing, which left the
    // message unable to say which site it was about.
    const harness = loadBackground({ probe: parked, blockTabsAfterProbe: true });

    const pending = track(rejection(harness.call('sendToContentScript(1, { action: "read_page" })')));
    await fireWhenParked(harness, pending);
    const err = await pending.promise;

    assert.equal(err.code, "permission_required");
    assert.match(err.message, /https:\/\/blocked\.example/);
});

test("tab listing parked on the dialog reports why instead of timing out", async () => {
    const harness = loadBackground();
    harness.call("browser.tabs.query = () => new Promise(() => {})");

    const pending = track(rejection(harness.call("handleTabsQuery()")));
    await fireWhenParked(harness, pending);
    const err = await pending.promise;

    assert.equal(err.code, "permission_required");
    assert.equal(err.recoveryAction, "ask_user");
    // No single tab owns this block, so no origin is claimed.
    assert.doesNotMatch(err.message, /https:/);
});

test("an unreadable tab url still produces a usable refusal", async () => {
    const harness = loadBackground({ probe: parked, tabUrl: undefined });

    const pending = track(rejection(harness.call('sendToContentScript(1, { action: "read_page" })')));
    await fireWhenParked(harness, pending);
    const err = await pending.promise;

    assert.equal(err.code, "permission_required");
    assert.match(err.message, /this tab/);
});

// `handleTabsQuery` above is deadlined because `tabs.query` parks on the dialog.
// `getActiveTabId` makes the same two calls and had no deadline at all, and it
// resolves the target for every request that names no tab, which is most of
// them. One unbounded line there puts the whole tool surface back on the
// 30-second bridge timeout the deadlines exist to stay under.
test("resolving the active tab reports why instead of riding the bridge timeout", async () => {
    const harness = loadBackground();
    harness.call("browser.tabs.query = () => new Promise(() => {})");

    const pending = track(rejection(harness.call("getActiveTabId()")));
    await fireWhenParked(harness, pending);
    const err = await pending.promise;

    assert.equal(err.code, "permission_required");
    assert.equal(err.recoveryAction, "ask_user");
    assert.match(err.message, /behind another window/);
});

test("a pinned tab parked on the dialog is not mistaken for a closed one", async () => {
    const harness = loadBackground();
    harness.call("selectedTabId = 7");
    harness.call("browser.tabs.get = () => new Promise(() => {})");

    const pending = track(rejection(harness.call("getActiveTabId()")));
    await fireWhenParked(harness, pending);
    const err = await pending.promise;

    assert.equal(err.code, "permission_required");
    // The old catch-all treated any failure here as "the tab went away" and
    // cleared the pin, losing the caller's chosen tab over a question the user
    // simply had not answered yet.
    assert.equal(harness.call("selectedTabId"), 7);
});

test("select_tab parked on the dialog names the reason", async () => {
    const harness = loadBackground({ probe: parked });

    const pending = track(rejection(harness.call("handleSelectTab({ tabId: 1 })")));
    await fireWhenParked(harness, pending);
    const err = await pending.promise;

    assert.equal(err.code, "permission_required");
    assert.match(err.message, /https:\/\/blocked\.example/);
});

test("native input focus parked on the dialog names the reason", async () => {
    const harness = loadBackground({ probe: parked });

    const pending = track(rejection(harness.call("focusTabForNativeInput(1)")));
    await fireWhenParked(harness, pending);
    const err = await pending.promise;

    assert.equal(err.code, "permission_required");
    assert.match(err.message, /https:\/\/blocked\.example/);
});

test("navigating away from a blocked tab is not stopped by reading it first", async () => {
    // Leaving is the one move that gets a caller off a page they cannot use, so
    // reading the page being left is best effort rather than a precondition.
    const harness = loadBackground();
    harness.call("globalThis.navigated = []");
    harness.call("browser.tabs.get = () => new Promise(() => {})");
    harness.call("browser.tabs.update = async (id, info) => { navigated.push(info.url); }");

    // Deliberately not awaiting the handler: with `tabs.get` parked forever the
    // load wait it arms afterwards cannot finish either. What this pins down is
    // the step before that, which used to park and spend the bridge timeout
    // without the navigation ever being attempted.
    const running = harness.call('handleNavigate({ tabId: 1, url: "https://ok.example/" })');
    running.catch(() => {});
    for (let i = 0; i < 200 && harness.call("navigated.length") === 0; i += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        harness.fireDeadlines();
    }

    // Joined inside the context: an array built in there carries that realm's
    // prototype, which strict deep equality counts as a difference.
    assert.equal(harness.call('navigated.join("|")'), "https://ok.example/");
});

test("a refused tab is not probed again for every frame in one request", async () => {
    // The counterpart to the granted case above. Only successes were cached, so
    // the blocked case, which is the one the cache exists for, probed again on
    // every call and a frame search paid one per frame.
    let probes = 0;
    const harness = loadBackground({
        probe: async () => {
            probes += 1;
            throw new Error("This extension does not have access to this tab");
        },
    });

    await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));
    await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));

    assert.equal(probes, 1);
});

test("a cached refusal still names the origin and the recovery", async () => {
    const harness = loadBackground({
        probe: async () => { throw new Error("This extension does not have access to this tab"); },
    });

    await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));
    const err = await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));

    // The second caller gets the same refusal, not a bare cache miss.
    assert.equal(err.code, "permission_required");
    assert.equal(err.recoveryAction, "ask_user");
    assert.match(err.message, /https:\/\/blocked\.example/);
});

test("a tab that navigates loses its cached grant", async () => {
    let probes = 0;
    const harness = loadBackground({
        probe: async () => { probes += 1; return [{ result: true }]; },
    });

    await harness.call('sendToContentScript(1, { action: "read_page" })');
    assert.equal(probes, 1);

    // Safari grants per origin, so a pass stops meaning anything once the tab
    // goes elsewhere. Keyed by tab alone, a navigate followed straight away by
    // a read reused the previous origin's grant and went back to waiting on the
    // new origin's dialog with nothing bounding it.
    harness.navigateTab(1, "https://elsewhere.example/");
    await harness.call('sendToContentScript(1, { action: "read_page" })');

    assert.equal(probes, 2);
});
