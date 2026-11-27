"use strict";

// Event listeners, the keepalive, token loading, and startup. Loaded last because this is the file that runs things.

// --- Utilities -------------------------------------------------------

// Every call that names no tab resolves its target here, so an unbounded wait
// on either line below puts the whole tool surface back on the 30-second bridge
// timeout that `handleTabsQuery` is deadlined to avoid. Neither call can be
// probed first, because the tab they are looking up is the thing being decided.
async function getActiveTabId(serverPort) {
    // Use the tab this server pinned with select_tab, if any
    const pin = await currentPin(serverPort);
    const pinned = pin ? pin.tabId : undefined;
    if (pinned !== undefined) {
        try {
            const tab = await withDeadline(browser.tabs.get(pinned), TAB_LISTING_TIMEOUT_MS);
            return tab.id;
        } catch (err) {
            // A tab parked on Safari's dialog is not a closed one. Falling
            // through here would drop the caller's pinned tab over a question
            // the user has not answered yet.
            if (err instanceof DeadlineExceeded) throw permissionRequiredError(null, true);
            // Falling through to the user's active tab here sent the next
            // untabbed `type_text` or `click` to whatever they happened to be
            // looking at. A pinned tab that is gone is an error the caller has
            // to hear about; one that failed for any other reason keeps its pin.
            if (await tabIsGone(pinned)) {
                pinnedTabs.delete(serverPort);
                persistPinnedTabs();
                throw tabClosedError(pinned);
            }
            throw err;
        }
    }
    return userActiveTabId();
}

// The pin on this port, if it was made by the server that is running there now.
// A pin from an earlier run is dropped, not carried over to a client that never
// chose it. Checked here, when a call arrives, and not when pins are restored,
// because a woken background page restores them before it has read the tokens.
async function currentPin(serverPort) {
    const pin = pinnedTabs.get(serverPort);
    if (!pin) return undefined;
    if (pin.run === await serverRunFingerprint(serverPort)) return pin;
    // Re-read: another call may have replaced the pin while the digest was out.
    if (pinnedTabs.get(serverPort) === pin) {
        pinnedTabs.delete(serverPort);
        persistPinnedTabs();
    }
    return undefined;
}

// The tab the user is looking at, whatever any server has pinned.
async function userActiveTabId() {
    let tabs;
    try {
        tabs = await withDeadline(
            browser.tabs.query({ active: true, currentWindow: true }),
            TAB_LISTING_TIMEOUT_MS
        );
    } catch (err) {
        if (!(err instanceof DeadlineExceeded)) throw err;
        // No origin to name: the block belongs to whichever tab Safari is
        // asking about, and that is the lookup that just failed.
        throw permissionRequiredError(null, true);
    }
    if (tabs.length === 0) throw new Error("No active tab found");
    return windowShowingTab(tabs).id;
}

// `tabs.get` rejects with a message that differs between browsers and says
// nothing a caller could branch on, so absence is confirmed against the list.
// Anything short of a clean "not in the list" counts as not gone: losing a pin
// over a listing that itself failed is the bug this exists to prevent.
async function tabIsGone(tabId) {
    try {
        const tabs = await withDeadline(browser.tabs.query({}), TAB_LISTING_TIMEOUT_MS);
        return !tabs.some((tab) => tab.id === tabId);
    } catch {
        return false;
    }
}

// --- Message Listener (from popup or content scripts) ----------------

// Entries expire on their own, but a long-lived background page would otherwise
// accumulate one per tab ever touched.
browser.tabs.onRemoved.addListener((tabId) => {
    tabAccessProbes.delete(tabId);
    clearAwaitingAccess(tabId);
    pageVisibilityReports.delete(tabId);
});

// Safari grants access per origin, so a pass stops meaning anything the moment
// the tab goes somewhere else. Keyed by tab alone, a `navigate` followed
// straight away by a read fitted inside the window and reused the old origin's
// grant, which put the read back on an unbounded wait for the new origin's
// dialog. Clearing here rather than reading the origin on every call keeps the
// hot path free of an extra `tabs.get`.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (!changeInfo.url) return;
    tabAccessProbes.delete(tabId);
    // The site that was waiting isn't this tab's any more.
    clearAwaitingAccess(tabId);
});

// A site the user allows may be reported here. The waits are dropped and the
// next call on each tab finds out for itself, marking it again if still refused.
if (browser.permissions && browser.permissions.onAdded) {
    browser.permissions.onAdded.addListener(() => {
        for (const tabId of [...tabsAwaitingAccess.keys()]) clearAwaitingAccess(tabId);
    });
}

// A tab coming to the front is what a `page_hidden` refusal asks for, whether
// `select_tab` or the user brought it there, so the retry probes afresh rather
// than being refused from the cache.
if (browser.tabs.onActivated) {
    browser.tabs.onActivated.addListener(({ tabId }) => {
        tabAccessProbes.delete(tabId);
    });
}

