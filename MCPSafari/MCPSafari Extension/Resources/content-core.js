/**
 * Shared foundation for the content scripts: the namespace the rest hang
 * off, element uid bookkeeping, tool errors, event primitives, and the bridge
 * to the MAIN-world interceptors.
 */

(() => {
    // Every one of these files is re-injected by name when the background
    // script finds the content script missing, so each guards itself. This
    // one owns the namespace the others hang off, and publishes it only once
    // it is complete, so a half-loaded core is never taken for a whole one.
    if (window.__mcpSafari) return;

    // UID counter for element references
    let uidCounter = 0;
    const uidMap = new WeakMap();
    const reverseUidMap = new Map();
    let bridgeRequestCounter = 0;

    // Ids stay unique per frame without sharing the counter across these
    // files, which destructuring could only ever copy by value.
    function nextRequestId(prefix) {
        return `${prefix}-${Date.now()}-${++bridgeRequestCounter}`;
    }

    // Every frame runs its own copy of this script with its own counter, so a
    // bare "e1" is ambiguous across frames. The background knows which frame it
    // is addressing and stamps each request, so the id arrives with the work
    // rather than needing a handshake that a tool call could outrun.
    let frameId = 0;

    // Set from the stamp on each incoming request. Behind a function for the
    // same reason as the counter above.
    function setFrameId(id) {
        frameId = id;
    }

    function toolError(code, message, retryable, recoveryAction) {
        const error = new Error(message);
        error.code = code;
        error.retryable = retryable;
        error.recoveryAction = recoveryAction;
        return error;
    }

    function pointerEvent(type, opts) {
        const Ctor = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
        return new Ctor(type, opts);
    }

    // Escapes a value for use inside a quoted CSS attribute selector.
    function escapeCssString(value) {
        if (window.CSS && typeof window.CSS.escape === "function") {
            return window.CSS.escape(value);
        }
        return String(value).replace(/["\\]/g, "\\$&");
    }

    // The WeakRef lets the element go, but its entry here would outlive it.
    // A long agent session re-snapshotting a page that re-renders mints a fresh
    // uid every time, so without this the map grows for the life of the page.
    const uidFinalizer = typeof FinalizationRegistry === "function"
        ? new FinalizationRegistry((uid) => { reverseUidMap.delete(uid); })
        : null;

    function getUid(element) {
        if (uidMap.has(element)) return uidMap.get(element);
        const uid = `f${frameId}e${++uidCounter}`;
        uidMap.set(element, uid);
        reverseUidMap.set(uid, new WeakRef(element));
        if (uidFinalizer) uidFinalizer.register(element, uid);
        return uid;
    }

    function getElementByUid(uid) {
        const ref = reverseUidMap.get(uid);
        const element = ref ? ref.deref() : null;
        // Collection may have happened without the finalizer having run yet.
        if (ref && !element) reverseUidMap.delete(uid);
        return element;
    }

    function requestMainWorld(type, params = {}, timeoutMs = 3000) {
        return new Promise((resolve, reject) => {
            const id = nextRequestId("mcp");
            const timer = setTimeout(() => {
                window.removeEventListener("message", onMessage);
                reject(new Error(`${type} interceptor did not respond`));
            }, timeoutMs);

            function onMessage(event) {
                const message = event.data;
                if (event.source !== window || message?.source !== "MCPSafariPage") return;
                if (message.id !== id) return;
                clearTimeout(timer);
                window.removeEventListener("message", onMessage);
                if (message.error) {
                    reject(new Error(message.error));
                } else {
                    resolve(message.data);
                }
            }

            window.addEventListener("message", onMessage);
            window.postMessage({
                source: "MCPSafariContent",
                id,
                type,
                params,
            }, "*");
        });
    }

    // UI Events: keypress fires only for character-producing keys (Enter maps
    // to \r), and never for Ctrl/Meta combos.
    function firesKeypress(key, opts) {
        return (key.length === 1 || key === "Enter") && !opts.ctrlKey && !opts.metaKey;
    }

    // KeyboardEvent.code is physical-key based: letters are KeyX, digits Digit0-9.
    function keyCode(key) {
        if (key.length !== 1) return key;
        if (key >= "0" && key <= "9") return `Digit${key}`;
        if (/[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
        return key;
    }

    window.__mcpSafari = Object.assign(
        { loaded: new Set(["core"]) },
        { escapeCssString, firesKeypress, getElementByUid, getUid, keyCode, nextRequestId, pointerEvent, requestMainWorld, setFrameId, toolError }
    );
})();
