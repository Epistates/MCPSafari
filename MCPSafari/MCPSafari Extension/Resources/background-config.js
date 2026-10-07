"use strict";

// Ports, timeouts and the deadline helper every other file measures against.

/**
 * MCPSafari Extension Background Script
 *
 * WebSocket client that connects to the Swift MCP server.
 * Receives BridgeRequest messages, dispatches to browser APIs or content scripts,
 * and sends BridgeResponse messages back.
 */

const DEFAULT_PORT = 8089;
const BRIDGE_PROTOCOL_VERSION = 1;
const EXTENSION_VERSION = browser.runtime.getManifest().version;
const AUTO_SCAN_RANGE = 10; // Ports 8089-8098 are auto-managed
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 5000;
const AUTO_CLEANUP_MS = 120_000;
// How many failed attempts an auto-scanned port that has never answered gets
// before it is left alone. One home for it: the two places that read it had
// drifted to `>= 3` and `> 3`, so whether a port survived its fourth failure
// depended on which one happened to look first.
const AUTO_GIVE_UP_ATTEMPTS = 3;
const DEFAULT_PROFILE_ID = "default";

// ─── Website permission gating ───────────────────────────────────────
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

