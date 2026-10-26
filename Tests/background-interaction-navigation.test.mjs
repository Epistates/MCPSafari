import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

// An interaction used to answer the moment its event was dispatched. When the
// event started a page load, the next read saw the page being left, and a
// `wait` sent straight after was polling inside a document that was about to be
// replaced: nothing ever answered it, so it ended at the server's 30-second
// bridge timeout although the new page had loaded.
//
// Time here is a virtual clock the test advances, because the behaviour under
// test is a window measured in hundreds of milliseconds and a real one would
// make every case slow and, worse, racy.

const WINDOW_MS = 400;
const OLD_URL = "https://ok.example/results";
const NEW_URL = "https://ok.example/article/7";

function loadBackground({ onMessage, url = OLD_URL } = {}) {
    const clock = { now: 1_000_000 };
    let timers = [];
    let nextTimer = 1;
    const listeners = [];
    const sent = [];
    const tabs = new Map([
        [1, { id: 1, active: true, windowId: 1, url, title: "Results", status: "complete" }],
        [2, { id: 2, active: false, windowId: 1, url: "https://other.example/", title: "Other", status: "complete" }],
    ]);

    const flush = () => new Promise((resolve) => setImmediate(resolve));

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
            get: async (id) => {
                const tab = tabs.get(id);
                if (!tab) throw new Error(`No tab with id: ${id}`);
                return { ...tab };
            },
            query: async () => [...tabs.values()].map((tab) => ({ ...tab })),
            sendMessage: async (tabId, message, options) => {
                sent.push({ tabId, message, at: clock.now, loading: tabs.get(tabId).status === "loading" });
                return onMessage
                    ? onMessage(message, harness, options)
                    : { data: "Clicked <a>", error: null };
            },
            update: async () => {},
            onUpdated: {
                addListener: (listener) => listeners.push(listener),
                removeListener: (listener) => {
                    const at = listeners.indexOf(listener);
                    if (at >= 0) listeners.splice(at, 1);
                },
            },
            onRemoved: { addListener() {} },
        },
        webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url }] },
        windows: { update: async () => {} },
    };

    class FakeDate extends Date {
        static now() { return clock.now; }
    }

    const context = vm.createContext({
        browser,
        clearTimeout: (id) => { timers = timers.filter((timer) => timer.id !== id); },
        console: { error() {}, log() {}, warn() {} },
        Date: FakeDate,
        Error,
        Promise,
        URL,
        setTimeout: (fn, ms) => {
            const id = nextTimer++;
            timers.push({ id, fn, at: clock.now + (ms || 0) });
            return id;
        },
        WebSocket: class { send() {} },
    });
    vm.runInContext(source, context);
    // The background registers listeners of its own at load; only the ones a
    // request adds and fails to remove are of interest.
    const loadedListeners = listeners.length;

    const harness = {
        sent,
        tabs,
        clock,
        flush,
        // What Safari reports to `tabs.onUpdated`: the change, then the tab.
        emit(changeInfo, patch = {}, tabId = 1) {
            const tab = tabs.get(tabId);
            Object.assign(tab, patch);
            for (const listener of [...listeners]) listener(tabId, changeInfo, { ...tab });
        },
        // Runs something at a later virtual time, which is how a page is made
        // to finish loading in the middle of the request.
        later(ms, fn) {
            timers.push({ id: nextTimer++, fn, at: clock.now + ms });
        },
        async advance(ms) {
            const end = clock.now + ms;
            await flush();
            for (;;) {
                const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
                if (!due) break;
                timers = timers.filter((timer) => timer !== due);
                clock.now = Math.max(clock.now, due.at);
                due.fn();
                await flush();
            }
            clock.now = end;
            await flush();
        },
        listenerCount: () => listeners.length - loadedListeners,
        request(action, params = {}) {
            const outcome = { done: false, response: null };
            vm.runInContext(
                `handleRequest(${JSON.stringify({ id: "r1", action, params: { tabId: 1, ...params } })})`,
                context
            ).then((response) => { outcome.done = true; outcome.response = response; });
            return outcome;
        },
    };
    return harness;
}

// A navigation the way Safari reports it: loading first, the URL once the new
// document commits, and complete when it has loaded.
function navigateLater(harness, { after = 50, commitAfter = 100, completeAfter = 300, url = NEW_URL, title = "Article" } = {}) {
    harness.emit({ status: "loading" }, { status: "loading" });
    harness.later(commitAfter, () => harness.emit({ url }, { url }));
    harness.later(completeAfter, () => harness.emit({ status: "complete" }, { status: "complete", title }));
}

