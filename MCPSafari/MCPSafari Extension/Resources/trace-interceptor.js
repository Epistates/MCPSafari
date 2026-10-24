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

    // ─── Attribute values ────────────────────────────────────────────

    // Frameworks mirror what a user types into the `value` attribute, so
    // recording old and new values of every attribute change wrote a typed
    // password into the trace. The same rule as the snapshot's redaction, kept
    // here because this file runs in the page's world and cannot read that one.
    // Tests/sensitive-field-rule.test.mjs fails if the two drift apart, so
    // change both together.
    //
    // BEGIN sensitive-field-rule
    const SENSITIVE_AUTOCOMPLETE = new Set([
        "current-password",
        "new-password",
        "one-time-code",
        "cc-number",
        "cc-csc",
        "cc-exp",
        "cc-exp-month",
        "cc-exp-year",
    ]);
    // A name or label is only a hint, so short words must match whole (`pin`
    // is a secret, `shipping` is not) and long ones may sit inside a longer
    // run (`newpassword`, `confirmPassword`).
    const SECRET_HINT_WORDS = new Set(["pass", "pwd", "pin", "otp", "cvv", "cvc", "cvn", "ssn", "secret", "token", "2fa"]);
    const SECRET_HINT_FRAGMENTS = ["password", "passwd", "passcode", "passphrase", "pincode", "secret", "token", "onetime"];
    // Types that carry a label or a fixed value rather than something typed.
    const NON_SECRET_TYPES = new Set(["button", "submit", "reset", "image", "checkbox", "radio", "file", "range", "color"]);

    function hintLooksSecret(hint) {
        const words = String(hint)
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
        const joined = words.join("");
        return words.some((word) => SECRET_HINT_WORDS.has(word))
            || SECRET_HINT_FRAGMENTS.some((fragment) => joined.includes(fragment));
    }

    function isSensitiveField({ tag, type, autocomplete, hints }) {
        if (tag !== "input" && tag !== "textarea") return false;
        const kind = String(type || "").toLowerCase();
        if (kind === "password") return true;
        if (String(autocomplete || "").toLowerCase().split(/\s+/).some((token) => SENSITIVE_AUTOCOMPLETE.has(token))) {
            return true;
        }
        if (tag === "input" && NON_SECRET_TYPES.has(kind)) return false;
        return hints.some((hint) => hint && hintLooksSecret(hint));
    }
    // END sensitive-field-rule

    // Unlike the snapshot there is no remembering that a field was once a
    // password: a trace is a short window and, whatever the field's type is by
    // then, its `value` and `checked` are never recorded below.
    function isSensitiveElement(node) {
        const attr = (name) => (typeof node.getAttribute === "function" ? node.getAttribute(name) : null);
        return isSensitiveField({
            tag: node.tagName ? node.tagName.toLowerCase() : "",
            type: attr("type"),
            autocomplete: attr("autocomplete"),
            hints: [attr("name"), node.id, attr("aria-label"), attr("inputmode"), attr("autocomplete")],
        });
    }

    // Long enough for a class list or an inline style, short enough that one
    // mutation cannot carry a page's worth of data into the trace.
    const MAX_ATTRIBUTE_VALUE = 512;
    const ALWAYS_OMITTED_ATTRIBUTES = new Set(["value", "checked"]);

    function boundedValue(value, detail) {
        if (typeof value !== "string" || value.length <= MAX_ATTRIBUTE_VALUE) return value;
        detail.truncated = true;
        return value.slice(0, MAX_ATTRIBUTE_VALUE);
    }

    function attributeValues(mutation) {
        const detail = {};
        const name = String(mutation.attributeName).toLowerCase();
        // Said rather than silently absent, so a trace reader can tell "the
        // value was withheld" from "nothing changed".
        if (ALWAYS_OMITTED_ATTRIBUTES.has(name) || isSensitiveElement(mutation.target)) {
            detail.valueOmitted = true;
            return detail;
        }
        if (mutation.oldValue !== null) detail.oldValue = boundedValue(mutation.oldValue, detail);
        detail.value = boundedValue(mutation.target.getAttribute(mutation.attributeName), detail);
        return detail;
    }

    function pushEvent(trace, type, detail = {}, at = now()) {
        if (trace.eventTypes && !trace.eventTypes.has(type)) return;
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
                    Object.assign(detail, attributeValues(mutation));
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
            eventTypes: Array.isArray(params.eventTypes) ? new Set(params.eventTypes) : null,
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
