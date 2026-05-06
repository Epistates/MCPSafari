/**
 * MCPSafari Extension Background Script
 *
 * WebSocket client that connects to the Swift MCP server.
 * Receives BridgeRequest messages, dispatches to browser APIs or content scripts,
 * and sends BridgeResponse messages back.
 */

const DEFAULT_PORT = 8089;
const AUTO_SCAN_RANGE = 10; // Ports 8089-8098 are auto-managed
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 5000;
const AUTO_CLEANUP_MS = 120_000;

// ─── Multi-Connection State ──────────────────────────────────────────
// All ports in the scan range (8089-8098) are initialized at startup.
// The extension tries to connect to each — servers that exist get connected,
// absent ports stay disconnected and are cleaned up after AUTO_CLEANUP_MS.
// Manually added ports are persisted in storage.local across restarts.

/** @type {Map<number, {ws: WebSocket|null, state: string, attempts: number, manual: boolean, lastConnected: number}>} */
const connections = new Map();
/** @type {Set<number>} Manually added ports (persisted across restarts) */
const manualPorts = new Set();
let selectedTabId = null;
let legacyAuthToken = null;
const authTokensByPort = new Map();

function ensurePort(port, manual = false) {
    if (!connections.has(port)) {
        connections.set(port, { ws: null, state: "disconnected", attempts: 0, manual, lastConnected: 0 });
    }
    if (manual) {
        const conn = connections.get(port);
        conn.manual = true;
        manualPorts.add(port);
    }
    return connections.get(port);
}

function isAutoScanPort(port) {
    return port >= DEFAULT_PORT && port < DEFAULT_PORT + AUTO_SCAN_RANGE;
}

// ─── WebSocket Connection ────────────────────────────────────────────

function connectToPort(port) {
    const conn = ensurePort(port);
    if (conn.ws && (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)) return;

    // Security: every server instance requires its per-port auth token.
    const authToken = authTokensByPort.get(port) || legacyAuthToken;
    if (!authToken) {
        conn.state = "disconnected";
        return; // Skip — can't verify server identity without auth
    }

    conn.state = "connecting";
    const wsUrl = `ws://localhost:${port}`;
    const socket = new WebSocket(wsUrl);
    conn.ws = socket;

    let pendingAuth = true;

    socket.onopen = () => {
        socket.send(JSON.stringify({ auth: authToken }));
        console.log(`[MCPSafari:${port}] Sent auth token`);
    };

    socket.onmessage = async (event) => {
        if (pendingAuth) {
            pendingAuth = false;
            try {
                const msg = JSON.parse(event.data);
                if (msg.auth === "ok") {
                    conn.lastConnected = Date.now();
                    conn.state = "connected";
                    conn.attempts = 0;
                    console.log(`[MCPSafari:${port}] Authenticated`);
                } else {
                    console.error(`[MCPSafari:${port}] Auth rejected`);
                    socket.close();
                }
            } catch (err) {
                console.error(`[MCPSafari:${port}] Invalid auth response:`, err);
                socket.close();
            }
            return;
        }

        let request;
        try {
            request = JSON.parse(event.data);
        } catch (_) { return; }

        try {
            const response = await handleRequest(request);
            socket.send(JSON.stringify(response));
        } catch (err) {
            console.error(`[MCPSafari:${port}] Error:`, err);
            socket.send(JSON.stringify({
                id: request.id,
                success: false,
                error: String(err),
                data: null,
            }));
        }
    };

    socket.onclose = () => {
        conn.state = "disconnected";
        conn.ws = null;
        scheduleReconnect(port);
    };

    socket.onerror = () => { /* logged by onclose */ };
}

function scheduleReconnect(port) {
    const conn = ensurePort(port);
    const delayMs = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, conn.attempts),
        RECONNECT_MAX_MS
    );
    conn.attempts++;
    setTimeout(() => connectToPort(port), delayMs);
}

function connectAll() {
    for (const port of connections.keys()) {
        connectToPort(port);
    }
}

function reconnectKnownPorts() {
    for (const [port, conn] of connections) {
        if (conn.ws && conn.ws.readyState === WebSocket.OPEN) continue;

        if (conn.lastConnected > 0 || conn.manual || authTokensByPort.has(port)) {
            conn.attempts = 0;
        }
        connectToPort(port);
    }
}

function ensurePortsForKnownTokens() {
    for (const port of authTokensByPort.keys()) {
        if (isAutoScanPort(port) || manualPorts.has(port)) {
            ensurePort(port, manualPorts.has(port));
        }
    }
}

function disconnectPort(port) {
    const conn = connections.get(port);
    if (conn) {
        if (conn.ws) conn.ws.close();
        connections.delete(port);
    }
}