test("a click that starts a navigation answers once the new page has loaded, and says where it went", async () => {
    const harness = loadBackground({
        onMessage: async (message, h) => {
            navigateLater(h);
            return { data: "Clicked <a>", error: null };
        },
    });
    const click = harness.request("click", { selector: "a" });

    await harness.advance(250);
    assert.equal(click.done, false, "answered while the page was still loading");
    await harness.advance(1000);

    assert.equal(click.done, true);
    assert.equal(click.response.success, true);
    assert.equal(click.response.data, `Clicked <a>\nPage navigated to ${NEW_URL} (Article)`);
    assert.equal(harness.tabs.get(1).status, "complete");
    assert.equal(harness.listenerCount(), 0, "the load watcher must not outlive the request");
});

test("a click that navigates nowhere answers when the watch window closes, with no note", async () => {
    const harness = loadBackground();
    const click = harness.request("click", { selector: "button" });

    await harness.advance(WINDOW_MS - 1);
    assert.equal(click.done, false);
    await harness.advance(1);

    assert.equal(click.done, true);
    assert.equal(click.response.data, "Clicked <a>");
    assert.equal(harness.listenerCount(), 0);
});

test("a slow dispatch does not use up the watch window", async () => {
    let reply;
    const harness = loadBackground({
        onMessage: (message) => new Promise((resolve) => { reply = () => resolve({ data: "Clicked <a>", error: null }); }),
    });
    const click = harness.request("click", { selector: "a" });
    await harness.advance(5000);
    assert.equal(click.done, false, "the content script has not answered yet");

    // The navigation begins just after the reply, as it does for a handler that
    // yields before assigning location.
    reply();
    await harness.flush();
    harness.later(100, () => navigateLater(harness));
    await harness.advance(WINDOW_MS - 1);
    assert.equal(click.done, false);
    await harness.advance(2000);

    assert.match(click.response.data, /Page navigated to https:\/\/ok\.example\/article\/7/);
});

test("a wait sent after a navigating click reaches the new document, not the one being left", async () => {
    // The page the content script is in is gone while the tab is loading, so a
    // message sent then is never answered.
    const harness = loadBackground({
        onMessage: async (message, h) => {
            if (message.action === "click") {
                navigateLater(h);
                return { data: "Clicked <a>", error: null };
            }
            return { data: "Element found: #abstract", error: null };
        },
    });
    const click = harness.request("click", { selector: "a" });
    while (!click.done) await harness.advance(25);
    const wait = harness.request("wait", { selector: "#abstract" });
    await harness.advance(100);

    assert.equal(wait.response.success, true);
    assert.equal(wait.response.data, "Element found: #abstract");
    const waitSend = harness.sent.find((entry) => entry.message.action === "wait");
    assert.equal(waitSend.loading, false, "the wait was sent into a document that was being replaced");
});

test("a click that changes the URL without a load is a same-document navigation and settles on it", async () => {
    const harness = loadBackground({
        onMessage: async (message, h) => {
            h.emit({ url: "https://ok.example/results?page=2" }, { url: "https://ok.example/results?page=2" });
            return { data: "Clicked <a>", error: null };
        },
    });
    const click = harness.request("click", { selector: "a.next" });

    await harness.advance(WINDOW_MS);
    assert.equal(click.done, false, "the route change had not settled yet");
    await harness.advance(500);

    assert.equal(click.done, true);
    assert.equal(
        click.response.data,
        "Clicked <a>\nPage navigated to https://ok.example/results?page=2 (Results)"
    );
});

test("a click that opens a new tab leaves this one alone and is not held for the new one", async () => {
    const harness = loadBackground({
        onMessage: async (message, h) => {
            // The other tab loads; this one never does.
            h.emit({ status: "loading" }, { status: "loading" }, 2);
            h.later(10_000, () => h.emit({ status: "complete" }, { status: "complete" }, 2));
            return { data: "Clicked <a target=_blank>", error: null };
        },
    });
    const click = harness.request("click", { selector: "a[target=_blank]" });

    await harness.advance(WINDOW_MS);

    assert.equal(click.done, true);
    assert.equal(click.response.data, "Clicked <a target=_blank>");
});