/// Whether MCPSafari can reach whatever the user is looking at.
///
/// Opening the popup is the right moment to find this out, and the right moment
/// for Safari to ask if it has not already: the user is looking straight at
/// MCPSafari, so a dialog about MCPSafari makes sense. The alternative is what
/// happens otherwise, which is the question surfacing mid-task, in a dialog that
/// can be behind another window, while an agent waits on it.
async function describeActiveTabAccess() {
    let tabId;
    try {
        // The tab in front, not a server's pinned one: the popup answers for
        // what the user is looking at.
        tabId = await userActiveTabId();
    } catch {
        return { origin: null, allowed: false, pending: false };
    }

    const origin = await originOfTab(tabId);
    try {
        await ensureTabAccess(tabId);
        return { origin, allowed: true, pending: false };
    } catch (err) {
        return {
            origin,
            allowed: false,
            pending: err.permissionPending === true,
            // Safari answered for the tab and the page did not. "No access"
            // would send the user to Settings over a page that is only busy.
            unresponsive: err.code === "page_hidden" || err.code === "page_not_responding",
        };
    }
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "refreshConnections") {
        loadAuthTokens().finally(() => {
            reconnectKnownPorts();
            sendResponse({ ports: visibleConnectionStatuses() });
        });
        return true;
    }
    if (message.type === "getStatus") {
        sendResponse({ ports: visibleConnectionStatuses() });
        return false;
    }
    if (message.type === "tabAccess") {
        describeActiveTabAccess().then(sendResponse);
        return true;
    }
    if (message.type === "addPort") {
        const port = parseInt(message.port, 10);
        if (port >= MIN_BRIDGE_PORT && port <= 65535) {
            ensurePort(port, true); // manual = true
            loadAuthTokens().finally(() => connectToPort(port));
            persistManualPorts();
        }
        sendResponse({ ok: true });
        return false;
    }
    if (message.type === "removePort") {
        const port = parseInt(message.port, 10);
        disconnectPort(port);
        manualPorts.delete(port);
        persistManualPorts();
        sendResponse({ ok: true });
        return false;
    }
    if (message.type === "reconnect") {
        // Reconnect a specific port, or only disconnected ports if no port specified
        if (message.port) {
            const port = parseInt(message.port, 10);
            staleTokensByPort.delete(port);
            const conn = ensurePort(port, manualPorts.has(port));
            if (conn && conn.ws) conn.ws.close();
            if (conn) conn.attempts = 0;
            loadAuthTokens().finally(() => connectToPort(port));
        } else {
            // Only reconnect ports that aren't already connected
            loadAuthTokens().finally(() => {
                reconnectKnownPorts();
            });
        }
        sendResponse({ ok: true });
        return false;
    }
    return false;
});

function persistManualPorts() {
    writeStorage("local", { manualPorts: [...manualPorts] });
}

// --- Keepalive -------------------------------------------------------

// How far apart the profiles' keepalive reads are spread. Each page picks its
// place once, so a profile keeps it, and two profiles' reads rarely overlap.
const KEEPALIVE_READ_SPREAD_MS = 2000;
const keepaliveReadOffsetMs = Math.floor(Math.random() * KEEPALIVE_READ_SPREAD_MS);

// Safari unloads this page 30 seconds after the last extension event, and an
// open WebSocket doesn't count as one. An alarm does: each one fires an event,
// which keeps the page loaded, and reads the token directory, which is how a
// newly started server is found. The alarm also resets backoff so the extension
// quickly reconnects when a new server starts (instead of waiting for a long
// backoff).
//
// Safari runs an alarm no more often than every 30 seconds, the same as its
// unload delay, so one alarm kept the page only by being due microseconds before
// the unload. Two alarms half a period apart put an event every 15 seconds, a
// 15-second margin that holds for any unload delay over 15, and find a new
// server twice as fast.
const KEEPALIVE_PERIOD_MINUTES = 0.5;
const KEEPALIVE_ALARMS = Object.freeze([
    { name: "mcp-keepalive", delayInMinutes: KEEPALIVE_PERIOD_MINUTES },
    { name: "mcp-keepalive-midway", delayInMinutes: KEEPALIVE_PERIOD_MINUTES * 1.5 },
]);

