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

/** @type {Map<number, number>} tabId to when its last successful probe landed. */
const tabAccessProbedAt = new Map();

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

// Best effort, and deliberately not fatal: the origin only sharpens the message,
// and reading it goes through the same APIs that may already be blocked.
async function originOfTab(tabId) {
    try {
        const tab = await withDeadline(browser.tabs.get(tabId), PERMISSION_PROBE_TIMEOUT_MS);
        return tab && tab.url ? new URL(tab.url).origin : null;
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
    const probedAt = tabAccessProbedAt.get(tabId);
    if (probedAt !== undefined && Date.now() - probedAt < PERMISSION_CACHE_MS) return;

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
        tabAccessProbedAt.set(tabId, Date.now());
    } catch (err) {
        tabAccessProbedAt.delete(tabId);
        throw permissionRequiredError(origin, err instanceof DeadlineExceeded);
    }
}

function failureResponse(id, error) {
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
    };
}

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
    const conn = connections.get(port);
    if (!conn) return;
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
        socket.send(JSON.stringify({
            auth: authToken,
            extensionVersion: EXTENSION_VERSION,
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            profileId,
        }));
        console.log(`[MCPSafari:${port}] Sent auth token`);
    };

    socket.onmessage = async (event) => {
        if (pendingAuth) {
            pendingAuth = false;
            try {
                const msg = JSON.parse(event.data);
                if (msg.auth === "ok") {
                    if (msg.protocolVersion !== undefined && msg.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
                        console.error(`[MCPSafari:${port}] Protocol mismatch: extension=${BRIDGE_PROTOCOL_VERSION}, server=${msg.protocolVersion}`);
                        socket.close();
                        return;
                    }
                    conn.lastConnected = Date.now();
                    conn.state = "connected";
                    conn.attempts = 0;
                    console.log(`[MCPSafari:${port}] Authenticated`);
                } else {
                    console.error(`[MCPSafari:${port}] Auth rejected: ${msg.error || "unknown error"}`);
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
            socket.send(JSON.stringify(failureResponse(request.id, err)));
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
    const conn = connections.get(port);
    if (!conn) return;
    if (!conn.manual && conn.lastConnected === 0 && conn.attempts >= 3) {
        suppressStaleTokenPort(port);
        return;
    }
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

        if (conn.lastConnected > 0 || conn.manual) {
            conn.attempts = 0;
        }
        connectToPort(port);
    }
}

function ensurePortsForKnownTokens() {
    for (const [port, token] of authTokensByPort) {
        if (staleTokensByPort.get(port) === token) continue;
        staleTokensByPort.delete(port);
        if (isAutoScanPort(port) || manualPorts.has(port)) {
            if (!connections.has(port)) {
                ensurePort(port, manualPorts.has(port));
                connectToPort(port);
            }
        }
    }
}

function suppressStaleTokenPort(port) {
    const token = authTokensByPort.get(port);
    if (token) staleTokensByPort.set(port, token);
    connections.delete(port);
}

function disconnectPort(port) {
    const conn = connections.get(port);
    if (conn) {
        if (conn.ws) conn.ws.close();
        connections.delete(port);
    }
    staleTokensByPort.delete(port);
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

            case "native_type_text":
                data = await handleNativeTypeText(params);
                break;

            case "native_press_key":
                data = await handleNativePressKey(params);
                break;

            case "native_pointer":
                data = await handleNativePointer(params);
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
            case "upload_file":
            case "drop_file":
            case "wait":
            case "start_trace":
            case "stop_trace":
            case "get_console_messages":
            case "get_network_requests":
                data = await dispatchToContent(action, params);
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
                        urlPattern: params.urlPattern || null,
                        status: params.status ?? null,
                        maxResults: params.maxResults || 0,
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
                return failureResponse(id, new Error(`Unknown action: ${action}`));
        }

        return {
            id,
            success: true,
            data: typeof data === "string" ? data : JSON.stringify(data),
            error: null,
        };
    } catch (err) {
        return failureResponse(id, err);
    }
}

// ─── Tab Handlers ────────────────────────────────────────────────────

// Bearer and session values are redacted before a tab URL leaves the
// extension. `code` is only treated as an OAuth code next to `state`;
// alone it is usually a SKU or coupon.
const SECRET_URL_PARAMS = ["access_token", "id_token", "refresh_token", "client_secret", "api_key", "password"];

