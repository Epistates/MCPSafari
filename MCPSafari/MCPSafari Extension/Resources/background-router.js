"use strict";

// handleRequest: one bridge request in, one response out.

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

