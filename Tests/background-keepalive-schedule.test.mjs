import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { handshakeGlobals } from "./helpers/bridge-handshake.mjs";
import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

// Safari unloads a non-persistent background page 30 seconds after its last
// extension event (WebKit, scheduleBackgroundContentToUnload), and runs an alarm
// no more often than every 30 seconds (webExtensionMinimumAlarmInterval). One
// 30-second alarm beat the unload only by being scheduled microseconds earlier,
// so the page's life rested on two equal constants. These pin the schedule that
// gives it a real margin: two alarms half a period apart.

const source = backgroundScriptSource();
const SAFARI_UNLOAD_DELAY_S = 30;
const SAFARI_MINIMUM_ALARM_PERIOD_S = 30;

const settle = async () => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

function loadBackground() {
    const alarms = [];
    const reads = [];
    const timers = [];
    let alarmListener = null;
    const browser = {
        alarms: {
            create: (name, info) => alarms.push({ name, ...info }),
            onAlarm: { addListener: (listener) => { alarmListener = listener; } },
        },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async (_application, message) => {
                reads.push(message);
                return { tokens: {}, nonce: message.nonce };
            },
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: { onUpdated: { addListener() {} }, onRemoved: { addListener() {} } },
    };
    const context = vm.createContext({
        ...handshakeGlobals,
        browser,
        clearTimeout: (id) => { if (timers[id]) timers[id].cancelled = true; },
        console: { error() {}, log() {}, warn() {} },
        Date,
        Promise,
        setTimeout: (callback, ms) => timers.push({ callback, ms, cancelled: false }) - 1,
        WebSocket: class {},
    });
    vm.runInContext(source, context);
    return {
        alarms,
        reads,
        /// Fires the alarm, then lets the read's pause run out. Returns the pauses it queued.
        async fire(name) {
            const queued = timers.length;
            alarmListener({ name });
            const pauses = timers.slice(queued);
            for (const timer of pauses) if (!timer.cancelled) timer.callback();
            await settle();
            return pauses.map((timer) => timer.ms);
        },
        spread: vm.runInContext("KEEPALIVE_READ_SPREAD_MS", context),
    };
}

/// Seconds after the page loads at which each alarm fires, up to `horizon`.
function firings(alarms, horizon) {
    const times = [];
    for (const alarm of alarms) {
        const first = (alarm.delayInMinutes ?? alarm.periodInMinutes) * 60;
        for (let at = first; at <= horizon; at += alarm.periodInMinutes * 60) times.push(at);
    }
    return times.sort((a, b) => a - b);
}

test("the page keeps two keepalive alarms, each at Safari's shortest period, half a period apart", async () => {
    const { alarms } = loadBackground();
    await settle();

    assert.equal(alarms.length, 2);
    for (const alarm of alarms) {
        assert.equal(alarm.periodInMinutes * 60, SAFARI_MINIMUM_ALARM_PERIOD_S, `${alarm.name} period`);
        // Safari clamps a first delay under 30 seconds up to 30.
        assert.ok(alarm.delayInMinutes * 60 >= SAFARI_MINIMUM_ALARM_PERIOD_S, `${alarm.name} first delay`);
    }
    const [first, second] = alarms.map((alarm) => alarm.delayInMinutes * 60).sort((a, b) => a - b);
    assert.equal(second - first, SAFARI_MINIMUM_ALARM_PERIOD_S / 2);
});

test("once the alarms are running, an extension event comes at least 15 seconds before Safari would unload the page", async () => {
    const { alarms } = loadBackground();
    await settle();
    // Each event restarts the unload timer. Before the first alarm, the page is
    // kept by loading: the alarms are created while it loads, so the first is due
    // before the unload that finishing the load sets.
    const events = firings(alarms, 600);
    let longestGap = 0;
    for (let index = 1; index < events.length; index += 1) {
        longestGap = Math.max(longestGap, events[index] - events[index - 1]);
    }
    assert.ok(SAFARI_UNLOAD_DELAY_S - longestGap >= 15, `longest gap between events ${longestGap} s`);
});

test("the alarms are created as the page loads, before anything it waits on", () => {
    // Safari unloads the page 30 seconds after it finishes loading. An alarm made
    // only after an answer (such as asking whether it exists) can be due after
    // that, and the page unloads before its first event.
    const { alarms } = loadBackground();
    assert.equal(alarms.length, 2, "made synchronously, before the page's first await");
});

test("either keepalive alarm reads which servers are running", async () => {
    const harness = loadBackground();
    await settle();
    const names = harness.alarms.map((alarm) => alarm.name);

    for (const name of names) {
        const before = harness.reads.length;
        await harness.fire(name);
        assert.equal(harness.reads.length, before + 1, `${name} read the tokens`);
    }
});

test("an alarm that isn't a keepalive reads nothing", async () => {
    const harness = loadBackground();
    await settle();
    const before = harness.reads.length;

    await harness.fire("someone-else");

    assert.equal(harness.reads.length, before);
});

test("both keepalive reads wait this page's own offset, so twice the reads doesn't bring back the collision", async () => {
    // Every profile's alarms fire in the same millisecond. Each page reading at
    // its own fixed point after them keeps two profiles' requests apart (#168).
    const harness = loadBackground();
    await settle();
    const pauses = [];
    for (const { name } of harness.alarms) pauses.push(...await harness.fire(name));

    assert.equal(pauses.length, harness.alarms.length);
    assert.equal(new Set(pauses).size, 1, `pauses ${pauses}`);
    assert.ok(pauses[0] >= 0 && pauses[0] < harness.spread);
});
