"use strict";

// handleRequest: one bridge request in, one response out.

// ─── Request Router ──────────────────────────────────────────────────

// An action is served one of three ways, and each is a lookup rather than a
// switch arm. Nineteen of them differed only in their `case` label, which hid
// the one fact worth seeing: almost every tool is just handed to the content
// script.
//
// Maps rather than object literals, because the action name arrives off the
// wire. A plain object resolves `constructor` and `toString` through its
// prototype, so those names would have found an inherited function and been
// called as handlers instead of refused.
//
// Each entry wraps its handler in an arrow rather than naming it directly.
// Function declarations hoist within their own file only, and this file loads
// before the ones declaring most of these, so a direct reference would throw
// at load. The arrow defers that lookup to the call. Worth knowing that the
// tests cannot catch this: they concatenate the files, and in one script every
// declaration hoists.

// Served here in the background.
const BACKGROUND_HANDLERS = new Map([
    ["tabs_query", () => handleTabsQuery()],
    ["tabs_create", (params) => handleTabsCreate(params)],
    ["tabs_close", (params) => handleTabsClose(params)],
    ["select_tab", (params) => handleSelectTab(params)],
    ["navigate", (params) => handleNavigate(params)],
    ["native_type_text", (params) => handleNativeTypeText(params)],
    ["native_press_key", (params) => handleNativePressKey(params)],
    ["native_pointer", (params) => handleNativePointer(params)],
    ["screenshot", (params) => handleScreenshot(params)],
    ["javascript_tool", (params) => handleJavaScript(params)],
    ["resize_window", (params) => handleResizeWindow(params)],
]);

// Answered by the content script under the same name. `dispatchToContent`
// decides which frame to ask.
const CONTENT_ACTIONS = new Set([
    "read_page",
    "get_page_text",
    "snapshot",
    "find",
    "click",
    "type_text",
    "form_input",
    "select_option",
    "scroll",
    "press_key",
    "hover",
    "drag",
    "upload_file",
    "drop_file",
    "wait",
    "start_trace",
    "stop_trace",
    "get_console_messages",
    "get_network_requests",
]);

// Answered by the content script, but under a different name or with arguments
// defaulted here so the content script does not have to.
const CONTENT_PROXIES = new Map([
    ["read_console", (params) => ({
        action: "get_console_messages",
        params: {
            level: params.level || "all",
            pattern: params.pattern || null,
            clear: params.clear || false,
        },
    })],
    ["read_network", (params) => ({
        action: "get_network_requests",
        params: {
            type: params.type || "all",
            urlPattern: params.urlPattern || null,
            status: params.status ?? null,
            maxResults: params.maxResults || 0,
            clear: params.clear || false,
        },
    })],
    ["handle_dialog", (params) => ({ action: "handle_dialog", params })],
]);

// Interactions that can start a page load, each with the test for whether this
// call can. They answer only once a load they start has finished
// (`dispatchAndSettle`). They are the ones that dispatch the events a page
// navigates on: a click follows a link or submits a form, a key press can
// activate a control or submit one, and changing a field or select commonly
// submits or routes straight away (`onchange`). Typing navigates only when it
// ends in a key, so a plain `type_text` does not pay the wait.
//
// Not here: `hover`, `scroll` and `drag` do not follow links, and `upload_file`
// and `drop_file` start no load of their own. A navigation any of those cause
// anyway is still survived by a `wait` sent afterwards (`waitAcrossNavigations`).
// A click that opens a new tab, `target="_blank"`, does not navigate this one,
// so it answers at the end of the watch window with the new tab left to
// `tabs_context`.
const LOAD_STARTING_ACTIONS = new Map([
    ["click", () => true],
    ["press_key", () => true],
    ["type_text", (params) => Boolean(params.submitKey)],
    ["form_input", () => true],
    ["select_option", () => true],
]);

async function routeAction(action, params) {
    const handler = BACKGROUND_HANDLERS.get(action);
    if (handler) return handler(params);

    if (action === "wait") {
        return waitAcrossNavigations(params, (current) => dispatchToContent(action, current));
    }
    if (CONTENT_ACTIONS.has(action)) {
        const startsLoad = LOAD_STARTING_ACTIONS.get(action);
        return startsLoad && startsLoad(params)
            ? dispatchAndSettle(action, params)
            : dispatchToContent(action, params);
    }

    const proxy = CONTENT_PROXIES.get(action);
    if (proxy) return sendToContentScript(params.tabId, proxy(params));

    throw new Error(`Unknown action: ${action}`);
}

