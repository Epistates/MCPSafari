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
    // The same, for a dialog that comes up during a capture rather than a probe.
    blockTabsAfterCapture = false,
    // What Safari says about the tab and its window when nothing holds them.
    tabActive = true,
    windowState = "normal",
} = {}) {
    const timers = [];
    const tabUpdatedListeners = [];
    const tabRemovedListeners = [];
    // What the toolbar button was last told, call by call.
    const toolbar = { text: undefined, color: undefined, title: undefined, texts: [] };
    const tabActivatedListeners = [];
    let probeStarted = false;
    let captureStarted = false;
    const held = () => tabsBlocked || (blockTabsAfterProbe && probeStarted)
        || (blockTabsAfterCapture && captureStarted);
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
                if (held()) return new Promise(() => {});
                return [{ id: 1, active: true, windowId: 1 }];
            },
            get: async (id) => {
                if (held()) return new Promise(() => {});
                return { id, active: tabActive, windowId: 1, url: tabUrl, title: "T" };
            },
            update: async () => {},
            captureVisibleTab: (...args) => {
                captureStarted = true;
                return captureVisibleTab(...args);
            },
            sendMessage,
            onUpdated: {
                addListener: (listener) => { tabUpdatedListeners.push(listener); },
                removeListener() {},
            },
            onRemoved: { addListener: (listener) => { tabRemovedListeners.push(listener); } },
            onActivated: { addListener: (listener) => { tabActivatedListeners.push(listener); } },
        },
        action: {
            setBadgeText: async ({ text }) => { toolbar.text = text; toolbar.texts.push(text); },
            setBadgeBackgroundColor: async ({ color }) => { toolbar.color = color; },
            setBadgeTextColor: async () => {},
            setTitle: async ({ title }) => { toolbar.title = title; },
        },
        webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: tabUrl }] },
        windows: {
            update: async () => {},
            get: async (id) => ({ id, state: windowState, focused: false }),
        },
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
        toolbar,
        closeTab(tabId) {
            for (const listener of tabRemovedListeners) listener(tabId, {});
        },
        call: (expression) => vm.runInContext(expression, context),
        /// Drives `tabs.onUpdated`, which the extension listens to so a tab
        /// that navigates loses its cached access grant.
        navigateTab(tabId, url) {
            for (const listener of tabUpdatedListeners) listener(tabId, { url });
        },
        /// Drives `tabs.onActivated`, as `select_tab` or the user's click does.
        activateTab(tabId) {
            for (const listener of tabActivatedListeners) listener({ tabId, windowId: 1 });
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
    // The dialog holds `tabs.get` as well, and that is what tells it apart from
    // a page that is only hidden or busy (see the page tests below).
    const harness = loadBackground({ probe: parked, blockTabsAfterProbe: true });

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
    assert.match(err.message, /isn't allowed on/);
    // Safari 27.2 asks nothing, so the message says where to go and what marks it.
    assert.match(err.message, /doesn't ask by itself/);
    assert.match(err.message, /toolbar while this tab is showing/);
    assert.match(err.message, /shows a "!"/);
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
    const harness = loadBackground({ captureVisibleTab: parked, blockTabsAfterCapture: true });

    const pending = track(rejection(harness.call("handleScreenshot({ tabId: 1 })")));
    await fireWhenParked(harness, pending);
    const err = await pending.promise;

    assert.equal(err.code, "permission_required");
    assert.match(err.message, /behind another window/);
});

// ─── A page that doesn't answer is not a dialog ──────────────────────
//
// A probe misses its deadline on a page Safari isn't showing, or a busy one, as
// well as on a dialog. The dialog holds `tabs.get` too and those don't, which is
// how the two are told apart. Reported from real use: a background tab on a site
// the user had allowed, in a window another agent was using, was refused as
// "Safari is showing a permission dialog", and the user went looking for one.

const parkedAndTimed = async (harness, expression) => {
    const pending = track(rejection(harness.call(expression)));
    await fireWhenParked(harness, pending);
    return pending.promise;
};

test("a background tab that doesn't answer is named as hidden, not as a permission dialog", async () => {
    const harness = loadBackground({ probe: parked, tabActive: false });
    harness.call(`rememberOriginAccess("https://blocked.example", true)`);

    const err = await parkedAndTimed(harness, 'sendToContentScript(1, { action: "read_page" })');

    assert.equal(err.code, "page_hidden");
    assert.equal(err.retryable, true);
    assert.equal(err.recoveryAction, "call_select_tab");
    assert.match(err.message, /https:\/\/blocked\.example/);
    assert.match(err.message, /isn't the tab showing in its window/);
    assert.match(err.message, /No permission dialog/);
    // Bringing it forward hides whatever the window shows now, so the way to
    // stay out of someone else's window is named alongside.
    assert.match(err.message, /select_tab/);
    assert.match(err.message, /newWindow: true/);
    assert.doesNotMatch(err.message, /behind another window|Always Allow/);
    assert.equal(err.permissionPending, undefined);
    assert.equal(harness.call(`grantedOrigins.has("https://blocked.example")`), true);
});

test("a hidden page doesn't put a ! on the toolbar button, and a dialog still does", async () => {
    // The "!" asks the user to allow a site. On an allowed site whose tab is
    // hidden there is nothing to allow, and the tooltip would send them to the
    // button for nothing.
    const hidden = loadBackground({ probe: parked, tabActive: false });
    hidden.call(`rememberOriginAccess("https://blocked.example", true)`);
    const hiddenErr = await parkedAndTimed(hidden, 'sendToContentScript(1, { action: "read_page" })');
    assert.equal(hiddenErr.code, "page_hidden");
    assert.notEqual(hidden.toolbar.text, "!");

    const dialog = loadBackground({ probe: parked, blockTabsAfterProbe: true });
    const dialogErr = await parkedAndTimed(dialog, 'sendToContentScript(1, { action: "read_page" })');
    assert.equal(dialogErr.code, "permission_required");
    assert.equal(dialog.toolbar.text, "!");
});

test("a minimized window is named, and the user is asked to restore it", async () => {
    const harness = loadBackground({ probe: parked, windowState: "minimized" });
    harness.call(`rememberOriginAccess("https://blocked.example", true)`);

    const err = await parkedAndTimed(harness, 'sendToContentScript(1, { action: "read_page" })');

    assert.equal(err.code, "page_hidden");
    assert.equal(err.recoveryAction, "ask_user");
    assert.match(err.message, /minimized/);
    assert.match(err.message, /restore the window/);
});

test("the tab in front that doesn't answer is named as covered or busy", async () => {
    const harness = loadBackground({ probe: parked });
    harness.call(`rememberOriginAccess("https://blocked.example", true)`);

    const err = await parkedAndTimed(harness, 'sendToContentScript(1, { action: "read_page" })');

    assert.equal(err.code, "page_not_responding");
    assert.equal(err.retryable, true);
    assert.equal(err.recoveryAction, "ask_user");
    assert.match(err.message, /covered/);
    assert.match(err.message, /another Space/);
    assert.match(err.message, /busy/);
    assert.doesNotMatch(err.message, /behind another window/);
});

test("a site never reached before keeps the dialog in view", async () => {
    // Safari's hold on its tab API doesn't last as long as a dialog can, so on
    // a site nobody has granted yet a dialog can't be ruled out.
    const harness = loadBackground({ probe: parked, tabActive: false });

    const err = await parkedAndTimed(harness, 'sendToContentScript(1, { action: "read_page" })');

    assert.equal(err.code, "page_hidden");
    assert.match(err.message, /hasn't reached this site before/);
    assert.match(err.message, /behind another window/);
});

test("a capture that stalls while Safari still answers names the page, not a dialog", async () => {
    const harness = loadBackground({ captureVisibleTab: parked });

    const err = await parkedAndTimed(harness, "handleScreenshot({ tabId: 1 })");

    assert.equal(err.code, "page_not_responding");
    assert.match(err.message, /https:\/\/blocked\.example/);
});

test("bringing the tab to the front drops its cached refusal", async () => {
    let answering = false;
    let probes = 0;
    const harness = loadBackground({
        probe: () => { probes += 1; return answering ? Promise.resolve([{ result: true }]) : parked(); },
        tabActive: false,
    });

    const first = await parkedAndTimed(harness, 'sendToContentScript(1, { action: "read_page" })');
    assert.equal(first.code, "page_hidden");

    // Within the cache's life the refusal is answered from it, which is what
    // keeps the frames of one request from each waiting the probe out.
    answering = true;
    const cached = await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));
    assert.equal(cached, first);
    assert.equal(probes, 1);

    // select_tab, or the user's click, brings it forward, and the retry works.
    harness.activateTab(1);
    assert.equal(await harness.call('sendToContentScript(1, { action: "read_page" })'), "ok");
    assert.equal(probes, 2);
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
    const harness = loadBackground({ probe: parked, blockTabsAfterProbe: true, tabUrl: null });

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

    const pending = track(rejection(harness.call("getActiveTabId(8089)")));
    await fireWhenParked(harness, pending);
    const err = await pending.promise;

    assert.equal(err.code, "permission_required");
    assert.equal(err.recoveryAction, "ask_user");
    assert.match(err.message, /behind another window/);
});

test("a pinned tab parked on the dialog is not mistaken for a closed one", async () => {
    const harness = loadBackground();
    harness.call("pinnedTabs.set(8089, { tabId: 7, run: null })");
    harness.call("browser.tabs.get = () => new Promise(() => {})");

    const pending = track(rejection(harness.call("getActiveTabId(8089)")));
    await fireWhenParked(harness, pending);
    const err = await pending.promise;

    assert.equal(err.code, "permission_required");
    // The old catch-all treated any failure here as "the tab went away" and
    // cleared the pin, losing the caller's chosen tab over a question the user
    // simply had not answered yet.
    assert.equal(harness.call("pinnedTabs.get(8089)?.tabId"), 7);
});

test("select_tab on a tab parked on the dialog still pins it, and the next page call names the reason", async () => {
    // Pinning is bookkeeping and needs no access to the page, so a tab the user
    // has yet to grant can be chosen. What it cannot do is be read.
    const harness = loadBackground({ probe: parked, blockTabsAfterProbe: true });

    const selected = await harness.call("handleSelectTab({ tabId: 1 }, 8089)");
    assert.equal(selected.selected, true);
    assert.equal(selected.access, "not_granted");
    assert.equal(harness.call("pinnedTabs.get(8089)?.tabId"), 1);

    const pending = track(rejection(harness.call('sendToContentScript(1, { action: "read_page" })')));
    await fireWhenParked(harness, pending);
    const err = await pending.promise;

    assert.equal(err.code, "permission_required");
    assert.match(err.message, /https:\/\/blocked\.example/);
});

test("native input focus parked on the dialog names the reason", async () => {
    const harness = loadBackground({ probe: parked, blockTabsAfterProbe: true });

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

// ─── What a failed probe does and does not mean ───────────────────────

const REFUSAL = "This extension does not have access to this tab";
const BLOCKED_ORIGIN = "https://blocked.example";

test("a probe on a tab that has closed says so instead of claiming access is missing", async () => {
    // Every probe failure used to read as `permission_required`, so a closed tab
    // sent the user to Safari's settings to grant a site that was never the
    // problem, and forgot the grant it had.
    const harness = loadBackground({
        probe: async () => { throw new Error("No tab with id: 1"); },
    });
    harness.call(`rememberOriginAccess("${BLOCKED_ORIGIN}", true)`);
    harness.call("browser.tabs.query = async () => []");

    const err = await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));

    assert.equal(err.code, "tab_closed");
    assert.equal(err.retryable, false);
    assert.equal(harness.call(`grantedOrigins.has("${BLOCKED_ORIGIN}")`), true, "a closed tab revoked the grant");
});

test("a probe that fails for a reason that is not access is passed on, uncached, with the grant kept", async () => {
    let probes = 0;
    const harness = loadBackground({
        probe: async () => { probes += 1; throw new Error("The page is being torn down"); },
    });
    harness.call(`rememberOriginAccess("${BLOCKED_ORIGIN}", true)`);

    const first = await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));
    const second = await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));

    assert.equal(first.code, undefined);
    assert.match(first.message, /being torn down/);
    assert.equal(probes, 2, "a failure that says nothing about access was cached as if it did");
    assert.equal(second.code, undefined);
    assert.equal(harness.call(`grantedOrigins.has("${BLOCKED_ORIGIN}")`), true);
});