function visibleConnectionStatuses() {
    const ports = [];
    for (const [port, conn] of connections) {
        // Only surface connections worth showing:
        // - Currently connected or attempting an authenticated connection
        // - Manually added by the user
        // - Auto-scan ports with a known token or previous connection
        const isVisible = conn.state === "connected"
            || conn.state === "connecting"
            || conn.manual
            || (isAutoScanPort(port) && (authTokensByPort.has(port) || conn.lastConnected > 0));
        if (!isVisible) continue;
        ports.push({ port, state: conn.state, manual: conn.manual });
    }
    return ports;
}

// ─── Request Router ──────────────────────────────────────────────────

async function handleRequest(request) {
    const { id, action, params = {} } = request;

    try {
        let data;

        switch (action) {
            // Tab management
            case "tabs_query":
                data = await handleTabsQuery();
                break;
            case "tabs_create":
                data = await handleTabsCreate(params);
                break;
            case "tabs_close":
                data = await handleTabsClose(params);
                break;
            case "select_tab":
                data = await handleSelectTab(params);
                break;

            // Navigation
            case "navigate":
                data = await handleNavigate(params);
                break;

            // Page reading (delegated to content script)
            case "read_page":
            case "get_page_text":
            case "snapshot":
            case "find":
            case "click":
            case "type_text":
            case "form_input":
            case "select_option":
            case "scroll":
            case "press_key":
            case "hover":
            case "drag":
            case "wait":
            case "start_trace":
            case "stop_trace":
            case "get_console_messages":
            case "get_network_requests":
                data = await sendToContentScript(params.tabId, {
                    action,
                    params,
                });
                break;

            // Console (proxy to content script)
            case "read_console":
                data = await sendToContentScript(params.tabId, {
                    action: "get_console_messages",
                    params: {
                        level: params.level || "all",
                        pattern: params.pattern || null,
                        clear: params.clear || false,
                    },
                });
                break;

            // Network (proxy to content script)
            case "read_network":
                data = await sendToContentScript(params.tabId, {
                    action: "get_network_requests",
                    params: {
                        type: params.type || "all",
                        clear: params.clear || false,
                    },
                });
                break;

            // Screenshot
            case "screenshot":
                data = await handleScreenshot(params);
                break;

            // JavaScript execution
            case "javascript_tool":
                data = await handleJavaScript(params);
                break;

            // Window
            case "resize_window":
                data = await handleResizeWindow(params);
                break;

            // Dialog handling (delegated to content script via dialog-interceptor.js)
            case "handle_dialog":
                data = await sendToContentScript(params.tabId, {
                    action: "handle_dialog",
                    params,
                });
                break;

            default:
                return {
                    id,
                    success: false,
                    error: `Unknown action: ${action}`,
                    data: null,
                };
        }

        return {
            id,
            success: true,
            data: typeof data === "string" ? data : JSON.stringify(data),
            error: null,
        };
    } catch (err) {
        return {
            id,
            success: false,
            error: String(err.message || err),
            data: null,
        };
    }
}

// ─── Tab Handlers ────────────────────────────────────────────────────

async function handleTabsQuery() {
    const tabs = await browser.tabs.query({});
    return tabs.map((t) => ({
        id: t.id,
        url: t.url || "",
        title: t.title || "",
        active: t.active,
        pinned: t.pinned || false,
        audible: t.audible || false,
        muted: t.mutedInfo ? t.mutedInfo.muted : false,
        status: t.status || "complete",
        windowId: t.windowId,
        index: t.index,
    }));
}

async function handleTabsCreate(params) {
    const opts = {};
    if (params.url) opts.url = params.url;
    const tab = await browser.tabs.create(opts);
    return {
        id: tab.id,
        url: tab.url || params.url || "",
        title: tab.title || "",
    };
}

async function handleTabsClose(params) {
    await browser.tabs.remove(params.tabId);
    // Clear selected tab if it was closed
    if (selectedTabId === params.tabId) {
        selectedTabId = null;
        persistSelectedTab(null);
    }
    return `Closed tab ${params.tabId}`;
}

async function handleSelectTab(params) {
    const tabId = params.tabId;
    const tab = await browser.tabs.get(tabId);
    selectedTabId = tabId;
    persistSelectedTab(tabId);

    // Optionally bring to front
    if (params.bringToFront !== false) {
        await browser.tabs.update(tabId, { active: true });
        await browser.windows.update(tab.windowId, { focused: true });
    }

    return {
        id: tab.id,
        url: tab.url || "",
        title: tab.title || "",
        selected: true,
    };
}

