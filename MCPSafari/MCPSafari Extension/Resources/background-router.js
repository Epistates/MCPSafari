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

async function routeAction(action, params) {
    const handler = BACKGROUND_HANDLERS.get(action);
    if (handler) return handler(params);

    if (CONTENT_ACTIONS.has(action)) return dispatchToContent(action, params);

    const proxy = CONTENT_PROXIES.get(action);
    if (proxy) return sendToContentScript(params.tabId, proxy(params));

    throw new Error(`Unknown action: ${action}`);
}

async function handleRequest(request) {
    const { id, action, params = {} } = request;

    try {
        const data = await routeAction(action, params);
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
        };
    } catch (err) {
        return failureResponse(id, err);
    }
}