test("a tab Safari has not loaded is named, uncached, with the grant kept", async () => {
    // Safari restores a window's tabs at launch without loading them, and loads
    // each one only when it is shown. Asked to run a script in one, it says this,
    // and only after its access check has passed, so it says nothing about access.
    let probes = 0;
    const harness = loadBackground({
        probe: async () => {
            probes += 1;
            throw new Error("Invalid call to scripting.executeScript(). Could not execute script on this tab.");
        },
    });
    harness.call(`rememberOriginAccess("${BLOCKED_ORIGIN}", true)`);

    const first = await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));
    await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));

    assert.equal(first.code, "tab_not_loaded");
    assert.equal(first.retryable, true);
    assert.equal(first.recoveryAction, "call_select_tab");
    assert.match(first.message, /select_tab/);
    assert.equal(probes, 2, "an unloaded tab was cached as if it said something about access");
    assert.equal(harness.call(`grantedOrigins.has("${BLOCKED_ORIGIN}")`), true);
});

test("a granted page too slow to probe keeps its stored grant", async () => {
    // Two seconds is a long time for a probe and not much for a busy page.
    // Nothing has been decided either way, so a stored grant is not evidence
    // against it, whether the page is busy or a dialog is open.
    for (const blockTabsAfterProbe of [false, true]) {
        const harness = loadBackground({ probe: parked, blockTabsAfterProbe });
        harness.call(`rememberOriginAccess("${BLOCKED_ORIGIN}", true)`);

        const pending = track(rejection(harness.call('sendToContentScript(1, { action: "read_page" })')));
        await fireWhenParked(harness, pending);
        const err = await pending.promise;

        assert.equal(err.code, blockTabsAfterProbe ? "permission_required" : "page_not_responding");
        assert.equal(harness.call(`grantedOrigins.has("${BLOCKED_ORIGIN}")`), true, "a deadline deleted the stored grant");
    }
});

