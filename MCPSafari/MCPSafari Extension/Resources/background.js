"use strict";

// Event listeners, the keepalive, token loading, and startup. Loaded last because this is the file that runs things.

// ─── Utilities ───────────────────────────────────────────────────────

// Every call that names no tab resolves its target here, so an unbounded wait
// on either line below puts the whole tool surface back on the 30-second bridge
// timeout that `handleTabsQuery` is deadlined to avoid. Neither call can be
// probed first, because the tab they are looking up is the thing being decided.
async function getActiveTabId() {
    // Use pinned tab if set via select_tab
    if (selectedTabId !== null) {
        try {
            const tab = await withDeadline(browser.tabs.get(selectedTabId), TAB_LISTING_TIMEOUT_MS);
            return tab.id;
        } catch (err) {
            // A tab parked on Safari's dialog is not a closed one. Falling
            // through here would drop the caller's pinned tab over a question
            // the user has not answered yet.
            if (err instanceof DeadlineExceeded) throw permissionRequiredError(null, true);
            // Tab was closed, clear selection
            selectedTabId = null;
            persistSelectedTab(null);
        }
    }
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
    return tabs[0].id;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Message Listener (from popup or content scripts) ────────────────

// Entries expire on their own, but a long-lived background page would otherwise
// accumulate one per tab ever touched.
browser.tabs.onRemoved.addListener((tabId) => {
    tabAccessProbes.delete(tabId);
});

// Safari grants access per origin, so a pass stops meaning anything the moment
// the tab goes somewhere else. Keyed by tab alone, a `navigate` followed
// straight away by a read fitted inside the window and reused the old origin's
// grant, which put the read back on an unbounded wait for the new origin's
// dialog. Clearing here rather than reading the origin on every call keeps the
// hot path free of an extra `tabs.get`.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) tabAccessProbes.delete(tabId);
});

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
        tabId = await getActiveTabId();
    } catch {
        return { origin: null, allowed: false, pending: false };
    }

    const origin = await originOfTab(tabId);
    try {
        await ensureTabAccess(tabId);
        return { origin, allowed: true, pending: false };
    } catch (err) {
        return { origin, allowed: false, pending: err.permissionPending === true };
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
        if (port >= 1024 && port <= 65535) {
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
    try {
        if (browser.storage && browser.storage.local) {
            browser.storage.local.set({ manualPorts: [...manualPorts] });
        }
    } catch (_) { /* ignore */ }
}

// ─── Service Worker Keepalive ─────────────────────────────────────────

// Service workers get suspended after ~30s of inactivity.
// Use alarms to periodically wake and ensure WebSocket stays connected.
// The alarm also resets backoff so the extension quickly reconnects when
// a new server starts (instead of waiting for a long backoff to expire).
if (typeof browser.alarms !== "undefined") {
    browser.alarms.create("mcp-keepalive", { periodInMinutes: 0.4 }); // ~24s
    browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === "mcp-keepalive") {
            loadAuthTokens().finally(() => {
                // Was a second copy of this loop, which is how the give-up
                // threshold below ended up disagreeing with `scheduleReconnect`.
                reconnectKnownPorts();

                // Clean up auto-scan ports that have never connected or have been
                // disconnected for longer than AUTO_CLEANUP_MS
                const now = Date.now();
                for (const [port, conn] of connections) {
                    if (conn.manual) continue;
                    if (!isAutoScanPort(port)) continue;
                    if (conn.state === "connected") continue;
                    if (conn.lastConnected === 0 && conn.attempts >= AUTO_GIVE_UP_ATTEMPTS) {
                        // Never connected — remove after a few failed attempts
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

// ─── Token Loading ──────────────────────────────────────────────────

async function loadAuthTokens() {
    try {
        const response = await browser.runtime.sendNativeMessage(
            "com.epistates.MCPSafari.Extension",
            { type: "getTokens" }
        );
        if (response && typeof response.profile === "string" && response.profile) {
            profileId = response.profile;
        }
        if (response && response.tokens) {
            authTokensByPort.clear();
            legacyAuthToken = null;
            for (const [port, token] of Object.entries(response.tokens)) {
                const parsedPort = parseInt(port, 10);
                if (parsedPort >= 1024 && parsedPort <= 65535 && token) {
                    authTokensByPort.set(parsedPort, token);
                }
            }
            for (const port of staleTokensByPort.keys()) {
                if (!authTokensByPort.has(port)) staleTokensByPort.delete(port);
            }
            ensurePortsForKnownTokens();
            console.log(`[MCPSafari] Loaded ${authTokensByPort.size} auth token(s)`);
        } else if (response && response.token) {
            authTokensByPort.clear();
            legacyAuthToken = response.token;
            console.log("[MCPSafari] Legacy auth token loaded");
        } else {
            console.warn("[MCPSafari] Failed to load auth tokens:", response?.error || "unknown");
        }
    } catch (err) {
        console.warn("[MCPSafari] Native messaging unavailable for tokens:", err);
    }
}

// ─── Initialize ──────────────────────────────────────────────────────

Promise.all([loadAuthTokens(), restoreSessionState()]).then(() => {
    connectAll();
    console.log("[MCPSafari] Background script initialized");
});
