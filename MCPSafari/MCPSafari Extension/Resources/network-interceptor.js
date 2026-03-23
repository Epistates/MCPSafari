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
                requests.push({
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
                });
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
            requests.push({
                type: "fetch",
                method,
                url,
                status: response.status,
                statusText: response.statusText,
                duration: Date.now() - startTime,
                timestamp: startTime,
            });

            return response;
        } catch (err) {
            if (requests.length >= MAX_REQUESTS) requests.shift();
            requests.push({
                type: "fetch",
                method,
                url,
                status: 0,
                statusText: "Network Error",
                duration: Date.now() - startTime,
                timestamp: startTime,
                error: String(err.message || err),
            });
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
})();
