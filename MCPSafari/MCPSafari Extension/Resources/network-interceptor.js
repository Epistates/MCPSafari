/**
 * MCPSafari Network Interceptor
 *
 * Patches XMLHttpRequest and fetch to capture network requests
 * for the read_network tool. Injected at document_start.
 */
(() => {
    if (window.__mcpNetworkInterceptorLoaded) return;
    window.__mcpNetworkInterceptorLoaded = true;

    const MAX_REQUESTS = 500;
    const requests = [];

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
        let filtered = [...requests];

        if (params.type && params.type !== "all") {
            filtered = filtered.filter((r) => r.type === params.type);
        }

        if (params.clear) {
            requests.length = 0;
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
