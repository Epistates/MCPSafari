"use strict";

// Tab and window tools, plus the native-input handlers that foreground a tab.

// ─── Tab Handlers ────────────────────────────────────────────────────

// Bearer and session values are redacted before a tab URL leaves the
// extension. `code` is only treated as an OAuth code next to `state`;
// alone it is usually a SKU or coupon.
//
// Whole names rather than parts, deliberately. The pattern below requires an
// `=` straight after the name, which is what keeps `token_type=bearer` and
// `password_hint=cat` readable: both describe a secret rather than carrying
// one. Matching `token` as a substring redacts those too, and an agent shown
// `[redacted]` for a token's type learns nothing and loses something.
//
// The cost is that every spelling has to be listed. Bare `token` and `session`
// were missing, which are the two most ordinary names in the class this exists
// for, and the comment above already claimed session values were covered.
const SECRET_URL_PARAMS = [
    "access_token", "id_token", "refresh_token", "token",
    "client_secret", "secret",
    "api_key", "apikey", "api-key",
    "password", "passwd", "pwd",
    "session", "sessionid", "session_id", "sid",
    "jwt", "auth", "authorization", "credential", "credentials",
    "signature", "sig",
    // Presigned S3 and CloudFront URLs, where the signature is the credential
    // and the whole URL is the thing worth not leaking.
    "x-amz-signature", "x-amz-security-token", "x-amz-credential",
];

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
    // Before the `tabs.get`, for the reason spelled out in `handleScreenshot`:
    // that call parks on Safari's dialog too, so leaving it ungated means a
    // blocked tab rides the bridge timeout and reports the wrong thing.
    await ensureTabAccess(tabId);
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
    // Native input needs the page anyway, and this ran before any gating, so a
    // blocked tab spent the whole bridge timeout here and then blamed the bridge.
    await ensureTabAccess(tabId);
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