test("an explicit refusal forgets the stored grant", async () => {
    const harness = loadBackground({ probe: async () => { throw new Error(REFUSAL); } });
    harness.call(`rememberOriginAccess("${BLOCKED_ORIGIN}", true)`);

    const err = await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));

    assert.equal(err.code, "permission_required");
    assert.equal(err.permissionPending, false);
    assert.equal(harness.call(`grantedOrigins.has("${BLOCKED_ORIGIN}")`), false);
});

test("a tab that navigates while it is probed is credited to neither origin", async () => {
    // The probe ran on one origin or the other and which is unknowable, so
    // crediting a grant to either would be a guess that makes tabs_context show
    // a URL nobody was granted.
    let harness;
    harness = loadBackground({
        probe: async () => {
            harness.call('globalThis.__url = "https://elsewhere.example/page"');
            return [{ result: true }];
        },
    });
    harness.call('globalThis.__url = "https://blocked.example/page"');
    harness.call("browser.tabs.get = async (id) => ({ id, active: true, windowId: 1, url: globalThis.__url, title: 'T' })");

    await harness.call('sendToContentScript(1, { action: "read_page" })');

    assert.equal(harness.call("grantedOrigins.size"), 0, "an origin the probe may not have run on was recorded");
});

test("a probe on a tab that did not move records its origin", async () => {
    const harness = loadBackground();

    await harness.call('sendToContentScript(1, { action: "read_page" })');

    assert.equal(harness.call(`grantedOrigins.has("${BLOCKED_ORIGIN}")`), true);
});

