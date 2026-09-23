/** Dialog automation is opt-in: handle_dialog arms one dialog for 30 seconds. */
(() => {
    if (window.__mcpDialogInterceptorLoaded) return;
    window.__mcpDialogInterceptorLoaded = true;

    const MAX_DIALOGS = 100;
    const MAX_TEXT = 4096;
    const capturedDialogs = [];
    let droppedDialogs = 0;
    let policy = null;
    let timer;
    let originals = {};
    const wrappers = {};
    const bounded = (value) => String(value ?? "").slice(0, MAX_TEXT);

    function restore() {
        clearTimeout(timer);
        policy = null;
        for (const type of ["alert", "confirm", "prompt"]) {
            // Do not overwrite a patch installed by the page after ours.
            if (window[type] === wrappers[type]) window[type] = originals[type];
        }
    }

    for (const type of ["alert", "confirm", "prompt"]) {
        wrappers[type] = function (...args) {
            const current = policy;
            if (!current || Date.now() >= current.expiresAt) {
                restore();
                return originals[type].apply(this, args);
            }
            // Consume before calling anything page-controlled or re-entrant.
            restore();
            const result = type === "alert" ? undefined
                : current.action !== "accept" ? (type === "confirm" ? false : null)
                : type === "confirm" ? true : (current.promptText ?? String(args[1] ?? ""));
            const message = String(args[0] ?? "");
            const defaultValue = type === "prompt" ? String(args[1] ?? "") : null;
            if (capturedDialogs.length >= MAX_DIALOGS) {
                capturedDialogs.shift();
                droppedDialogs++;
            }
            capturedDialogs.push({
                type, message: bounded(message),
                defaultValue: defaultValue === null ? null : bounded(defaultValue),
                result: typeof result === "string" ? bounded(result) : result,
                truncated: message.length > MAX_TEXT || (defaultValue?.length ?? 0) > MAX_TEXT
                    || (typeof result === "string" && result.length > MAX_TEXT),
            });
            return result;
        };
    }

    window.__mcpHandleDialog = (params = {}) => {
        // Reading a captured result must not silently arm another interception.
        if (capturedDialogs.length) {
            const dialog = capturedDialogs.shift();
            const dropped = droppedDialogs;
            droppedDialogs = 0;
            return { handled: true, ...dialog, alreadyHandled: true, droppedDialogs: dropped };
        }
        restore();
        originals = Object.fromEntries(["alert", "confirm", "prompt"].map((type) => [type, window[type]]));
        policy = {
            action: params.action === "accept" ? "accept" : "dismiss",
            promptText: params.promptText == null ? null : bounded(params.promptText),
            expiresAt: Date.now() + 30_000,
        };
        for (const type of ["alert", "confirm", "prompt"]) window[type] = wrappers[type];
        timer = setTimeout(restore, 30_000);
        return { handled: false, armed: true, expiresInMs: 30_000, dialogsRemaining: 1 };
    };
    window.__mcpGetPendingDialogs = () => capturedDialogs.map((dialog) => ({ ...dialog }));
    window.addEventListener("pagehide", restore);
    window.addEventListener("message", (event) => {
        const message = event.data;
        if (event.source !== window || message?.source !== "MCPSafariContent" || message.type !== "handle_dialog") return;
        window.postMessage({
            source: "MCPSafariPage", id: message.id,
            data: window.__mcpHandleDialog(message.params || {}),
        }, "*");
    });
})();
