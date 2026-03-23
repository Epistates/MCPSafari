/**
 * MCPSafari Dialog Interceptor
 *
 * Patches window.alert, confirm, and prompt to capture dialogs
 * instead of blocking the JS event loop. The MCP handle_dialog tool
 * can then accept or dismiss them.
 *
 * Injected at document_start before page scripts run.
 */
(() => {
    if (window.__mcpDialogInterceptorLoaded) return;
    window.__mcpDialogInterceptorLoaded = true;

    const pendingDialogs = [];
    const originalAlert = window.alert.bind(window);
    const originalConfirm = window.confirm.bind(window);
    const originalPrompt = window.prompt.bind(window);

    // Track resolve callbacks for pending dialogs so handle_dialog can
    // unblock them. Each entry: { type, message, defaultValue, resolve }
    // resolve(result) where result is: undefined (alert), true/false (confirm), string|null (prompt)

    window.alert = function (message) {
        return new Promise((resolve) => {
            pendingDialogs.push({
                type: "alert",
                message: String(message ?? ""),
                defaultValue: null,
                resolve: () => { resolve(); },
            });
        });
    };

    window.confirm = function (message) {
        return new Promise((resolve) => {
            pendingDialogs.push({
                type: "confirm",
                message: String(message ?? ""),
                defaultValue: null,
                resolve,
            });
        });
    };

    window.prompt = function (message, defaultValue) {
        return new Promise((resolve) => {
            pendingDialogs.push({
                type: "prompt",
                message: String(message ?? ""),
                defaultValue: defaultValue ?? "",
                resolve,
            });
        });
    };

    /**
     * Called by the content script's handle_dialog action.
     * @param {Object} params - { action: "accept"|"dismiss", promptText?: string }
     * @returns {{ handled: boolean, type?: string, message?: string }}
     */
    window.__mcpHandleDialog = (params) => {
        if (pendingDialogs.length === 0) {
            return { handled: false };
        }

        const dialog = pendingDialogs.shift();
        const action = params.action || "dismiss";

        switch (dialog.type) {
            case "alert":
                dialog.resolve();
                break;
            case "confirm":
                dialog.resolve(action === "accept");
                break;
            case "prompt":
                if (action === "accept") {
                    dialog.resolve(params.promptText ?? dialog.defaultValue ?? "");
                } else {
                    dialog.resolve(null);
                }
                break;
        }

        return {
            handled: true,
            type: dialog.type,
            message: dialog.message,
        };
    };

    /**
     * Returns info about pending dialogs without handling them.
     */
    window.__mcpGetPendingDialogs = () => {
        return pendingDialogs.map((d) => ({
            type: d.type,
            message: d.message,
            defaultValue: d.defaultValue,
        }));
    };
})();
