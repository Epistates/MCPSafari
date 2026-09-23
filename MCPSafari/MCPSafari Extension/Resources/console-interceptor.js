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
    function captureText(args) {
        let truncated = args.length > 16;
        let visits = 0;
        const parts = args.slice(0, 16).map((value) => {
            try {
                if (typeof value === "string") {
                    if (value.length > MAX_TEXT) truncated = true;
                    return value.slice(0, MAX_TEXT);
                }
                return JSON.stringify(value, (_key, item) => {
                    if (++visits > 128) throw new Error("capture budget");
                    if (typeof item === "string" && item.length > 512) {
                        truncated = true;
                        return item.slice(0, 512);
                    }
                    return item;
                });
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
