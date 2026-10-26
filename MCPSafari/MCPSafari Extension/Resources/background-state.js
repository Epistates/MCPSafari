"use strict";

// Connection, profile and tab state, and the website-access checks that read it.

// ─── Multi-Connection State ──────────────────────────────────────────
// Ports are discovered from the token files the servers write, one per port they
// bound, so there is no range to scan and none to keep in step with the server's
// `--port-range`. A port that has a token gets a connection; one whose token is
// gone loses it (see `pruneRemovedTokenPorts`), and one that never answers is
// given up on after AUTO_GIVE_UP_ATTEMPTS or AUTO_CLEANUP_MS.
// Manually added ports are persisted in storage.local across restarts.

/** @type {Map<number, {ws: WebSocket|null, state: string, attempts: number, manual: boolean, lastConnected: number}>} */
const connections = new Map();
/** @type {Set<number>} Manually added ports (persisted across restarts) */
const manualPorts = new Set();
let selectedTabId = null;
// Safari runs a separate instance of this extension per profile, each with its own
// background page reading the same tokens. Without an identity in the handshake every
// instance looks like the same client, and the server evicts whichever one connected
// first. The appex reads it from SFExtensionProfileKey; "default" means Safari sent none.
let profileId = DEFAULT_PROFILE_ID;
const authTokensByPort = new Map();
const staleTokensByPort = new Map();

function toolErrorFromResponse(response) {
    const error = new Error(response.error);
    error.code = typeof response.errorCode === "string"
        ? response.errorCode
        : "extension_error";
    error.retryable = response.retryable === true;
    error.recoveryAction = typeof response.recoveryAction === "string"
        ? response.recoveryAction
        : "inspect_error";
    return error;
}

// Two different situations, and the difference is the whole point: a dialog the
// user has not seen yet, versus access they have already been refused. Both are
// retryable, because in both cases a grant makes the same call work.
function permissionRequiredError(origin, pending) {
    const site = origin ? `this tab (${origin})` : "this tab";
    const error = new Error(
        pending
            ? `MCPSafari needs the user to allow access to ${site}. Safari is showing a `
              + `permission dialog that blocks every call for this tab until it is answered, and `
              + `it can sit behind another window. Ask the user to find it and choose "Always `
              + `Allow on This Website", then retry.`
            : `MCPSafari is not allowed on ${site}. Ask the user to grant it from the MCPSafari `
              + `button in Safari's toolbar, or in Safari Settings > Extensions > MCPSafari `
              + `Extension, where "Always Allow on Every Website" also stops the per-site `
              + `asking. Then retry.`
    );
    error.code = "permission_required";
    error.retryable = true;
    error.recoveryAction = "ask_user";
    // Carried rather than sniffed back out of the message: the popup needs to
    // tell "Safari is asking right now" from "Safari has been told no".
    error.permissionPending = pending;
    return error;
}

// The tab `select_tab` pinned is gone. Not retryable as it stands: repeating the
// call finds the same absence, and the caller has to choose a tab again.
function tabClosedError(tabId) {
    const error = new Error(
        `The tab pinned with select_tab (id ${tabId}) no longer exists, so this call was not run. `
        + `Call tabs_context to list the open tabs, then select_tab again.`
    );
    error.code = "tab_closed";
    error.retryable = false;
    error.recoveryAction = "call_tabs_context";
    return error;
}

// The origin is what Safari grants by, so it is the unit anything asking the
// user to grant something has to speak in. Also the part of a URL with no
// secrets in it, which is why unreachable frames are named this way.
function originOfUrl(url) {
    try {
        if (!url) return null;
        // An opaque origin (about:, data:, file:, a sandboxed frame) serialises
        // to the string "null", which would reach the user looking like a
        // hostname they could go and grant. There is nothing to grant.
        const origin = new URL(url).origin;
        return origin && origin !== "null" ? origin : null;
    } catch {
        return null;
    }
}

// Best effort, and deliberately not fatal: the origin only sharpens the message,
// and reading it goes through the same APIs that may already be blocked.
async function originOfTab(tabId) {
    try {
        const tab = await withDeadline(browser.tabs.get(tabId), PERMISSION_PROBE_TIMEOUT_MS);
        return tab ? originOfUrl(tab.url) : null;
    } catch {
        return null;
    }
}