test("concurrent calls on one tab share a single probe", async () => {
    // A frame search asks for every frame at once. Each used to probe on its own,
    // since the cache only fills in once a probe has finished.
    let probes = 0;
    const harness = loadBackground({
        probe: async () => { probes += 1; return [{ result: true }]; },
    });

    await Promise.all([1, 2, 3, 4].map(
        () => harness.call('sendToContentScript(1, { action: "read_page" })')
    ));

    assert.equal(probes, 1);
});

// ─── The toolbar button says when access is waiting ──────────────────
//
// Safari 27.2 refuses a site nobody has decided on without asking anything, and
// the only place to allow it is the MCPSafari button, which gave no sign. Seen
// in real use: the user looked for a dialog that never came.

test("a refused site puts a ! on the toolbar button, naming the site", async () => {
    const harness = loadBackground({ probe: async () => { throw new Error(REFUSAL); } });
    // Cleared at startup, in case a suspended page left one behind.
    assert.equal(harness.toolbar.texts[0], "");

    const err = await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));

    assert.equal(err.code, "permission_required");
    assert.equal(harness.toolbar.text, "!");
    assert.match(harness.toolbar.title, /blocked\.example/);
    assert.match(harness.toolbar.title, /click here/);
});

test("the ! goes once a call on that site gets through, on any of its tabs", async () => {
    let allowed = false;
    const harness = loadBackground({
        probe: async () => { if (!allowed) throw new Error(REFUSAL); return [{ result: true }]; },
    });
    await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));
    await rejection(harness.call('sendToContentScript(2, { action: "read_page" })'));
    assert.equal(harness.toolbar.text, "!");

    // The user allows the site; the next call on either tab gets through, and the
    // grant is per site, so both waits end.
    allowed = true;
    harness.call("tabAccessProbes.clear()");
    await harness.call('sendToContentScript(2, { action: "read_page" })');

    assert.equal(harness.toolbar.text, "");
    assert.equal(harness.call("tabsAwaitingAccess.size"), 0);
});

