"use strict";

// Tab and window tools, plus the native-input handlers that foreground a tab.

// ─── Tab Handlers ────────────────────────────────────────────────────

// Credentials are redacted from a URL before it leaves the extension, wherever
// the URL turns up: tab listings, captured requests, trace events, link hrefs.
// A presigned download or an OAuth callback carries its credential in the query
// or fragment, and userinfo (`https://user:pw@host`) carries one in the
// authority.
//
// A parameter name is judged by its words, not by an exact list. Spelled out as
// a list it missed `auth_token`, `csrf_token`, `oauth_verifier` and anything
// else nobody had thought of; matched as a bare substring it would take
// `design` for `sig`. The name is percent-decoded first (`%74oken` is `token`),
// split on separators and camelCase (`X-Goog-Signature`, `accessToken`), and
// redacted when any word is one of SECRET_NAME_WORDS.
//
// Names that describe a secret rather than carrying one stay readable, which is
// what the last word is for: `token_type=bearer` and `password_hint=cat` are
// the token's type and a hint, and an agent shown `[redacted]` for either
// learns nothing. `code` is only treated as an OAuth code next to `state`;
// alone it is usually a SKU or coupon.
const SECRET_NAME_WORDS = new Set([
    "token", "secret", "key", "sig", "signature",
    "password", "passwd", "pwd", "passcode",
    "auth", "authorization", "session", "sid", "jwt",
    "otp", "ticket", "verifier", "credential", "credentials",
]);
// Joined words ending in one of these are caught too, for names run together
// (`accesstoken`, `clientsecret`). Short words are left out on purpose: `key`
// would take `monkey`.
const SECRET_NAME_SUFFIXES = ["token", "secret", "password", "passwd", "signature", "apikey", "sessionid", "credential", "credentials"];
const DESCRIPTIVE_LAST_WORDS = new Set([
    "type", "hint", "length", "expires", "expiry", "ttl", "algorithm", "alg", "format", "endpoint", "url", "uri", "count", "name", "method",
]);
const USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/i;

function urlNameWords(name) {
    let decoded = name;
    try {
        decoded = decodeURIComponent(name.replace(/\+/g, " "));
    } catch { /* a malformed escape is matched as written */ }
    return decoded
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

function isSecretUrlName(words) {
    if (words.length === 0) return false;
    if (DESCRIPTIVE_LAST_WORDS.has(words[words.length - 1]) && words.length > 1) return false;
    const joined = words.join("");
    return words.some((word) => SECRET_NAME_WORDS.has(word))
        || SECRET_NAME_SUFFIXES.some((suffix) => joined.endsWith(suffix));
}

function redactUrlSecrets(url) {
    if (!url) return "";
    const noUserinfo = String(url).replace(USERINFO, "$1[redacted]@");
    // Only the query and fragment carry parameters; `&` is legal in a path.
    const start = noUserinfo.search(/[?#]/);
    if (start === -1) return noUserinfo;
    const tail = noUserinfo.slice(start);

    // A name follows `?`, `&` or `#`, so a hash-routed callback
    // (`#/cb?code=x`) is read the same as a plain query.
    const parameter = /([?&#])([^=&#?]*)=/g;
    const hasState = [...tail.matchAll(parameter)].some((match) => {
        const words = urlNameWords(match[2]);
        return words.length === 1 && words[0] === "state";
    });
    // `state` with no value (`&state`) is still the OAuth state.
    const bareState = /[?&#]state(?=[&#]|$)/i.test(tail);

    let redacted = "";
    let copied = 0;
    let match;
    while ((match = parameter.exec(tail)) !== null) {
        const words = urlNameWords(match[2]);
        const isCode = words.length === 1 && words[0] === "code" && (hasState || bareState);
        if (!isSecretUrlName(words) && !isCode) continue;
        // The value ends at the next separator. Scanning on from there, rather
        // than from the end of the name, keeps a `?token=` nested inside an
        // earlier parameter's value (`?next=/cb?token=x`) in view.
        const valueStart = parameter.lastIndex;
        const rest = tail.slice(valueStart).search(/[&#]/);
        const valueEnd = rest === -1 ? tail.length : valueStart + rest;
        redacted += `${tail.slice(copied, valueStart)}[redacted]`;
        copied = valueEnd;
        parameter.lastIndex = valueEnd;
    }
    return noUserinfo.slice(0, start) + redacted + tail.slice(copied);
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