test("only interactions that can start a load pay the watch window", async () => {
    for (const [action, params] of [
        ["hover", { selector: "a" }],
        ["scroll", { direction: "down" }],
        ["type_text", { selector: "input", text: "hello" }],
    ]) {
        const harness = loadBackground({ onMessage: async () => ({ data: "done", error: null }) });
        const outcome = harness.request(action, params);
        await harness.flush();
        assert.equal(outcome.done, true, `${action} waited for a navigation it cannot start`);
    }
});

for (const [action, params] of [
    ["click", { selector: "a" }],
    ["press_key", { key: "Enter" }],
    ["type_text", { selector: "input", text: "query", submitKey: "Enter" }],
    ["form_input", { selector: "input", value: "x" }],
    ["select_option", { selector: "select", value: "2" }],
]) {
    test(`${action} waits for the load it starts`, async () => {
        const harness = loadBackground({
            onMessage: async (message, h) => {
                navigateLater(h);
                return { data: "done", error: null };
            },
        });
        const outcome = harness.request(action, params);

        await harness.advance(200);
        assert.equal(outcome.done, false);
        await harness.advance(1000);

        assert.match(outcome.response.data, /Page navigated to /);
    });
}

test("an interaction that fails is reported at once, not after a load it did not start", async () => {
    const harness = loadBackground({
        onMessage: async () => ({
            data: null,
            error: "No element matches a.missing",
            errorCode: "target_not_found",
            retryable: false,
            recoveryAction: "take_snapshot",
        }),
    });
    const click = harness.request("click", { selector: "a.missing" });
    await harness.flush();

    assert.equal(click.done, true);
    assert.equal(click.response.success, false);
    assert.equal(click.response.errorCode, "target_not_found");
    await harness.advance(WINDOW_MS);
    assert.equal(harness.listenerCount(), 0, "the watcher outlived a failed action");
});

test("a click that closes its own tab still succeeds", async () => {
    const harness = loadBackground({
        onMessage: async (message, h) => {
            h.emit({ status: "loading" }, { status: "loading" });
            h.later(50, () => h.tabs.delete(1));
            return { data: "Clicked <a>", error: null };
        },
    });
    const click = harness.request("click", { selector: "a.close" });
    // The load watcher ends at its own 15 seconds, and then finds the tab gone.
    await harness.advance(20_000);

    assert.equal(click.done, true);
    assert.equal(click.response.success, true);
});

test("a load that never finishes is given 15 seconds and then reported as unfinished", async () => {
    const harness = loadBackground({
        onMessage: async (message, h) => {
            h.emit({ status: "loading" }, { status: "loading" });
            h.later(100, () => h.emit({ url: NEW_URL }, { url: NEW_URL }));
            return { data: "Clicked <a>", error: null };
        },
    });
    const click = harness.request("click", { selector: "a" });

    await harness.advance(14_000);
    assert.equal(click.done, false);
    await harness.advance(1_100);

    assert.equal(click.done, true);
    assert.equal(
        click.response.data,
        `Clicked <a>\nPage navigated to ${NEW_URL} (Results); it was still loading`
    );
});

test("the reported URL is redacted and a site that was not granted gets no title", async () => {
    const harness = loadBackground({
        onMessage: async (message, h) => {
            navigateLater(h, { url: "https://elsewhere.example/cb?token=hunter2&page=1", title: "Private inbox" });
            return { data: "Clicked <a>", error: null };
        },
    });
    const click = harness.request("click", { selector: "a" });
    await harness.advance(2000);

    const data = click.response.data;
    assert.doesNotMatch(data, /hunter2/);
    assert.match(data, /Page navigated to https:\/\/elsewhere\.example\/cb\?/);
    assert.doesNotMatch(data, /Private inbox/);
    assert.match(data, /title withheld/);
});

