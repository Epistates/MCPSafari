/**
 * MCPSafari Trace Interceptor
 *
 * Captures a short window of page activity for action debugging.
 * Injected in the page's main world so history and network/console patches
 * observe the same JavaScript objects as page code.
 */
(() => {
    if (window.__mcpTraceInterceptorLoaded) return;
    window.__mcpTraceInterceptorLoaded = true;

    const MAX_EVENTS = 1000;
    const URL_POLL_MS = 100;
    const traces = new Map();
    let traceCounter = 0;
    let urlTimer = null;
    let lastUrl = location.href;
    let domObserver = null;

    function now() {
        return Date.now();
    }

    function escapeCss(value) {
        if (window.CSS && typeof window.CSS.escape === "function") {
            return window.CSS.escape(value);
        }
        return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
    }

    function selectorFor(node) {
        if (!node || node.nodeType !== Node.ELEMENT_NODE) return null;
        if (node.id) return `#${escapeCss(node.id)}`;

        const parts = [];
        let current = node;

        while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 5) {
            let part = current.tagName.toLowerCase();
            const classes = Array.from(current.classList || []).slice(0, 2);
            if (classes.length > 0) {
                part += classes.map((name) => `.${escapeCss(name)}`).join("");
            }

            const parent = current.parentElement;
            if (parent) {
                const siblings = Array.from(parent.children).filter(
                    (child) => child.tagName === current.tagName
                );
                if (siblings.length > 1) {
                    part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
                }
            }

            parts.unshift(part);
            current = parent;
        }

        return parts.join(" > ");
    }

    function pushEvent(trace, type, detail = {}, at = now()) {
        if (trace.events.length >= MAX_EVENTS) {
            if (!trace.truncated) {
                trace.truncated = true;
                trace.events.push({
                    type: "trace.truncated",
                    at,
                    offset: at - trace.startTime,
                    limit: MAX_EVENTS,
                });
            }
            return;
        }

        trace.events.push({
            type,
            at,
            offset: at - trace.startTime,
            ...detail,
        });
    }

    function recordTraceEvent(type, detail = {}, at = now()) {
        if (traces.size === 0) return;
        for (const trace of traces.values()) {
            pushEvent(trace, type, detail, at);
        }
    }

    window.__mcpRecordTraceEvent = recordTraceEvent;

    function recordUrlChange(type, from, to, detail = {}) {
        if (!from || !to || from === to) return;
        const at = now();
        recordTraceEvent("url", { from, to, reason: type }, at);
        recordTraceEvent(type, { from, to, url: to, ...detail }, at);
        lastUrl = to;
    }

    function ensureUrlMonitor() {
        if (urlTimer !== null) return;
        urlTimer = setInterval(() => {
            if (traces.size === 0) {
                clearInterval(urlTimer);
                urlTimer = null;
                return;
            }
            const currentUrl = location.href;
            recordUrlChange("url.poll", lastUrl, currentUrl);
        }, URL_POLL_MS);
    }

    function ensureDomObserver() {
        if (domObserver || !document.documentElement) return;
        domObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                const detail = {
                    mutationType: mutation.type,
                    selector: selectorFor(mutation.target),
                };

                if (mutation.type === "attributes") {
                    detail.attribute = mutation.attributeName;
                    if (mutation.oldValue !== null) detail.oldValue = mutation.oldValue;
                    detail.value = mutation.target.getAttribute(mutation.attributeName);
                } else if (mutation.type === "childList") {
                    detail.added = mutation.addedNodes.length;
                    detail.removed = mutation.removedNodes.length;
                }

                recordTraceEvent("dom.mutation", detail);
            }
        });

        domObserver.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeOldValue: true,
        });
    }

    function cleanupIfIdle() {
        if (traces.size > 0) return;
        if (urlTimer !== null) {
            clearInterval(urlTimer);
            urlTimer = null;
        }
        if (domObserver) {
            domObserver.disconnect();
            domObserver = null;
        }
    }

    const originalPushState = history.pushState;
    const originalReplaceState = history.replaceState;

    history.pushState = function (...args) {
        const from = location.href;
        const result = originalPushState.apply(this, args);
        recordUrlChange("history.pushState", from, location.href);
        return result;
    };

    history.replaceState = function (...args) {
        const from = location.href;
        const result = originalReplaceState.apply(this, args);
        recordUrlChange("history.replaceState", from, location.href);
        return result;
    };

    window.addEventListener("popstate", () => {
        recordUrlChange("popstate", lastUrl, location.href);
    });

    window.addEventListener("hashchange", (event) => {
        recordUrlChange("hashchange", event.oldURL || lastUrl, event.newURL || location.href);
    });

    window.__mcpStartTrace = (params = {}) => {
        const startTime = now();
        const id = params.id || `trace-${startTime}-${++traceCounter}`;
        const trace = {
            id,
            startTime,
            startUrl: location.href,
            events: [],
            truncated: false,
        };

        traces.set(id, trace);
        lastUrl = location.href;
        ensureUrlMonitor();
        ensureDomObserver();
        pushEvent(trace, "trace.start", { url: trace.startUrl }, startTime);

        return { id, startTime, url: trace.startUrl };
    };

    window.__mcpStopTrace = (params = {}) => {
        const id = params.id;
        const trace = traces.get(id);
        if (!trace) {
            return {
                id,
                startTime: null,
                endTime: now(),
                durationMs: 0,
                startUrl: null,
                endUrl: location.href,
                truncated: false,
                events: [],
                error: "Trace not found. The page may have navigated or reloaded.",
            };
        }

        const endTime = now();
        pushEvent(trace, "trace.stop", { url: location.href }, endTime);
        traces.delete(id);
        cleanupIfIdle();

        return {
            id: trace.id,
            startTime: trace.startTime,
            endTime,
            durationMs: endTime - trace.startTime,
            startUrl: trace.startUrl,
            endUrl: location.href,
            truncated: trace.truncated,
            events: trace.events,
        };
    };

    window.addEventListener("message", (event) => {
        const message = event.data;
        if (event.source !== window || message?.source !== "MCPSafariContent") return;
        if (message.type !== "start_trace" && message.type !== "stop_trace") return;

        try {
            const data = message.type === "start_trace"
                ? window.__mcpStartTrace(message.params || {})
                : window.__mcpStopTrace(message.params || {});

            window.postMessage({
                source: "MCPSafariPage",
                id: message.id,
                data,
            }, "*");
        } catch (err) {
            window.postMessage({
                source: "MCPSafariPage",
                id: message.id,
                error: String(err.message || err),
            }, "*");
        }
    });
})();
