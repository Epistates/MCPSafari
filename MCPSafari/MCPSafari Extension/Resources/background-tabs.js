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

// ─── What a tab may say about itself ─────────────────────────────────

// Safari hands the tabs API a URL and title for every tab, including those on
// sites the user never granted, which reads as browsing history. A tab whose
// site is not known to be granted still appears, so its id stays usable, but
// without the URL and title, and says why.
//
// "Known" is deliberately narrow, because the alternative to knowing is probing
// and a probe on an undecided site raises Safari's dialog: see `grantedOrigins`.
// A site nothing has touched yet is therefore reported as not granted even if
// the user granted it, and becomes readable once any call has reached it.
const NOT_GRANTED_HINT =
    "URL and title withheld: MCPSafari has not been granted access to this site. "
    + "The user can grant it from the MCPSafari button in Safari's toolbar, then list tabs again.";

function siteIsGranted(url) {
    // Nothing behind an about: page can be granted, and nothing in one is private.
    if (typeof url === "string" && /^about:/i.test(url)) return true;
    const origin = originOfUrl(url);
    return origin !== null && grantedOrigins.has(origin);
}

function tabAccessFields(url) {
    return siteIsGranted(url)
        ? { access: "granted" }
        : { access: "not_granted", accessHint: NOT_GRANTED_HINT };
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
    return tabs.map((t) => {
        const access = tabAccessFields(t.url);
        return {
            id: t.id,
            ...(access.access === "granted" ? { url: redactUrlSecrets(t.url), title: t.title || "" } : {}),
            active: t.active,
            pinned: t.pinned || false,
            audible: t.audible || false,
            muted: t.mutedInfo ? t.mutedInfo.muted : false,
            status: t.status || "complete",
            windowId: t.windowId,
            index: t.index,
            ...access,
        };
    });
}

async function handleTabsCreate(params) {
    const opts = {};
    if (params.url) opts.url = params.url;
    const tab = await browser.tabs.create(opts);
    const url = tab.url || params.url;
    const access = tabAccessFields(url);
    // The URL is the one the caller asked for. The title is the page's own.
    return {
        id: tab.id,
        url: redactUrlSecrets(url),
        ...(access.access === "granted" ? { title: tab.title || "" } : {}),
        ...access,
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

// Selecting a tab is bookkeeping: it remembers which tab later calls mean, and
// optionally brings it forward. Neither reads the page, so neither needs access
// to it, and requiring it made the pin impossible on exactly the tab a caller
// most needs to pin, the one the user has yet to grant. The first call that does
// touch the page is gated as usual and reports `permission_required`.
//
// Nothing here probes, so nothing here raises Safari's dialog. The tab is looked
// up under a deadline for its window and to confirm it exists; a lookup that is
// parked on a dialog for some other tab does not stop the pin, which is only an
// id, but then there is no window to bring forward and no URL to describe.
async function handleSelectTab(params) {
    const tabId = params.tabId;
    let tab = null;
    try {
        tab = await withDeadline(browser.tabs.get(tabId), PERMISSION_DEADLINE_MS);
    } catch (err) {
        // A tab that does not exist is the caller's mistake and must not be pinned.
        if (!(err instanceof DeadlineExceeded)) throw err;
    }

    if (tab && params.bringToFront !== false) {
        // Browser chrome, like `navigate`'s goto, and no more able to hang the
        // call than the lookup above: a deadline here skips the focus and no more.
        try {
            await withDeadline(browser.tabs.update(tabId, { active: true }), PERMISSION_DEADLINE_MS);
            await withDeadline(browser.windows.update(tab.windowId, { focused: true }), PERMISSION_DEADLINE_MS);
        } catch (err) {
            if (!(err instanceof DeadlineExceeded)) throw err;
        }
    }

    selectedTabId = tabId;
    persistSelectedTab(tabId);

    const access = tabAccessFields(tab && tab.url);
    return {
        id: tabId,
        ...(access.access === "granted" ? { url: redactUrlSecrets(tab.url), title: tab.title || "" } : {}),
        selected: true,
        ...access,
    };
}

// Activating a tab does not mean it is still the one showing a moment later:
// the user can click another, and a capture or a native keystroke then reaches
// the wrong page. So the claim is checked against the window, which is the only
// thing that knows, right where the result is about to be relied on.
async function assertTabShowing(tabId, windowId, purpose) {
    const showing = await withPermissionDeadline(
        browser.tabs.query({ active: true, windowId }),
        tabId
    );
    if (showing.length > 0 && showing[0].id === tabId) return;
    const error = new Error(
        `The tab is no longer the one showing in its window (another tab was activated), so ${purpose} `
        + "would have reached the wrong page. Retry the call."
    );
    error.code = "tab_not_showing";
    error.retryable = true;
    error.recoveryAction = "retry";
    throw error;
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
    await assertTabShowing(tabId, tab.windowId, "native input");
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

// True only while a read that outran its deadline is still in flight. Writing
// then would replace the stored set with the part loaded so far.
let grantedOriginsReadPending = false;

function persistGrantedOrigins() {
    if (grantedOriginsReadPending) return;
    try {
        if (browser.storage && browser.storage.local) {
            browser.storage.local.set({ grantedOrigins: [...grantedOrigins] });
        }
    } catch (_) { /* storage may not be available */ }
}

// Runs before the bridge connects, so it is ahead of the first `tabs_query`
// unless storage is slow. Storage gets the same short deadline as a probe; past
// it startup goes on with what is loaded, the rest of the stored origins read
// as not granted, and the read is merged in whenever it does arrive. The stored
// ones go first in the merge: they are older than anything learned meanwhile.
async function loadGrantedOrigins() {
    const read = (async () => {
        try {
            if (!browser.storage || !browser.storage.local) return;
            const data = await browser.storage.local.get("grantedOrigins");
            if (!Array.isArray(data.grantedOrigins)) return;
            const merged = new Set([
                ...data.grantedOrigins.filter((origin) => typeof origin === "string"),
                ...grantedOrigins,
            ]);
            grantedOrigins.clear();
            for (const origin of [...merged].slice(-MAX_GRANTED_ORIGINS)) grantedOrigins.add(origin);
        } catch (_) { /* ignore */ }
    })();
    try {
        await withDeadline(read, PERMISSION_PROBE_TIMEOUT_MS);
    } catch (_) {
        // DeadlineExceeded: the read carries on and merges when it lands, and
        // what was learned in the meantime is written back then.
        grantedOriginsReadPending = true;
        read.then(() => {
            grantedOriginsReadPending = false;
            persistGrantedOrigins();
        });
    }
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

    // Sites found reachable on an earlier run. Without them every restart, and
    // every suspension of the background page, would describe each tab as not
    // granted until a call had touched its site again.
    await loadGrantedOrigins();

    // Initialize all ports in the auto-scan range.
    // connectAll() will attempt each — servers that exist get connected,
    // absent ports fail silently and are cleaned up by the alarm.
    for (let offset = 0; offset < AUTO_SCAN_RANGE; offset++) {
        ensurePort(DEFAULT_PORT + offset);
    }
}