// URLs inside page data are redacted here, on the way out, with the one
// implementation tab listings use. The scripts that capture them run in the
// page's world, where `redactUrlSecrets` does not exist and where a page could
// tamper with any copy of it, so the capture reports URLs as they were and this
// is the last stop before they leave the extension.
//
// Every result is a fresh structured clone that nothing else holds, so these
// edit in place. A value of an unexpected shape is returned untouched: the
// page can send anything, and refusing to answer would be a worse outcome than
// an unredacted field the content script already bounded.
function redactEachUrl(entries, fields) {
    if (!Array.isArray(entries)) return;
    for (const entry of entries) redactFields(entry, fields);
}

function redactFields(entry, fields) {
    if (!entry || typeof entry !== "object") return;
    for (const field of fields) {
        if (typeof entry[field] === "string") entry[field] = redactUrlSecrets(entry[field]);
    }
}

function redactSnapshotLinks(node) {
    const pending = [node];
    while (pending.length > 0) {
        const current = pending.pop();
        if (!current || typeof current !== "object") continue;
        redactFields(current, ["href"]);
        if (Array.isArray(current.children)) pending.push(...current.children);
    }
}

const RESULT_REDACTORS = new Map([
    ["read_network", (data) => redactEachUrl(data, ["url"])],
    ["get_network_requests", (data) => redactEachUrl(data, ["url"])],
    ["stop_trace", (trace) => {
        redactFields(trace, ["startUrl", "endUrl"]);
        // `url` on network and history events, `from` and `to` on URL changes.
        redactEachUrl(trace && trace.events, ["url", "from", "to"]);
    }],
    ["snapshot", redactSnapshotLinks],
    ["read_page", redactSnapshotLinks],
]);

function redactResult(action, data) {
    const redactor = RESULT_REDACTORS.get(action);
    if (redactor) redactor(data);
    return data;
}

// The tab tools that never fall back to the active tab. `tabs_close` and
// `select_tab` demand a tab by name: closing whatever happens to be in front
// because the caller left it out would be the wrong default. The other two have
// no target tab to resolve.
const TAB_FREE_ACTIONS = new Set(["tabs_query", "tabs_create", "tabs_close", "select_tab"]);

function actsOnATab(action) {
    return !TAB_FREE_ACTIONS.has(action)
        && (BACKGROUND_HANDLERS.has(action) || CONTENT_ACTIONS.has(action) || CONTENT_PROXIES.has(action));
}

// A call that names no tab used to look the active tab up again at every step:
// once per frame, once per follow-up. The user can change tabs between any two
// of those, so one request could act on two pages. The target is decided here,
// once, and travels as `params.tabId` from then on.
async function withResolvedTab(action, params) {
    if (!actsOnATab(action) || params.tabId) return params;
    return { ...params, tabId: await getActiveTabId() };
}

async function handleRequest(request) {
    const { id, action, params: requested } = request;
    let resolvedTabId = null;

    try {
        const params = await withResolvedTab(action, requested ?? {});
        resolvedTabId = params.tabId ?? null;
        const data = redactResult(action, await routeAction(action, params));
        return {
            id,
            success: true,
            // `JSON.stringify(undefined)` is the value undefined rather than a
            // string, and the outer stringify then drops the key altogether, so
            // the server saw a successful reply with no data at all and reported
            // it as a failure with no reason. `snapshotAcrossFrames` returning
            // nothing for a falsy top-level tree is one way in; the coalesce is
            // a floor under every handler rather than a fix for that one.
            data: typeof data === "string" ? data : JSON.stringify(data ?? null),
            error: null,
            // The tab this request acted on, or null for a tool that acts on
            // none. Handed back so a caller sequencing several untabbed calls
            // can pin the rest of the sequence to the first one's tab.
            resolvedTabId,
        };
    } catch (err) {
        return failureResponse(id, err, resolvedTabId);
    }
}