if (typeof browser.alarms !== "undefined") {
    // Created while the page loads, every time it loads, and not after asking
    // whether they exist: that answer can come after the load finishes, and
    // Safari sets the unload 30 seconds from then. Created here, the first alarm
    // is due a period from now, ahead of that unload, and the two keep the page
    // from there.
    for (const { name, delayInMinutes } of KEEPALIVE_ALARMS) {
        browser.alarms.create(name, { delayInMinutes, periodInMinutes: KEEPALIVE_PERIOD_MINUTES });
    }
    browser.alarms.onAlarm.addListener((alarm) => {
        if (KEEPALIVE_ALARMS.some(({ name }) => name === alarm.name)) {
            // A suppressed port is a pause, not a verdict. The only thing suppression
            // can know is that the dials since the last token read failed, and a
            // refusal says nothing about whether the server is coming back: anything
            // holding the server's handshake slots, or one slow start, produces
            // the same failures, and giving up for good on that left the extension
            // dark until it was restarted. The token file is the evidence a server
            // exists, so a port keeps being retried each time round for as long as
            // it is there, and `pruneRemovedTokenPorts` drops it when it is gone.
            staleTokensByPort.clear();
            expireAccessWaits();
            // Read a moment after the alarm rather than on it: Safari fires every
            // profile's alarm in the same millisecond, and of two native messages
            // in flight together it answers only one (see `loadAuthTokens`).
            delay(keepaliveReadOffsetMs).then(loadAuthTokens).finally(() => {
                // Was a second copy of this loop, which is how the give-up
                // threshold below ended up disagreeing with `scheduleReconnect`.
                reconnectKnownPorts();

                // Clean up discovered ports that have never connected or have been
                // disconnected for longer than AUTO_CLEANUP_MS
                const now = Date.now();
                for (const [port, conn] of connections) {
                    if (conn.manual) continue;
                    if (conn.state === "connected") continue;
                    if (conn.lastConnected === 0 && conn.attempts >= AUTO_GIVE_UP_ATTEMPTS) {
                        // Never connected: remove after a few failed attempts
                        suppressStaleTokenPort(port);
                    } else if (conn.disconnectedAt > 0 && (now - conn.disconnectedAt) > AUTO_CLEANUP_MS) {
                        // Gone for 2+ minutes. Measured from when the socket went
                        // away, not from when it authenticated: `lastConnected`
                        // is never refreshed, so reading it here suppressed any
                        // server that had simply been up longer than the grace
                        // period, the first time Safari suspended this page. The
                        // suppression then records the live token as stale and
                        // the server only mints a new one on restart, so the
                        // bridge went quiet until something was restarted.
                        suppressStaleTokenPort(port);
                    }
                }
            });
        }
    });
}

// --- Token Loading --------------------------------------------------

/** The token read in progress, which every caller shares. */
let tokenRead = null;

/**
 * Reads which servers are running, and dials any this page doesn't have yet.
 *
 * Safari loses a reply when two of MCPSafari's native messages are in flight at
 * once, from one profile or from two. Its log shows both requests going through
 * the same NSExtension object, and the earlier request's promise then never
 * settles. Every profile's keepalive alarm fires in the same millisecond, so
 * before this one profile missed each read at random, and found a new server a
 * minute or more after the others (#168). Hence one read per page at a time,
 * and each request sent under `NATIVE_REQUEST_POLICY`.
 */
function loadAuthTokens() {
    tokenRead ??= readAuthTokens().finally(() => { tokenRead = null; });
    return tokenRead;
}

/**
 * One message to the native handler, sent again when its reply is lost.
 *
 * The handler echoes the nonce, so a reply that names another one answers some
 * other request and is not taken for this one's. One with no nonce is from a
 * handler older than the echo, which can only be this request's.
 */
function askNativeHandler(message) {
    return withRetries(async (attempt) => {
        if (attempt > 1) console.warn(`[MCPSafari] Native reply lost; sending attempt ${attempt}`);
        const nonce = randomNonce();
        const reply = await browser.runtime.sendNativeMessage("com.epistates.MCPSafari.Extension", { ...message, nonce });
        if (reply?.nonce !== undefined && reply.nonce !== nonce) throw new ReplyLost("the reply answered another request");
        return reply;
    }, NATIVE_REQUEST_POLICY);
}

async function readAuthTokens() {
    try {
        const response = await askNativeHandler({ type: "getTokens" });
        if (response && typeof response.profile === "string" && response.profile) {
            profileId = response.profile;
        }
        // The handler answers `no_token_files` when the directory holds no valid
        // token, which is every server having stopped. That is an answer, not a
        // failure: ignoring it left the last servers' ports in the map for good.
        const tokens = response && response.tokens
            ? response.tokens
            : response && response.error === "no_token_files" ? {} : null;
        if (tokens) {
            authTokensByPort.clear();
            for (const [port, token] of Object.entries(tokens)) {
                const parsedPort = parseInt(port, 10);
                if (parsedPort >= MIN_BRIDGE_PORT && parsedPort <= 65535 && token) {
                    authTokensByPort.set(parsedPort, token);
                }
            }
            for (const port of staleTokensByPort.keys()) {
                if (!authTokensByPort.has(port)) staleTokensByPort.delete(port);
            }
            pruneRemovedTokenPorts();
            ensurePortsForKnownTokens();
            console.log(`[MCPSafari] Loaded ${authTokensByPort.size} auth token(s)`);
        } else {
            console.warn("[MCPSafari] Failed to load auth tokens:", response?.error || "unknown");
        }
    } catch (err) {
        console.warn("[MCPSafari] Native messaging unavailable for tokens:", err);
    }
}

// --- Initialize ------------------------------------------------------

// A badge from before this page was suspended describes waits it no longer knows.
setAccessBadge("", "MCPSafari");

Promise.all([loadAuthTokens(), restoreSessionState()]).then(() => {
    connectAll();
    console.log("[MCPSafari] Background script initialized");
});
