/**
 * MCPSafari Network Interceptor
 *
 * Captures XMLHttpRequest, fetch, and resource timings for the
 * read_network tool. Injected at document_start.
 */
(() => {
    if (window.__mcpNetworkInterceptorLoaded) return;
    window.__mcpNetworkInterceptorLoaded = true;

    const MAX_REQUESTS = 500;
    const requests = [];
    const resources = [];

    function recordTraceEvent(type, request) {
        try {
            if (typeof window.__mcpRecordTraceEvent === "function") {
                window.__mcpRecordTraceEvent(`network.${type}`, {
                    type,
                    method: request.method,
                    url: request.url,
                    status: request.status,
                    statusText: request.statusText,
                    duration: request.duration,
                    error: request.error,
                }, request.timestamp);
            }
        } catch (_) { /* trace capture must not affect network behavior */ }
    }

    // Cross-origin entries without Timing-Allow-Origin report zeroed size and
    // timing fields; mark them so zeros read as "not permitted", not "cache hit".
    function isTimingRestricted(entry) {
        try {
            if (new URL(entry.name).origin === location.origin) return false;
        } catch {
            return false;
        }
        return entry.transferSize === 0
            && entry.encodedBodySize === 0
            && entry.decodedBodySize === 0
            && entry.duration === 0;
    }

    function recordResources(entries) {
        for (const entry of entries) {
            if (resources.length >= MAX_REQUESTS) resources.shift();
            const record = {
                type: "resource",
                url: entry.name,
                initiatorType: entry.initiatorType,
                transferSize: entry.transferSize,
                encodedBodySize: entry.encodedBodySize,
                decodedBodySize: entry.decodedBodySize,
                startTime: entry.startTime,
                duration: entry.duration,
                timestamp: performance.timeOrigin + entry.startTime,
            };
            if (isTimingRestricted(entry)) record.timingRestricted = true;
            resources.push(record);
        }
    }

    const resourceObserver = new PerformanceObserver((list) => recordResources(list.getEntries()));
    resourceObserver.observe({ type: "resource", buffered: true });

    // ─── XMLHttpRequest Interception ─────────────────────────────────

    const XHROpen = XMLHttpRequest.prototype.open;
    const XHRSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...args) {
        this.__mcpMeta = {
            method: method.toUpperCase(),
            url: String(url),
            type: "xhr",
            startTime: null,
        };
        return XHROpen.call(this, method, url, ...args);
    };

    XMLHttpRequest.prototype.send = function (body) {
        if (this.__mcpMeta) {
            this.__mcpMeta.startTime = Date.now();

            this.addEventListener("loadend", () => {
                if (requests.length >= MAX_REQUESTS) requests.shift();
                const request = {
                    type: "xhr",
                    method: this.__mcpMeta.method,
                    url: this.__mcpMeta.url,
                    status: this.status,
                    statusText: this.statusText,
                    duration: Date.now() - this.__mcpMeta.startTime,
                    responseSize: this.responseText
                        ? this.responseText.length
                        : 0,
                    timestamp: this.__mcpMeta.startTime,
                };
                requests.push(request);
                recordTraceEvent("xhr", request);
            });
        }
        return XHRSend.call(this, body);
    };

    // ─── Fetch Interception ──────────────────────────────────────────

    const originalFetch = window.fetch;

    window.fetch = async function (input, init = {}) {
        const method = (init.method || "GET").toUpperCase();
        const url =
            typeof input === "string"
                ? input
                : input instanceof Request
                  ? input.url
                  : String(input);
        const startTime = Date.now();

        try {
            const response = await originalFetch.call(this, input, init);

            if (requests.length >= MAX_REQUESTS) requests.shift();
            const request = {
                type: "fetch",
                method,
                url,
                status: response.status,
                statusText: response.statusText,
                duration: Date.now() - startTime,
                timestamp: startTime,
            };
            requests.push(request);
            recordTraceEvent("fetch", request);

            return response;
        } catch (err) {
            if (requests.length >= MAX_REQUESTS) requests.shift();
            const request = {
                type: "fetch",
                method,
                url,
                status: 0,
                statusText: "Network Error",
                duration: Date.now() - startTime,
                timestamp: startTime,
                error: String(err.message || err),
            };
            requests.push(request);
            recordTraceEvent("fetch", request);
            throw err;
        }
    };

    // ─── API for content script ──────────────────────────────────────

    window.__mcpGetNetworkRequests = (params = {}) => {
        recordResources(resourceObserver.takeRecords());
        const selected = params.type === "resource" ? resources : requests;
        let filtered = [...selected];

        if (params.type && params.type !== "all") {
            filtered = filtered.filter((r) => r.type === params.type);
        }

        if (params.urlPattern) {
            try {
                const regex = new RegExp(params.urlPattern);
                filtered = filtered.filter((r) => regex.test(r.url));
            } catch {
                // Invalid regex, ignore filter
            }
        }

        if (params.status != null) {
            filtered = filtered.filter((r) => r.status === params.status);
        }

        if (params.maxResults > 0) {
            filtered = filtered.slice(-params.maxResults);
        }

        if (params.clear) {
            // Clear exactly what this call returned, so a filtered read
            // never discards entries the caller never saw.
            const returned = new Set(filtered);
            for (let i = selected.length - 1; i >= 0; i--) {
                if (returned.has(selected[i])) {
                    selected.splice(i, 1);
                }
            }
        }

        return filtered;
    };

    window.addEventListener("message", (event) => {
        const message = event.data;
        if (event.source !== window || message?.source !== "MCPSafariContent") return;
        if (message.type !== "get_network_requests") return;

        window.postMessage({
            source: "MCPSafariPage",
            id: message.id,
            data: window.__mcpGetNetworkRequests(message.params || {}),
        }, "*");
    });
})();
