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

    // Random rather than a clock and a counter, so a page cannot compute the
    // id of a request it has not seen yet. That is only half the protection: the
    // request itself is posted to the window, where the page can read the id and
    // answer first, which is why the reply is validated as well.
    function nextRequestId(prefix) {
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        return `${prefix}-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
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

    // ─── Page-world replies ──────────────────────────────────────────

    // The MAIN-world scripts cap what they capture, but a reply arrives over
    // window.postMessage, which the page can answer too, and it can replace
    // `window.__mcpGetConsoleMessages` outright. So the caps are enforced again
    // here, on what actually arrived. One reply that ignored them would carry
    // past the bridge's 32 MiB frame limit, and an oversized frame drops the
    // bridge for every Safari profile, not just this tab.
    //
    // These repeat the figures in console-interceptor.js (1000 messages of 8192),
    // network-interceptor.js (500 records of 2048) and trace-interceptor.js (1000
    // events of 4096). A legitimate reply is never cut by them.
    const MAIN_WORLD_LIMITS = {
        get_console_messages: { entries: 1000, string: 8192 },
        get_network_requests: { entries: 500, string: 2048 },
        stop_trace: { entries: 1001, string: 4096 },
    };
    const DEFAULT_MAIN_WORLD_LIMITS = { entries: 100, string: 4096 };
    const MAX_REPLY_CHARS = 4 * 1024 * 1024;
    const MAX_REPLY_NODES = 50000;
    const MAX_REPLY_DEPTH = 5;
    const MAX_REPLY_KEYS = 64;
    const MAX_REPLY_ERROR_CHARS = 1024;

    // Reduces a reply to plain JSON data within the limits, or `undefined` for
    // a value that is not plain data at all (a function, a Date, a Map).
    // `budget` is shared across the whole reply, so many small values cannot
    // add up to a large one.
    function clampReplyValue(value, limits, budget, depth, owner) {
        if (++budget.nodes > MAX_REPLY_NODES) {
            budget.exhausted = true;
            return undefined;
        }
        if (value === null || typeof value === "boolean") return value;
        if (typeof value === "number") return Number.isFinite(value) ? value : null;
        if (typeof value === "string") {
            let text = value;
            if (text.length > limits.string) {
                text = text.slice(0, limits.string);
                if (owner) owner.truncated = true;
            }
            if (budget.chars + text.length > MAX_REPLY_CHARS) {
                budget.exhausted = true;
                return undefined;
            }
            budget.chars += text.length;
            return text;
        }
        if (depth >= MAX_REPLY_DEPTH || typeof value !== "object") return undefined;

        if (Array.isArray(value)) {
            const items = [];
            // Any list may hold up to `entries` items: the capture reads are
            // lists at the top, and a trace keeps its events one level down.
            // The shared budget is what stops a list of lists adding up.
            if (value.length > limits.entries && owner) owner.truncated = true;
            for (const item of value.slice(0, limits.entries)) {
                const clamped = clampReplyValue(item, limits, budget, depth + 1, null);
                if (budget.exhausted) {
                    if (owner) owner.truncated = true;
                    break;
                }
                if (clamped !== undefined) items.push(clamped);
            }
            return items;
        }

        // `toString` and not a prototype comparison: a Date, Map or typed array
        // is not plain data, and the page's realm is not this one.
        if (Object.prototype.toString.call(value) !== "[object Object]") return undefined;
        const copy = {};
        for (const key of Object.keys(value).slice(0, MAX_REPLY_KEYS)) {
            if (key === "__proto__" || key.length > 128) continue;
            // The page's own `truncated: false` must not undo a cut made here.
            if (key === "truncated" && copy.truncated === true) continue;
            // Arrays and strings mark `copy` as truncated when they are cut, so
            // a trace that lost events says so in the field it already has.
            const clamped = clampReplyValue(value[key], limits, budget, depth + 1, copy);
            if (budget.exhausted) {
                copy.truncated = true;
                break;
            }
            if (clamped !== undefined) copy[key] = clamped;
        }
        return copy;
    }

    // What each request type is allowed to answer with: a list for the capture
    // reads, an object for the rest. Anything else is refused rather than passed
    // on, since a caller indexing into the wrong shape would throw somewhere less
    // informative.
    const LIST_REPLIES = new Set(["get_console_messages", "get_network_requests"]);

    function validateMainWorldReply(type, data) {
        const limits = MAIN_WORLD_LIMITS[type] || DEFAULT_MAIN_WORLD_LIMITS;
        const budget = { nodes: 0, chars: 0, exhausted: false };
        const unexpected = () => new Error(`${type} interceptor returned an unexpected result`);

        if (LIST_REPLIES.has(type)) {
            if (!Array.isArray(data)) throw unexpected();
            // An entry is a record, so anything else in the list is not one.
            const records = data.filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry));
            return clampReplyValue(records, limits, budget, 0, null);
        }

        if (data === null || data === undefined) return data;
        const reply = clampReplyValue(data, limits, budget, 0, null);
        if (reply === undefined || Array.isArray(reply)) throw unexpected();
        return reply;
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
                    reject(new Error(String(message.error).slice(0, MAX_REPLY_ERROR_CHARS)));
                    return;
                }
                try {
                    resolve(validateMainWorldReply(type, message.data));
                } catch (err) {
                    reject(err);
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
