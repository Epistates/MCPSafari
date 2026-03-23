/**
 * MCPSafari Extension Background Script
 *
 * WebSocket client that connects to the Swift MCP server.
 * Receives BridgeRequest messages, dispatches to browser APIs or content scripts,
 * and sends BridgeResponse messages back.
 */

const WS_URL = "ws://localhost:8089";
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const TOKEN_FILE_PATH = "~/.config/mcp-safari/token";

let ws = null;
let reconnectAttempts = 0;
let connectionState = "disconnected"; // disconnected | connecting | connected
let selectedTabId = null; // Pinned tab for context (set via select_tab tool)
let authToken = null; // Read from token file at startup

// ─── WebSocket Connection ────────────────────────────────────────────

function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) return;

    connectionState = "connecting";
    ws = new WebSocket(WS_URL);
    let pendingAuth = !!authToken; // Only do auth handshake if we have a token

    ws.onopen = () => {
        if (authToken) {
            // Send auth token as the first message
            ws.send(JSON.stringify({ auth: authToken }));
            console.log("[MCPSafari] Sent auth token to MCP server");
        } else {
            // No token — skip auth, connect directly
            connectionState = "connected";
            reconnectAttempts = 0;
            console.log("[MCPSafari] Connected to MCP server (no auth)");
        }
    };

    ws.onmessage = async (event) => {
        // If we sent an auth token, first message must be the ack
        if (pendingAuth) {
            pendingAuth = false;
            try {
                const msg = JSON.parse(event.data);
                if (msg.auth === "ok") {
                    connectionState = "connected";
                    reconnectAttempts = 0;
                    console.log("[MCPSafari] Authenticated and connected to MCP server");
                } else {
                    console.error("[MCPSafari] Authentication rejected");
                    ws.close();
                }
            } catch (err) {
                console.error("[MCPSafari] Invalid auth response:", err);
                ws.close();
            }
            return;
        }

        try {
            const request = JSON.parse(event.data);
            const response = await handleRequest(request);
            ws.send(JSON.stringify(response));
        } catch (err) {
            console.error("[MCPSafari] Error handling message:", err);
            try {
                const req = JSON.parse(event.data);
                ws.send(JSON.stringify({
                    id: req.id,
                    success: false,
                    error: String(err),
                    data: null,
                }));
            } catch (_) { /* ignore parse failure */ }
        }
    };

    ws.onclose = () => {
        connectionState = "disconnected";
        console.log("[MCPSafari] Disconnected from MCP server");
        scheduleReconnect();
    };

    ws.onerror = (err) => {
        console.error("[MCPSafari] WebSocket error:", err);
    };
}

function scheduleReconnect() {
    const delay = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts),
        RECONNECT_MAX_MS
    );
    reconnectAttempts++;
    setTimeout(connect, delay);
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

async function restoreSelectedTab() {
    try {
        if (browser.storage && browser.storage.session) {
            const data = await browser.storage.session.get("selectedTabId");
            if (data.selectedTabId != null) {
                // Verify the tab still exists
                try {
                    await browser.tabs.get(data.selectedTabId);
                    selectedTabId = data.selectedTabId;
                } catch {
                    // Tab was closed
                    await browser.storage.session.remove("selectedTabId");
                }
            }
        }
    } catch (_) { /* ignore */ }
}

// ─── Navigation Handler ─────────────────────────────────────────────

async function handleNavigate(params) {
    const tabId = params.tabId || (await getActiveTabId());
    const action = params.action || "goto";

    let message;
    switch (action) {
        case "goto":
            if (!params.url) throw new Error("URL required for 'goto' action");
            await browser.tabs.update(tabId, { url: params.url });
            await delay(500);
            message = "Navigated to";
            break;

        case "back":
            await browser.scripting.executeScript({
                target: { tabId },
                func: () => history.back(),
            });
            await delay(300);
            message = "Navigated back to";
            break;

        case "forward":
            await browser.scripting.executeScript({
                target: { tabId },
                func: () => history.forward(),
            });
            await delay(300);
            message = "Navigated forward to";
            break;

        case "reload":
            await browser.tabs.reload(tabId);
            await delay(300);
            message = "Reloaded";
            break;

        default:
            throw new Error(`Unknown navigation action: ${action}`);
    }

    // Return tab info so the caller knows where they landed
    const tab = await browser.tabs.get(tabId);
    return `${message} ${tab.url || ""} (${tab.title || ""})`
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
                const fn = new Function(`return (async () => { ${code} })()`);
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
                "dialog-interceptor.js",
                "console-interceptor.js",
                "network-interceptor.js",
                "content.js",
            ],
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
        sendResponse({ connectionState, wsUrl: WS_URL });
        return false;
    }
    if (message.type === "reconnect") {
        if (ws) ws.close();
        reconnectAttempts = 0;
        connect();
        sendResponse({ ok: true });
        return false;
    }
    return false;
});

// ─── Service Worker Keepalive ─────────────────────────────────────────

// Service workers get suspended after ~30s of inactivity.
// Use alarms to periodically wake and ensure WebSocket stays connected.
if (typeof browser.alarms !== "undefined") {
    browser.alarms.create("mcp-keepalive", { periodInMinutes: 0.4 }); // ~24s
    browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === "mcp-keepalive") {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                connect();
            }
        }
    });
}

// ─── Token Loading ──────────────────────────────────────────────────

async function loadAuthToken() {
    try {
        const response = await browser.runtime.sendNativeMessage(
            "com.epistates.MCPSafari.Extension",
            { type: "getToken" }
        );
        if (response && response.token) {
            authToken = response.token;
            console.log("[MCPSafari] Auth token loaded");
        } else {
            console.warn("[MCPSafari] Failed to load auth token:", response?.error || "unknown");
        }
    } catch (err) {
        console.warn("[MCPSafari] Native messaging unavailable for token:", err);
    }
}

// ─── Initialize ──────────────────────────────────────────────────────

Promise.all([loadAuthToken(), restoreSelectedTab()]).then(() => {
    connect();
    console.log("[MCPSafari] Background script initialized");
});
