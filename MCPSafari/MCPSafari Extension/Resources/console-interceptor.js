/**
 * MCPSafari Console Interceptor
 *
 * Patches console methods to capture messages for the read_console tool.
 * Injected at document_start before page scripts run.
 */
(() => {
    if (window.__mcpConsoleInterceptorLoaded) return;
    window.__mcpConsoleInterceptorLoaded = true;

    const MAX_MESSAGES = 1000;
    const messages = [];
    const MAX_TEXT = 8192;
    const MAX_ERROR_STACK = 2048;

    // `JSON.stringify` has nothing to say about an Error (its fields are not
    // enumerable, so it writes `{}`), which turned `console.error(err)` and
    // every unhandled rejection into an empty message. The tag test rather than
    // `instanceof` because the error may come from another realm, a frame's own.
    function isError(value) {
        if (value instanceof Error) return true;
        const tag = Object.prototype.toString.call(value);
        return tag === "[object Error]" || tag === "[object DOMException]";
    }

    // Safari's `stack` is frames only, Chrome's opens with the message, so the
    // header is added when it is missing and not repeated when it is there.
    function describeError(error, markCut) {
        const name = String(error.name || "Error");
        const message = String(error.message ?? "");
        const header = (message ? `${name}: ${message}` : name).slice(0, 1024);
        const stack = typeof error.stack === "string" ? error.stack : "";
        const frames = (stack.startsWith(header) ? stack.slice(header.length) : stack).replace(/^\n/, "");
        if (frames.length > MAX_ERROR_STACK) markCut();
        return frames ? `${header}\n${frames.slice(0, MAX_ERROR_STACK)}` : header;
    }

    // What JSON would drop or throw on, written so a reader sees that something
    // was there: a function, a symbol, a BigInt, an Error nested in an object.
    function describeNonJson(item, markCut) {
        if (typeof item === "function") return `[Function ${item.name || "anonymous"}]`;
        if (typeof item === "symbol") return String(item);
        if (typeof item === "bigint") return `${item}n`;
        if (item && typeof item === "object" && isError(item)) return describeError(item, markCut);
        return item;
    }

    function captureText(args) {
        let truncated = args.length > 16;
        let visits = 0;
        const markCut = () => { truncated = true; };
        const parts = args.slice(0, 16).map((value) => {
            try {
                if (typeof value === "string") {
                    if (value.length > MAX_TEXT) truncated = true;
                    return value.slice(0, MAX_TEXT);
                }
                // JSON.stringify(undefined) is undefined, which join() would
                // render as nothing at all.
                if (value === undefined) return "undefined";
                const plain = describeNonJson(value, markCut);
                if (typeof plain === "string") return plain;
                return JSON.stringify(plain, (_key, item) => {
                    if (++visits > 128) throw new Error("capture budget");
                    if (typeof item === "string" && item.length > 512) {
                        truncated = true;
                        return item.slice(0, 512);
                    }
                    return describeNonJson(item, markCut);
                }) ?? "[unserializable or oversized value]";
            } catch { truncated = true; return "[unserializable or oversized value]"; }
        });
        const text = parts.join(" ");
        return { text: text.slice(0, MAX_TEXT), truncated: truncated || text.length > MAX_TEXT };
    }

    const levels = ["log", "warn", "error", "info", "debug"];
    const originals = {};

    function recordTraceEvent(level, text, timestamp) {
        try {
            if (typeof window.__mcpRecordTraceEvent === "function") {
                window.__mcpRecordTraceEvent(`console.${level}`, {
                    level,
                    message: text,
                }, timestamp);
            }
        } catch (_) { /* trace capture must not affect console behavior */ }
    }

    for (const level of levels) {
        originals[level] = console[level].bind(console);
        console[level] = (...args) => {
            // Call the original
            originals[level](...args);

            // Capture the message
            if (messages.length >= MAX_MESSAGES) {
                messages.shift();
            }
            const message = {
                level,
                timestamp: Date.now(),
                ...captureText(args),
            };
            messages.push(message);
            recordTraceEvent(level, message.text, message.timestamp);
        };
    }

    // Capture unhandled errors
    window.addEventListener("error", (event) => {
        if (messages.length >= MAX_MESSAGES) messages.shift();
        const message = {
            level: "error",
            timestamp: Date.now(),
            ...captureText([`Uncaught ${event.error ? event.error.stack || event.error.message : event.message}`]),
        };
        messages.push(message);
        recordTraceEvent("error", message.text, message.timestamp);
    });

    // Capture unhandled promise rejections
    window.addEventListener("unhandledrejection", (event) => {
        if (messages.length >= MAX_MESSAGES) messages.shift();
        const message = {
            level: "error",
            timestamp: Date.now(),
            ...captureText(["Unhandled Promise Rejection:", event.reason]),
        };
        messages.push(message);
        recordTraceEvent("error", message.text, message.timestamp);
    });

    // API for content script to read messages
    window.__mcpGetConsoleMessages = (params = {}) => {
        let filtered = [...messages];

        if (params.level && params.level !== "all") {
            filtered = filtered.filter((m) => m.level === params.level);
        }

        if (params.pattern) {
            // Bounded regex subset: no repetitions, groups, or backreferences.
            // Without these constructs, matching work is bounded by pattern × input.
            const pattern = String(params.pattern);
            const unescaped = pattern.replace(/\\./g, "");
            if (pattern.length > 200 || /[()*+?{}]/.test(unescaped) || /\\[1-9k]/.test(pattern)) {
                throw new Error("Unsupported filter: use at most 200 characters, with literals, dots, anchors, character classes, or alternation; no repetition, groups, or backreferences.");
            }
            const regex = new RegExp(pattern);
            filtered = filtered.filter((entry) => regex.test(entry.text));
        }

        if (params.clear) {
            // Clear exactly what this call returned, so a level- or pattern-filtered
            // read never discards messages the caller never saw.
            const returned = new Set(filtered);
            for (let i = messages.length - 1; i >= 0; i--) {
                if (returned.has(messages[i])) {
                    messages.splice(i, 1);
                }
            }
        }

        return filtered;
    };

    window.addEventListener("message", (event) => {
        const message = event.data;
        if (event.source !== window || message?.source !== "MCPSafariContent") return;
        if (message.type !== "get_console_messages") return;

        try {
            window.postMessage({
                source: "MCPSafariPage", id: message.id,
                data: window.__mcpGetConsoleMessages(message.params || {}),
            }, "*");
        } catch (error) {
            window.postMessage({ source: "MCPSafariPage", id: message.id, error: String(error.message || error) }, "*");
        }
    });
})();
