/**
 * MCPSafari Content Script
 *
 * Loaded last. Routes one bridge action to the handler that owns it and
 * answers the background script.
 */

(() => {
    const mcp = window.__mcpSafari;
    if (!mcp || mcp.loaded.has("dispatch")) return;
    mcp.loaded.add("dispatch");
    const { clickElement, dragElement, dropFile, elementRect, findElements, formInput, getConsoleMessages, getNetworkRequests, getPageText, handleDialog, hoverElement, nativePointerPoints, prepareNativeInput, prepareNativeKey, pressKey, readPage, scrollPage, selectOption, setFrameId, startTrace, stopTrace, takeSnapshot, typeText, uploadFile, waitFor } = mcp;

    // ─── Message Handler ─────────────────────────────────────────────

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // Only handle messages meant for content scripts
        if (!message || !message.action) return false;

        if (typeof message.frameId === "number") setFrameId(message.frameId);

        handleAction(message.action, message.params || {})
            .then((data) => sendResponse({ data, error: null }))
            .catch((err) => sendResponse({
                data: null,
                error: String(err.message || err),
                errorCode: typeof err.code === "string" ? err.code : "extension_error",
                retryable: err.retryable === true,
                recoveryAction: typeof err.recoveryAction === "string"
                    ? err.recoveryAction
                    : "inspect_error",
            }));

        return true; // async response
    });

    async function handleAction(action, params) {
        switch (action) {
            case "read_page":
                return readPage(params);
            case "get_page_text":
                return getPageText();
            case "snapshot":
                return takeSnapshot(params);
            case "find":
                return findElements(params);
            case "click":
                return clickElement(params);
            case "type_text":
                return typeText(params);
            case "prepare_native_input":
                return prepareNativeInput(params);
            case "form_input":
                return formInput(params);
            case "select_option":
                return selectOption(params);
            case "scroll":
                return scrollPage(params);
            case "press_key":
                return pressKey(params);
            case "hover":
                return hoverElement(params);
            case "drag":
                return dragElement(params);
            case "native_pointer_points":
                return nativePointerPoints(params);
            case "prepare_native_key":
                return prepareNativeKey(params);
            case "upload_file":
                return uploadFile(params);
            case "drop_file":
                return dropFile(params);
            case "element_rect":
                return elementRect(params);
            case "wait":
                return waitFor(params);
            case "start_trace":
                return startTrace(params);
            case "stop_trace":
                return stopTrace(params);
            case "handle_dialog":
                return handleDialog(params);
            case "get_console_messages":
                return getConsoleMessages(params);
            case "get_network_requests":
                return getNetworkRequests(params);
            default:
                throw new Error(`Unknown content action: ${action}`);
        }
    }

})();
