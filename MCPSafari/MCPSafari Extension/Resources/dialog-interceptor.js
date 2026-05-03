/**
 * MCPSafari Dialog Interceptor
 *
 * Patches window.alert, confirm, and prompt to capture dialogs without
 * replacing synchronous browser APIs with Promises. Confirm and prompt use
 * a default dismiss policy unless the MCP handle_dialog tool sets a new
 * policy before the next dialog.
 *
 * Injected at document_start before page scripts run.
 */
(() => {
    if (window.__mcpDialogInterceptorLoaded) return;
    window.__mcpDialogInterceptorLoaded = true;

    const capturedDialogs = [];
    let defaultDialogPolicy = { action: "dismiss", promptText: null };

    window.alert = function (message) {
        capturedDialogs.push({
            type: "alert",
            message: String(message ?? ""),
            defaultValue: null,
            result: undefined,
        });
        return undefined;
    };

    window.confirm = function (message) {
        const result = defaultDialogPolicy.action === "accept";
        capturedDialogs.push({
            type: "confirm",
            message: String(message ?? ""),
            defaultValue: null,
            result,
        });
        return result;
    };

    window.prompt = function (message, defaultValue) {
        const result = defaultDialogPolicy.action === "accept"
            ? (defaultDialogPolicy.promptText ?? defaultValue ?? "")
            : null;
        capturedDialogs.push({
            type: "prompt",
            message: String(message ?? ""),
            defaultValue: defaultValue ?? "",
            result,
        });
        return result;
    };

    /**
     * Called by the content script's handle_dialog action.
     * @param {Object} params - { action: "accept"|"dismiss", promptText?: string }
     * @returns {{ handled: boolean, type?: string, message?: string }}
     */
    window.__mcpHandleDialog = (params) => {
        defaultDialogPolicy = {
            action: params.action || "dismiss",
            promptText: params.promptText ?? null,
        };

        if (capturedDialogs.length === 0) {
            return { handled: false };
        }

        const dialog = capturedDialogs.shift();

        return {
            handled: true,
            type: dialog.type,
            message: dialog.message,
            result: dialog.result,
            alreadyHandled: true,
        };
    };

    /**
     * Returns info about pending dialogs without handling them.
     */
    window.__mcpGetPendingDialogs = () => {
        return capturedDialogs.map((d) => ({
            type: d.type,
            message: d.message,
            defaultValue: d.defaultValue,
            result: d.result,
        }));
    };

    window.addEventListener("message", (event) => {
        const message = event.data;
        if (event.source !== window || message?.source !== "MCPSafariContent") return;
        if (message.type !== "handle_dialog") return;

        window.postMessage({
            source: "MCPSafariPage",
            id: message.id,
            data: window.__mcpHandleDialog(message.params || {}),
        }, "*");
    });
})();