function persistSelectedTab(tabId) {
    try {
        if (browser.storage && browser.storage.session) {
            browser.storage.session.set({ selectedTabId: tabId });
        }
    } catch (_) { /* storage may not be available */ }
}

async function restoreSessionState() {
    // Restore manually added ports (persists across Safari restarts)
    try {
        if (browser.storage && browser.storage.local) {
            const data = await browser.storage.local.get("manualPorts");
            if (data.manualPorts && Array.isArray(data.manualPorts)) {
                for (const port of data.manualPorts) {
                    ensurePort(port, true);
                }
            }
        }
    } catch (_) { /* ignore */ }

    // Restore selected tab (session-only — lost on Safari restart)
    try {
        if (browser.storage && browser.storage.session) {
            const data = await browser.storage.session.get("selectedTabId");
            if (data.selectedTabId != null) {
                try {
                    await browser.tabs.get(data.selectedTabId);
                    selectedTabId = data.selectedTabId;
                } catch {
                    await browser.storage.session.remove("selectedTabId");
                }
            }
        }
    } catch (_) { /* ignore */ }

    // Initialize all ports in the auto-scan range.
    // connectAll() will attempt each — servers that exist get connected,
    // absent ports fail silently and are cleaned up by the alarm.
    for (let offset = 0; offset < AUTO_SCAN_RANGE; offset++) {
        ensurePort(DEFAULT_PORT + offset);
    }
}

// ─── Navigation Handler ─────────────────────────────────────────────

async function handleNavigate(params) {
    const tabId = params.tabId || (await getActiveTabId());
    const action = params.action || "goto";
    const beforeTab = await browser.tabs.get(tabId);

    let message;
    let tab;
    switch (action) {
        case "goto":
            if (!params.url) throw new Error("URL required for 'goto' action");
            const gotoComplete = waitForTabLoad(tabId, beforeTab);
            await browser.tabs.update(tabId, { url: params.url });
            tab = await gotoComplete;
            message = "Navigated to";
            break;

        case "back":
            const backComplete = waitForTabLoad(tabId, beforeTab);
            await browser.scripting.executeScript({
                target: { tabId },
                func: () => history.back(),
            });
            tab = await backComplete;
            message = "Navigated back to";
            break;

        case "forward":
            const forwardComplete = waitForTabLoad(tabId, beforeTab);
            await browser.scripting.executeScript({
                target: { tabId },
                func: () => history.forward(),
            });
            tab = await forwardComplete;
            message = "Navigated forward to";
            break;

        case "reload":
            const reloadComplete = waitForTabLoad(tabId, beforeTab);
            await browser.tabs.reload(tabId);
            tab = await reloadComplete;
            message = "Reloaded";
            break;

        default:
            throw new Error(`Unknown navigation action: ${action}`);
    }

    // Return tab info so the caller knows where they landed
    tab = tab || (await browser.tabs.get(tabId));
    return `${message} ${tab.url || ""} (${tab.title || ""})`
}

async function waitForTabLoad(tabId, beforeTab, timeoutMs = 15000) {
    const beforeUrl = beforeTab?.url || "";
    let sawNavigation = false;

    return new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            browser.tabs.onUpdated.removeListener(onUpdated);
            clearTimeout(timer);
        };

        const settle = async () => {
            if (settled) return;
            settled = true;
            cleanup();
            try {
                resolve(await browser.tabs.get(tabId));
            } catch (err) {
                reject(err);
            }
        };

        const onUpdated = (updatedTabId, changeInfo, tab) => {
            if (updatedTabId !== tabId) return;

            if (changeInfo.status === "loading" || (changeInfo.url && changeInfo.url !== beforeUrl)) {
                sawNavigation = true;
            }

            if (changeInfo.status === "complete" && (sawNavigation || (tab.url || "") !== beforeUrl)) {
                settle();
            }
        };

        const timer = setTimeout(settle, timeoutMs);
        browser.tabs.onUpdated.addListener(onUpdated);
    });
}

// ─── Screenshot Handler ─────────────────────────────────────────────

async function handleScreenshot(params) {
    const tabId = params.tabId || (await getActiveTabId());
    const tab = await browser.tabs.get(tabId);

    // captureVisibleTab captures the active tab in a window
    if (!tab.active) {
        await browser.tabs.update(tabId, { active: true });
        await delay(300);
    }

    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
    });
    // Strip data URI prefix, return raw base64
    return dataUrl.replace(/^data:image\/\w+;base64,/, "");
}

// ─── JavaScript Execution Handler ────────────────────────────────────