// For a call that is already permission-gated and already expected to be quick.
// Cheaper than a probe, since it adds no round trip, but only safe where the
// operation has no legitimate reason to run long.
async function withPermissionDeadline(promise, tabId, ms = PERMISSION_DEADLINE_MS) {
    try {
        return await withDeadline(promise, ms);
    } catch (err) {
        if (!(err instanceof DeadlineExceeded)) throw err;
        throw permissionRequiredError(await originOfTab(tabId), true);
    }
}

// Injected into the tab to prove it can be reached at all, so it must not close
// over anything here. Named rather than inline so a caller reading a trace can
// tell a probe from real work.
function probeTabAccess() {
    return true;
}

// Cheapest call that proves the extension can actually reach this tab. It also
// raises Safari's dialog when there is no decision yet, which is wanted: the
// user cannot answer a question nobody asked.
async function ensureTabAccess(tabId) {
    const cached = tabAccessProbes.get(tabId);
    if (cached && Date.now() - cached.at < PERMISSION_CACHE_MS) {
        if (cached.error) throw cached.error;
        return;
    }

    // Read the origin first. The probe below is what raises Safari's dialog, and
    // once that dialog is up `tabs.get` blocks on it as well, so asking
    // afterwards returns nothing and the refusal cannot name the site it is
    // about. Measured against real Safari, which is the only place this shows.
    const origin = await originOfTab(tabId);

    try {
        await withDeadline(
            browser.scripting.executeScript({ target: { tabId }, func: probeTabAccess }),
            PERMISSION_PROBE_TIMEOUT_MS
        );
        tabAccessProbes.set(tabId, { at: Date.now(), error: null });
        rememberOriginAccess(origin, true);
    } catch (err) {
        const refusal = permissionRequiredError(origin, err instanceof DeadlineExceeded);
        tabAccessProbes.set(tabId, { at: Date.now(), error: refusal });
        rememberOriginAccess(origin, false);
        throw refusal;
    }
}

/**
 * Origins a probe has found reachable. This is the only thing that can say a
 * tab's site is granted without raising Safari's dialog, which is what a tab
 * listing needs: it describes many tabs at once, and probing each would open a
 * dialog per undecided site. Anything not in here is treated as not granted.
 *
 * `permissions.contains` is no help (see the note in background-config.js), and
 * the tabs API returns a URL and title for every tab whether or not its site
 * was granted, so neither of those can tell the two apart.
 *
 * Learned by `ensureTabAccess` and dropped the moment it is refused. Kept in
 * local storage, so it survives a suspended background page and a Safari
 * restart, and bounded: insertion order is recency of confirmation, oldest
 * first, and the oldest is evicted past MAX_GRANTED_ORIGINS. A site the user
 * revokes in Safari Settings stays in here until a call to it is refused.
 *
 * @type {Set<string>}
 */
const grantedOrigins = new Set();
const MAX_GRANTED_ORIGINS = 500;

function rememberOriginAccess(origin, granted) {
    if (!origin) return;
    if (!granted) {
        if (grantedOrigins.delete(origin)) persistGrantedOrigins();
        return;
    }
    // Re-adding moves it to the recent end. Only a change in what is stored is
    // written: a probe lands on most calls, and its order alone is not worth a
    // storage write.
    const known = grantedOrigins.delete(origin);
    grantedOrigins.add(origin);
    let evicted = false;
    while (grantedOrigins.size > MAX_GRANTED_ORIGINS) {
        grantedOrigins.delete(grantedOrigins.values().next().value);
        evicted = true;
    }
    if (!known || evicted) persistGrantedOrigins();
}

function failureResponse(id, error, resolvedTabId = null) {
    return {
        id,
        success: false,
        data: null,
        error: String(error.message || error),
        errorCode: typeof error.code === "string" ? error.code : "extension_error",
        retryable: error.retryable === true,
        recoveryAction: typeof error.recoveryAction === "string"
            ? error.recoveryAction
            : "inspect_error",
        resolvedTabId,
    };
}

function ensurePort(port, manual = false) {
    if (!connections.has(port)) {
        connections.set(port, {
            ws: null,
            state: "disconnected",
            attempts: 0,
            manual,
            lastConnected: 0,
            // When the socket last went away, which is a different question from
            // when it last authenticated. The cleanup below wants "how long has
            // this server been gone", and `lastConnected` cannot answer it.
            disconnectedAt: 0,
        });
    }
    if (manual) {
        const conn = connections.get(port);
        conn.manual = true;
        manualPorts.add(port);
    }
    return connections.get(port);
}

/** How many connections exist only because a token file named their port. */
function discoveredPortCount() {
    let count = 0;
    for (const conn of connections.values()) {
        if (!conn.manual) count++;
    }
    return count;
}