function redactUrlSecrets(url) {
    if (!url) return "";
    // Only the query and fragment carry parameters; `&` is legal in a path.
    const start = url.search(/[?#]/);
    if (start === -1) return url;
    const tail = url.slice(start);
    const names = /[?&#]state(?=[=&#]|$)/i.test(tail) ? [...SECRET_URL_PARAMS, "code"] : SECRET_URL_PARAMS;
    const pattern = new RegExp(`([?&#](?:${names.join("|")})=)[^&#]*`, "gi");
    return url.slice(0, start) + tail.replace(pattern, "$1[redacted]");
}

async function handleTabsQuery() {
    // One tab awaiting a permission decision is enough to hold up the whole
    // listing, and there is no probe that helps because the block belongs to no
    // single tab here. Failing with the reason beats the bridge timing out with
    // none, and this is the call every session starts with.
    let tabs;
    try {
        tabs = await withDeadline(browser.tabs.query({}), TAB_LISTING_TIMEOUT_MS);
    } catch (err) {
        if (!(err instanceof DeadlineExceeded)) throw err;
        throw permissionRequiredError(null, true);
    }
    return tabs.map((t) => ({
        id: t.id,
        url: redactUrlSecrets(t.url),
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
        url: redactUrlSecrets(tab.url || params.url),
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
        url: redactUrlSecrets(tab.url),
        title: tab.title || "",
        selected: true,
    };
}

async function focusTabForNativeInput(tabIdParam) {
    const tabId = tabIdParam || (await getActiveTabId());
    const tab = await browser.tabs.get(tabId);
    await browser.tabs.update(tabId, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
    await delay(100);
    return tabId;
}

// Native input works in screen coordinates, and captureVisibleTab captures the
// top-level viewport. A subframe measures elements in its own viewport and
// cannot reach a cross-origin parent's offset, so a subframe target would
// produce a confidently wrong click or crop. Refusing beats guessing.
const NATIVE_INPUT_TOP_FRAME_ONLY =
    "Native input reaches the top frame only, and this element is inside an iframe. " +
    "Omit native to use the synthetic path, which works in every frame.";

const SCREENSHOT_TOP_FRAME_ONLY =
    "Screenshot crops the top-level viewport, and this element is inside an iframe, " +
    "so its position does not map onto the captured image. Capture without uid or selector.";

function requireTopFrameTarget(params, reason = NATIVE_INPUT_TOP_FRAME_ONLY) {
    const frame = frameOfUid(params.uid) ?? frameOfUid(params.fromUid);
    if (frame) {
        const error = new Error(reason);
        error.code = "invalid_input";
        error.recoveryAction = "fix_input";
        throw error;
    }
}

async function handleNativeTypeText(params) {
    requireTopFrameTarget(params);
    const tabId = await focusTabForNativeInput(params.tabId);
    await sendToContentScript(tabId, {
        action: "prepare_native_input",
        params,
    });
    return "Safari is ready for native input";
}

async function handleNativePressKey(params) {
    requireTopFrameTarget(params);
    const tabId = await focusTabForNativeInput(params.tabId);
    await sendToContentScript(tabId, {
        action: "prepare_native_key",
        params,
    });
    return "Safari is ready for native input";
}

async function handleNativePointer(params) {
    requireTopFrameTarget(params);
    const tabId = await focusTabForNativeInput(params.tabId);
    return sendToContentScript(tabId, {
        action: "native_pointer_points",
        params,
    });
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
    return `${message} ${redactUrlSecrets(tab.url)} (${tab.title || ""})`
}

async function waitForTabLoad(tabId, beforeTab, timeoutMs = 15000, noNavigationTimeoutMs = 1500) {
    const beforeUrl = beforeTab?.url || "";
    let sawNavigation = false;
    let loadStarted = false;
    let sameDocumentTimer = null;

    return new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            browser.tabs.onUpdated.removeListener(onUpdated);
            clearTimeout(timer);
            clearTimeout(noNavigationTimer);
            clearTimeout(sameDocumentTimer);
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

        const settleIfSameDocument = () => {
            clearTimeout(sameDocumentTimer);
            sameDocumentTimer = setTimeout(settle, 500);
        };

        const onUpdated = (updatedTabId, changeInfo, tab) => {
            if (updatedTabId !== tabId) return;

            if (changeInfo.status === "loading") {
                sawNavigation = true;
                loadStarted = true;
                clearTimeout(sameDocumentTimer);
            }

            if (changeInfo.url && changeInfo.url !== beforeUrl) {
                sawNavigation = true;
                if (!loadStarted) {
                    settleIfSameDocument();
                }
            }

            if (changeInfo.status === "complete" && (sawNavigation || (tab.url || "") !== beforeUrl)) {
                settle();
            }
        };

        const timer = setTimeout(settle, timeoutMs);
        const noNavigationTimer = setTimeout(() => {
            if (!sawNavigation) {
                settle();
            }
        }, noNavigationTimeoutMs);
        browser.tabs.onUpdated.addListener(onUpdated);
    });
}

// ─── Screenshot Handler ─────────────────────────────────────────────

async function handleScreenshot(params) {
    requireTopFrameTarget(params, SCREENSHOT_TOP_FRAME_ONLY);
    const tabId = params.tabId || (await getActiveTabId());
    // Before the `tabs.get` below, which blocks on Safari's dialog just like the
    // capture does. Deadlining only the capture left this line to absorb the
    // whole wait, so a blocked screenshot still took the full bridge timeout and
    // still reported the wrong reason.
    await ensureTabAccess(tabId);
    const tab = await browser.tabs.get(tabId);

    // captureVisibleTab captures the active tab in a window
    if (!tab.active) {
        await browser.tabs.update(tabId, { active: true });
        await delay(300);
    }

    // Context before the frame: a page that loses focus between the two reads
    // then produces a warning about a good frame rather than an all-clear on a
    // stale one.
    // The target is scrolled into view before the context read so the
    // reported viewport matches the frame.
    const target = params.uid || params.selector
        ? await sendToContentScript(tabId, {
            action: "element_rect",
            params: { uid: params.uid, selector: params.selector },
        })
        : null;
    const context = await capturePageContext(tabId);
    // Deliberately not `ensureTabAccess`: the context read above is allowed to
    // fail and still produce a picture, and a probe would turn that graceful
    // degradation into a refusal. A capture is sub-second when it is permitted
    // at all, so a deadline here separates "blocked on the dialog" from "slow".
    const dataUrl = await withPermissionDeadline(
        browser.tabs.captureVisibleTab(tab.windowId, { format: "png" }),
        tabId
    );

    return {
        // Raw base64, data URI prefix stripped
        image: dataUrl.replace(/^data:image\/\w+;base64,/, ""),
        ...context,
        ...(target ? { target } : {}),
    };
}

// Viewport, scale, visibility, and focus at capture time. Safari does not
// repaint an occluded page, so a capture of a hidden page can predate the last
// action, and it does not match :focus while its window is not key.
async function capturePageContext(tabId) {
    try {
        const results = await browser.scripting.executeScript({
            target: { tabId },
            func: () => ({
                visible: document.visibilityState === "visible",
                hasFocus: document.hasFocus(),
                viewport: {
                    width: window.innerWidth,
                    height: window.innerHeight,
                },
                devicePixelRatio: window.devicePixelRatio,
            }),
        });
        return results[0]?.result || {};
    } catch (err) {
        console.warn("[MCPSafari] Screenshot context unavailable:", err);
        return {};
    }
}

// ─── JavaScript Execution Handler ────────────────────────────────────

// Injected into the target world, so it must not close over anything here.
function evaluateUserCode(code) {
    const describe = (e) => {
        const message = e && e.message ? e.message : String(e);
        // A page whose script-src omits 'unsafe-eval' refuses to compile a
        // string in its own realm, which is what new Function does here.
        const blocked = (typeof EvalError !== "undefined" && e instanceof EvalError)
            || /unsafe-eval|trusted-types-eval|Content Security Policy/i.test(message);
        return blocked ? { __error: message, __cspBlocked: true } : { __error: message };
    };

    try {
        const expressionCode = String(code).trim().replace(/;+$/, "");
        let fn;
        try {
            fn = new Function(`return (async () => (${expressionCode}))()`);
        } catch (e) {
            // A syntax error means it is not a bare expression; a CSP refusal
            // means neither form will compile, so do not retry it as one.
            if (typeof EvalError !== "undefined" && e instanceof EvalError) return describe(e);
            fn = new Function(`return (async () => { ${code} })()`);
        }
        return fn().catch((e) => describe(e));
    } catch (e) {
        return describe(e);
    }
}

async function handleJavaScript(params) {
    const tabId = params.tabId || (await getActiveTabId());
    await ensureTabAccess(tabId);
    const runIn = async (world) => {
        const results = await browser.scripting.executeScript({
            target: { tabId },
            func: evaluateUserCode,
            args: [params.code],
            world,
        });
        return results && results.length > 0 ? results[0].result : undefined;
    };

    let result = await runIn("MAIN");
    let isolated = false;

    if (result && result.__cspBlocked) {
        // The isolated world does not inherit the page's CSP and still shares
        // the DOM, so DOM-based code survives a strict script-src. Page
        // JavaScript globals do not exist there, which the caller is told.
        // Retrying is safe because a CSP refusal happens at compile time, so
        // nothing in the submitted code has run yet and side effects cannot double.
        const fallback = await runIn("ISOLATED");
        if (fallback && fallback.__cspBlocked) {
            throw new Error(
                "The page's Content Security Policy blocks evaluating code as a string, "
                + "in both the page world and the extension's isolated world. "
                + "Use snapshot, find, or read_page to inspect the page, and click or "
                + "type_text to drive it."
            );
        }
        result = fallback;
        isolated = true;
    }

    if (result && result.__error) throw new Error(result.__error);
    const value = result !== undefined ? JSON.stringify(result) : "undefined";
    return isolated
        ? `${value}\n\n[Ran in the extension's isolated world: the page's CSP blocked evaluation in the page world. The DOM is shared, but page JavaScript globals such as window properties set by the site are not visible.]`
        : value;
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

// ─── Frame Routing ───────────────────────────────────────────────────

// content.js runs in every frame, each with its own uid counter, so a uid
// names the frame that minted it. That keeps frames out of the tool contract:
// nothing takes a frameId, the uid carries it.
const UID_PATTERN = /^f(\d+)e\d+$/;

function frameOfUid(value) {
    const match = UID_PATTERN.exec(String(value ?? ""));
    return match ? Number(match[1]) : null;
}

async function listFrames(tabId) {
    try {
        const frames = await browser.webNavigation.getAllFrames({ tabId });
        if (frames && frames.length > 0) return frames;
    } catch (err) {
        console.warn("[MCPSafari] Frame enumeration failed:", err);
    }
    return [{ frameId: 0, parentFrameId: -1, url: "" }];
}

// A frame whose document refuses the content script (a sandboxed or already
// unloaded one) must not fail the whole call, so misses are dropped.
async function collectFromFrames(tabId, message) {
    const frames = await listFrames(tabId);
    const collected = [];
    for (const frame of frames) {
        try {
            collected.push({
                frameId: frame.frameId,
                data: await sendToContentScript(tabId, message, frame.frameId),
            });
        } catch (err) {
            if (frame.frameId === 0) throw err;
        }
    }
    return collected;
}

// Targeting by selector or text has no frame in it, so the frames are tried in
// order and the first that resolves the target wins. The top frame is tried
// first, which keeps single-frame pages behaving exactly as before.
async function sendToFirstMatchingFrame(tabId, message) {
    const frames = await listFrames(tabId);
    let firstFailure;
    for (const frame of frames) {
        try {
            return await sendToContentScript(tabId, message, frame.frameId);
        } catch (err) {
            if (!firstFailure) firstFailure = err;
        }
    }
    throw firstFailure || new Error("No frame handled the request");
}

// Reads the whole tab as one tree by asking each frame for its own and hanging
// each result on the <iframe> that hosts it, so an agent sees the page the way
// a person does instead of a top frame with holes in it.
async function snapshotAcrossFrames(tabId, params) {
    const frames = await listFrames(tabId);
    const trees = new Map();
    for (const frame of frames) {
        try {
            const tree = await sendToContentScript(
                tabId,
                { action: "snapshot", params },
                frame.frameId
            );
            if (tree) trees.set(frame.frameId, tree);
        } catch (err) {
            if (frame.frameId === 0) throw err;
        }
    }

    const childFrames = new Map();
    for (const frame of frames) {
        if (frame.frameId === 0) continue;
        const siblings = childFrames.get(frame.parentFrameId) || [];
        siblings.push(frame);
        childFrames.set(frame.parentFrameId, siblings);
    }

    const root = trees.get(0);
    if (root) spliceFrames(root, 0, childFrames, trees);
    return root;
}

function collectFrameHosts(node, hosts = []) {
    if (!node || typeof node !== "object") return hosts;
    if (typeof node.frameSrc === "string") hosts.push(node);
    for (const child of node.children || []) collectFrameHosts(child, hosts);
    return hosts;
}

// getAllFrames reports each frame's URL but not which element hosts it, so the
// two are matched on the resolved src. Identical srcs are matched in document
// order, and a frame whose host cannot be identified is attached to the parent
// tree rather than dropped.
function spliceFrames(tree, frameId, childFrames, trees) {
    const children = childFrames.get(frameId) || [];
    const hosts = collectFrameHosts(tree);
    const claimed = new Set();
    const orphans = [];

    for (const frame of children) {
        const subtree = trees.get(frame.frameId);
        if (!subtree) continue;
        spliceFrames(subtree, frame.frameId, childFrames, trees);

        const host = hosts.find((h) => !claimed.has(h) && h.frameSrc === frame.url);
        if (host) {
            claimed.add(host);
            host.children = [subtree];
        } else {
            orphans.push(subtree);
        }
    }

    if (orphans.length > 0) {
        tree.children = (tree.children || []).concat(orphans);
        tree.unmatchedFrames = orphans.length;
    }
    for (const host of hosts) delete host.frameSrc;
}

// Routes one content action. Frames are an implementation detail here: a uid
// says which frame owns the element, a search spans them all, and everything
// else stays on the top frame where it always ran.
async function dispatchToContent(action, params, message) {
    const payload = message || { action, params };
    const targetFrame = frameOfUid(params.uid) ?? frameOfUid(params.fromUid);
    if (targetFrame !== null) {
        return sendToContentScript(params.tabId, payload, targetFrame);
    }

    if (action === "snapshot") return snapshotAcrossFrames(params.tabId, params);
    if (action === "read_page" && params.format === "snapshot") {
        return snapshotAcrossFrames(params.tabId, params);
    }

    if (action === "find") {
        const collected = await collectFromFrames(params.tabId, payload);
        return collected.flatMap((entry) => entry.data || []);
    }

    if (FRAME_SEARCHING_ACTIONS.has(action) && (params.selector || params.text)) {
        return sendToFirstMatchingFrame(params.tabId, payload);
    }

    return sendToContentScript(params.tabId, payload, 0);
}

// Acting on an element the caller named by selector or text: the element can
// live in any frame, so the search has to cross them.
const FRAME_SEARCHING_ACTIONS = new Set([
    "click",
    "type_text",
    "form_input",
    "select_option",
    "hover",
    "drag",
    "upload_file",
    "drop_file",
    "scroll",
    "wait",
]);

async function sendToContentScript(tabId, message, frameId = 0) {
    const resolvedTabId = tabId || (await getActiveTabId());
    // Before anything that can block on Safari's permission dialog. `wait` and
    // other long actions are unaffected: the probe is separate and short, and
    // the action keeps its own timing once access is established.
    await ensureTabAccess(resolvedTabId);
    // The frame learns its own id from the request it is answering.
    message = { ...message, frameId };
    const options = { frameId };

    try {
        const response = await browser.tabs.sendMessage(resolvedTabId, message, options);
        if (!response) throw new Error("Receiving end does not exist");
        if (response && response.error) {
            throw toolErrorFromResponse(response);
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
                message,
                options
            );
            if (!response) throw new Error("Content script did not respond after injection");
            if (response && response.error) {
                throw toolErrorFromResponse(response);
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
                "file-drop.js",
            ],
            world: "MAIN",
        });
        // content.js is declared for all frames, so a re-injection has to cover
        // them too or the frames stay unreachable until the next navigation.
        await browser.scripting.executeScript({
            target: { tabId, allFrames: true },
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

// Entries expire on their own, but a long-lived background page would otherwise
// accumulate one per tab ever touched.
browser.tabs.onRemoved.addListener((tabId) => {
    tabAccessProbedAt.delete(tabId);
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
                // Try to reconnect disconnected ports.
                // Only reset backoff for previously-connected ports (quick recovery
                // when a known server restarts). Never-connected auto-scan ports
                // keep their attempt count so they get cleaned up below.
                for (const [port, conn] of connections) {
                    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
                        if (conn.lastConnected > 0 || conn.manual) {
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
                        suppressStaleTokenPort(port);
                    } else if (conn.lastConnected > 0 && (now - conn.lastConnected) > AUTO_CLEANUP_MS) {
                        // Was connected but server has been gone for 2+ minutes
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