async function handleJavaScript(params) {
    const tabId = params.tabId || (await getActiveTabId());
    const results = await browser.scripting.executeScript({
        target: { tabId },
        func: (code) => {
            try {
                const expressionCode = String(code).trim().replace(/;+$/, "");
                let fn;
                try {
                    fn = new Function(`return (async () => (${expressionCode}))()`);
                } catch (_) {
                    fn = new Function(`return (async () => { ${code} })()`);
                }
                return fn();
            } catch (e) {
                return { __error: e.message };
            }
        },
        args: [params.code],
        world: "MAIN",
    });

    if (results && results.length > 0) {
        const result = results[0].result;
        if (result && result.__error) {
            throw new Error(result.__error);
        }
        return result !== undefined ? JSON.stringify(result) : "undefined";
    }
    return "undefined";
}

// ─── Window Resize Handler ───────────────────────────────────────────

async function handleResizeWindow(params) {
    const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true,
    });
    if (tabs.length === 0) throw new Error("No active window");
    await browser.windows.update(tabs[0].windowId, {
        width: params.width,
        height: params.height,
    });
    return `Resized window to ${params.width}x${params.height}`;
}

// ─── Content Script Communication ────────────────────────────────────

async function sendToContentScript(tabId, message) {
    const resolvedTabId = tabId || (await getActiveTabId());

    try {
        const response = await browser.tabs.sendMessage(resolvedTabId, message);
        if (response && response.error) {
            throw new Error(response.error);
        }
        return response ? response.data : null;
    } catch (err) {
        // Content script might not be injected yet
        if (
            err.message &&
            (err.message.includes("Could not establish connection") ||
                err.message.includes("Receiving end does not exist"))
        ) {
            await injectContentScripts(resolvedTabId);
            const response = await browser.tabs.sendMessage(
                resolvedTabId,
                message
            );
            if (response && response.error) {
                throw new Error(response.error);
            }
            return response ? response.data : null;
        }
        throw err;
    }
}

async function injectContentScripts(tabId) {
    try {
        await browser.scripting.executeScript({
            target: { tabId },
            files: [
                "trace-interceptor.js",
                "dialog-interceptor.js",
                "console-interceptor.js",
                "network-interceptor.js",
            ],
            world: "MAIN",
        });
        await browser.scripting.executeScript({
            target: { tabId },
            files: ["content.js"],
        });
        await delay(100);
    } catch (err) {
        console.warn("[MCPSafari] Failed to inject content scripts:", err);
        throw new Error(
            `Cannot inject content scripts into this tab: ${err.message}`
        );
    }
}

// ─── Utilities ───────────────────────────────────────────────────────

async function getActiveTabId() {
    // Use pinned tab if set via select_tab
    if (selectedTabId !== null) {
        try {
            const tab = await browser.tabs.get(selectedTabId);
            return tab.id;
        } catch {
            // Tab was closed, clear selection
            selectedTabId = null;
            persistSelectedTab(null);
        }
    }
    const tabs = await browser.tabs.query({
        active: true,
        currentWindow: true,
    });
    if (tabs.length === 0) throw new Error("No active tab found");
    return tabs[0].id;
}

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Message Listener (from popup or content scripts) ────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "getStatus") {
        loadAuthTokens().finally(() => {
            reconnectKnownPorts();
            setTimeout(() => {
                sendResponse({ ports: visibleConnectionStatuses() });
            }, 250);
        });
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
            const conn = connections.get(port);
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
                // Try to reconnect disconnected ports.
                // Only reset backoff for previously-connected ports (quick recovery
                // when a known server restarts). Never-connected auto-scan ports
                // keep their attempt count so they get cleaned up below.
                for (const [port, conn] of connections) {
                    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
                        if (conn.lastConnected > 0 || conn.manual || authTokensByPort.has(port)) {
                            conn.attempts = 0;
                        }
                        connectToPort(port);
                    }
                }

                // Clean up auto-scan ports that have never connected or have been
                // disconnected for longer than AUTO_CLEANUP_MS
                const now = Date.now();
                for (const [port, conn] of connections) {
                    if (conn.manual) continue;
                    if (!isAutoScanPort(port)) continue;
                    if (conn.state === "connected") continue;
                    if (conn.lastConnected === 0 && conn.attempts > 3) {
                        // Never connected — remove after a few failed attempts
                        connections.delete(port);
                    } else if (conn.lastConnected > 0 && (now - conn.lastConnected) > AUTO_CLEANUP_MS) {
                        // Was connected but server has been gone for 2+ minutes
                        connections.delete(port);
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
        if (response && response.tokens) {
            authTokensByPort.clear();
            legacyAuthToken = null;
            for (const [port, token] of Object.entries(response.tokens)) {
                const parsedPort = parseInt(port, 10);
                if (parsedPort >= 1024 && parsedPort <= 65535 && token) {
                    authTokensByPort.set(parsedPort, token);
                }
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