test("an object result gets the new URL as a field instead of a trailing line", async () => {
    const harness = loadBackground({
        onMessage: async (message, h) => {
            navigateLater(h, { url: "https://elsewhere.example/?session=abc123" });
            return { data: { clicked: true }, error: null };
        },
    });
    const click = harness.request("click", { selector: "a" });
    await harness.advance(2000);

    const data = JSON.parse(click.response.data);
    assert.equal(data.clicked, true);
    assert.match(data.navigatedTo, /^https:\/\/elsewhere\.example\//);
    assert.doesNotMatch(data.navigatedTo, /abc123/);
});

// ─── wait ────────────────────────────────────────────────────────────

// A wait whose document is replaced gets no answer, ever. This is that
// document: the first message is swallowed, the way the old page takes it down
// with it, and later ones are answered by the new one.
function swallowFirstWait() {
    let waits = 0;
    return async (message, h) => {
        waits += 1;
        if (waits === 1) return new Promise(() => {});
        return { data: `Element found: ${message.params.selector}`, error: null };
    };
}

test("a wait pending when the page navigates is sent again to the new document", async () => {
    const harness = loadBackground({ onMessage: swallowFirstWait() });
    const wait = harness.request("wait", { selector: "#abstract", timeout: 10 });

    await harness.advance(2000);
    assert.equal(wait.done, false);
    // The page the user script started navigating away from.
    harness.emit({ status: "loading" }, { status: "loading" });
    await harness.advance(1000);
    assert.equal(wait.done, false, "answered before the new page had loaded");
    harness.emit({ url: NEW_URL }, { url: NEW_URL });
    harness.emit({ status: "complete" }, { status: "complete" });
    await harness.advance(10);

    assert.equal(wait.response.success, true);
    assert.equal(wait.response.data, "Element found: #abstract");
    const waits = harness.sent.filter((entry) => entry.message.action === "wait");
    assert.equal(waits.length, 2);
    assert.equal(waits[1].loading, false, "re-sent into a document that was still loading");
    // 10 seconds, less the 3 spent: the budget is the caller's, not a fresh one.
    assert.equal(waits[1].message.params.timeout, 7);
    assert.equal(harness.listenerCount(), 0);
});

test("a wait whose request fails because the document went away is sent again", async () => {
    let waits = 0;
    const harness = loadBackground({
        onMessage: async (message, h) => {
            waits += 1;
            if (waits > 1) return { data: "Text found: \"Done\"", error: null };
            h.emit({ status: "loading" }, { status: "loading" });
            h.later(500, () => h.emit({ status: "complete" }, { status: "complete" }));
            throw new Error("The message channel closed before a response was received");
        },
    });
    const wait = harness.request("wait", { text: "Done", timeout: 10 });
    await harness.advance(2000);

    assert.equal(wait.response.success, true);
    assert.equal(wait.response.data, "Text found: \"Done\"");
    assert.equal(waits, 2);
});

test("a wait that times out on its own page is not sent again", async () => {
    const harness = loadBackground({
        onMessage: async () => ({
            data: null,
            error: "Timeout waiting for selector: #nope",
            errorCode: "wait_timeout",
            retryable: true,
            recoveryAction: "retry",
        }),
    });
    const wait = harness.request("wait", { selector: "#nope", timeout: 1 });
    await harness.advance(10);

    assert.equal(wait.response.success, false);
    assert.equal(wait.response.errorCode, "wait_timeout");
    assert.equal(harness.sent.filter((entry) => entry.message.action === "wait").length, 1);
});

test("a wait that is still pending when the navigation uses up its time fails as a retryable wait_timeout", async () => {
    const harness = loadBackground({ onMessage: async () => new Promise(() => {}) });
    const wait = harness.request("wait", { selector: "#abstract", timeout: 3 });

    await harness.advance(2000);
    harness.emit({ status: "loading" }, { status: "loading" });
    await harness.advance(5000);

    // Well inside the bridge timeout, with a reason, instead of the generic one.
    assert.equal(wait.done, true);
    assert.equal(wait.response.success, false);
    assert.equal(wait.response.errorCode, "wait_timeout");
    assert.equal(wait.response.retryable, true);
    assert.match(wait.response.error, /navigated while waiting/);
});

test("a wait that finishes before any navigation is untouched", async () => {
    const harness = loadBackground({
        onMessage: async () => ({ data: "Element found: #x", error: null }),
    });
    const wait = harness.request("wait", { selector: "#x" });
    await harness.flush();

    assert.equal(wait.response.data, "Element found: #x");
    assert.equal(harness.sent.length, 1);
    assert.equal(harness.listenerCount(), 0);
});

test("a timed wait that a navigation interrupts is sent again for the time that is left", async () => {
    let waits = 0;
    const harness = loadBackground({
        onMessage: async (message) => {
            waits += 1;
            if (waits === 1) return new Promise(() => {});
            return { data: `Waited ${message.params.seconds} seconds`, error: null };
        },
    });
    const wait = harness.request("wait", { seconds: 4 });
    await harness.advance(1000);
    harness.emit({ status: "loading" }, { status: "loading" });
    harness.emit({ status: "complete" }, { status: "complete" });
    await harness.advance(10);

    const waitsSent = harness.sent.filter((entry) => entry.message.action === "wait");
    assert.equal(waitsSent[1].message.params.seconds, 3);
    assert.equal(wait.response.success, true);
});
