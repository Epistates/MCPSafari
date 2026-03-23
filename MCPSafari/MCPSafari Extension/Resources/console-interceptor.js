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

    const levels = ["log", "warn", "error", "info", "debug"];
    const originals = {};

    for (const level of levels) {
        originals[level] = console[level].bind(console);
        console[level] = (...args) => {
            // Call the original
            originals[level](...args);

            // Capture the message
            if (messages.length >= MAX_MESSAGES) {
                messages.shift();
            }
            messages.push({
                level,
                timestamp: Date.now(),
                text: args
                    .map((a) => {
                        try {
                            return typeof a === "string" ? a : JSON.stringify(a);
                        } catch {
                            return String(a);
                        }
                    })
                    .join(" "),
            });
        };
    }

    // Capture unhandled errors
    window.addEventListener("error", (event) => {
        if (messages.length >= MAX_MESSAGES) messages.shift();
        messages.push({
            level: "error",
            timestamp: Date.now(),
            text: `Uncaught ${event.error ? event.error.stack || event.error.message : event.message}`,
        });
    });

    // Capture unhandled promise rejections
    window.addEventListener("unhandledrejection", (event) => {
        if (messages.length >= MAX_MESSAGES) messages.shift();
        messages.push({
            level: "error",
            timestamp: Date.now(),
            text: `Unhandled Promise Rejection: ${event.reason}`,
        });
    });

    // API for content script to read messages
    window.__mcpGetConsoleMessages = (params = {}) => {
        let filtered = [...messages];

        if (params.level && params.level !== "all") {
            filtered = filtered.filter((m) => m.level === params.level);
        }

        if (params.pattern) {
            try {
                const regex = new RegExp(params.pattern);
                filtered = filtered.filter((m) => regex.test(m.text));
            } catch {
                // Invalid regex, ignore filter
            }
        }

        if (params.clear) {
            // Only clear the messages that matched the filter, not the entire buffer
            if (params.level && params.level !== "all") {
                for (let i = messages.length - 1; i >= 0; i--) {
                    if (messages[i].level === params.level) {
                        messages.splice(i, 1);
                    }
                }
            } else {
                messages.length = 0;
            }
        }

        return filtered;
    };
})();
