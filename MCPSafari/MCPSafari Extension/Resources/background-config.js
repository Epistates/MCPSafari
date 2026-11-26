"use strict";

// Ports, timeouts and the deadline helper every other file measures against.

/**
 * MCPSafari Extension Background Script
 *
 * WebSocket client that connects to the Swift MCP server.
 * Receives BridgeRequest messages, dispatches to browser APIs or content scripts,
 * and sends BridgeResponse messages back.
 */

const BRIDGE_PROTOCOL_VERSION = 2;
const EXTENSION_VERSION = browser.runtime.getManifest().version;
// The most ports dialled on the strength of a token file alone. There is no port
// range to configure here: a server writes a token file for the port it bound,
// wherever that is, and the extension dials every port that has one. This only
// bounds the connection objects a token directory full of files can create. It
// matches the most ports one server will try (`--port-range`), so any range the
// server accepts is found. Ports added in the popup are not counted.
const MAX_DISCOVERED_PORTS = 64;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 5000;
const AUTO_CLEANUP_MS = 120_000;
// How many failed attempts a discovered port that has never answered gets
// before it is left alone. One home for it: the two places that read it had
// drifted to `>= 3` and `> 3`, so whether a port survived its fourth failure
// depended on which one happened to look first.
const AUTO_GIVE_UP_ATTEMPTS = 3;
const DEFAULT_PROFILE_ID = "default";

// --- Website permission gating ---------------------------------------
//
// Safari asks for website access with a modal dialog the first time the
// extension touches an origin, and blocks every extension API for that tab
// until the dialog is answered. The dialog can open behind another window,
// where nobody knows it is there, so "blocked" lasts as long as it takes
// someone to find it.
//
// Without a deadline that call rides the server's 30-second bridge timeout and
// the agent is told the bridge timed out. That is not what happened, it is not
// something a retry fixes, and it names none of the one action that would fix
// it. So every tab-touching call is probed first with a cheap injection, and a
// probe that stalls or fails becomes a named `permission_required`.
//
// `permissions.contains` cannot do this job on Safari: it reports what the
// manifest asked for rather than what the user granted, so it answers true for
// origins with no access. Probing with a real call is the only reliable test.
const PERMISSION_PROBE_TIMEOUT_MS = 2000;
// For gated calls that are quick when permitted and so can be deadlined
// directly, without the extra round trip a probe costs.
const PERMISSION_DEADLINE_MS = 10_000;
// A probe or capture that runs out of time is not always the dialog: a page
// Safari is not showing, or a busy one, misses the deadline too. While the
// dialog is open Safari holds `tabs.get` as well, so the tab is read once more
// to tell the two apart. It answers in milliseconds when nothing holds it.
const DIALOG_CHECK_MS = 1000;
// Listing tabs blocks on the same dialog, and no per-tab probe helps because the
// block is not attributable to one tab. Measured against real Safari, a listing
// held up this way still completes, in around nine seconds, so this sits just
// under the bridge timeout rather than anywhere near that. A deadline tight
// enough to catch the slow case turns a listing that would have arrived into a
// failure, and tabs_context is the call every session starts with.
const TAB_LISTING_TIMEOUT_MS = 25_000;
// Long enough to spare the per-frame calls within one request a probe each,
// short enough that granting access is picked up on the next retry.
const PERMISSION_CACHE_MS = 2000;

/**
 * tabId to its last probe: when it landed, and what it threw if it failed.
 *
 * Failures are remembered too. Only successes were, so the blocked case, which
 * is the one this cache exists for, probed again on every call: a frame search
 * over eight frames paid a probe each and ran past the server's 30-second
 * timeout, reporting the generic failure the gating was written to replace.
 *
 * @type {Map<number, {at: number, error: Error|null}>}
 */
const tabAccessProbes = new Map();

class DeadlineExceeded extends Error {}

function withDeadline(promise, ms) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new DeadlineExceeded()), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- Retrying a lost reply -------------------------------------------

/** A reply that did not come, or came and answered some other request. */
class ReplyLost extends Error {}

/**
 * How native messages are retried. Safari loses the reply to one of two native
 * messages in flight at once (#168), and the lost one's promise never settles.
 * A running handler answers in tens of milliseconds and a cold start of the app
 * extension in a few hundred, so a reply later than the deadline is taken as lost.
 */
const NATIVE_REQUEST_POLICY = Object.freeze({
    deadlineMs: 1500,
    attempts: 3,
    minPauseMs: 100,
    maxPauseMs: 500,
});

/**
 * The answer to the first of `policy.attempts` sends that gets one.
 *
 * Each call of `attempt` (given its 1-based number) is a fresh send. One that
 * runs past `policy.deadlineMs`, or rejects with `ReplyLost`, is lost, and the
 * next goes out after a pause drawn at random from the policy's range, so two
 * pages that lost their replies together don't send again together. Any other
 * failure is passed on at once, because sending again can't fix it. Rejects with
 * `ReplyLost` when every attempt is lost.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} attempt
 * @param {{deadlineMs: number, attempts: number, minPauseMs: number, maxPauseMs: number}} policy
 * @param {() => number} random
 * @returns {Promise<T>}
 */
async function withRetries(attempt, policy, random = Math.random) {
    for (let number = 1; ; number += 1) {
        try {
            return await withDeadline(attempt(number), policy.deadlineMs);
        } catch (err) {
            if (!(err instanceof DeadlineExceeded || err instanceof ReplyLost)) throw err;
        }
        if (number >= policy.attempts) throw new ReplyLost(`no reply to ${number} attempts`);
        await delay(policy.minPauseMs + random() * (policy.maxPauseMs - policy.minPauseMs));
    }
}