test("closing or navigating the waiting tab takes the ! away", async () => {
    const harness = loadBackground({ probe: async () => { throw new Error(REFUSAL); } });

    await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));
    harness.closeTab(1);
    assert.equal(harness.toolbar.text, "");

    await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));
    harness.navigateTab(1, "https://elsewhere.example/");
    assert.equal(harness.toolbar.text, "");
});

test("a wait nobody acted on stops showing after a while", async () => {
    const harness = loadBackground({ probe: async () => { throw new Error(REFUSAL); } });
    await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));

    harness.call("expireAccessWaits()");
    assert.equal(harness.toolbar.text, "!", "a fresh wait was dropped");

    harness.call("tabsAwaitingAccess.get(1).at = Date.now() - ACCESS_WAIT_SHOWN_MS");
    harness.call("expireAccessWaits()");
    assert.equal(harness.toolbar.text, "");
});

test("a site Safari won't name still raises the !", async () => {
    // Safari doesn't show an extension the address of a tab on a site it hasn't
    // been allowed, so the tooltip can't say which site.
    const harness = loadBackground({ probe: async () => { throw new Error(REFUSAL); }, tabUrl: null });

    await rejection(harness.call('sendToContentScript(1, { action: "read_page" })'));

    assert.equal(harness.toolbar.text, "!");
    assert.match(harness.toolbar.title, /a site/);
});
