import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/network-interceptor.js", import.meta.url),
    "utf8"
);

function loadInterceptor({ observerThrows = false } = {}) {
    let observer;
    const nativeFetchCalls = [];

    // Stands in for the browser's own: it records what the wrapper hands down.
    class XMLHttpRequest {
        constructor() { this.listeners = {}; this.status = 200; this.statusText = "OK"; }
        open(...args) { this.opened = args; }
        send() {}
        addEventListener(type, listener) { this.listeners[type] = listener; }
    }

    // A Request carries its own method and url, which is all the wrapper reads.
    class Request {
        constructor(url, init) {
            this.url = url;
            this.method = String(init?.method ?? "GET").toUpperCase();
        }
    }

    class PerformanceObserver {
        constructor() {
            observer = { options: null, records: [] };
            if (observerThrows) throw new TypeError("PerformanceObserver unavailable");
        }

        observe(options) {
            observer.options = options;
        }

        takeRecords() {
            return observer.records.splice(0);
        }
    }

    const window = {
        addEventListener() {},
        fetch: async (input, ...rest) => {
            nativeFetchCalls.push([input, ...rest]);
            return {
                status: String(input).includes("feed") ? 200 : 404,
                statusText: "OK",
            };
        },
        postMessage() {},
    };
    window.window = window;

    vm.runInNewContext(source, {
        PerformanceObserver,
        Request,
        URL,
        XMLHttpRequest,
        location: { origin: "https://example.test" },
        performance: { timeOrigin: 1_700_000_000_000 },
        window,
    });

    return { observer, window, nativeFetchCalls, Request, XMLHttpRequest };
}

test("resource reads expose buffered subresource timings without changing the default feed", () => {
    const { observer, window } = loadInterceptor();

    assert.deepEqual(JSON.parse(JSON.stringify(observer.options)), { type: "resource", buffered: true });
    observer.records.push({
        name: "https://example.test/image.png",
        initiatorType: "img",
        transferSize: 1234,
        encodedBodySize: 934,
        decodedBodySize: 2048,
        startTime: 25,
        duration: 7,
    });

    assert.deepEqual(JSON.parse(JSON.stringify(window.__mcpGetNetworkRequests({ type: "resource" }))), [{
        type: "resource",
        url: "https://example.test/image.png",
        initiatorType: "img",
        transferSize: 1234,
        encodedBodySize: 934,
        decodedBodySize: 2048,
        startTime: 25,
        duration: 7,
        timestamp: 1_700_000_000_025,
    }]);
    assert.deepEqual(Array.from(window.__mcpGetNetworkRequests({ type: "all" })), []);
    window.__mcpGetNetworkRequests({ type: "resource", clear: true });
    assert.deepEqual(Array.from(window.__mcpGetNetworkRequests({ type: "resource" })), []);
});

function pushResources(observer, urls) {
    for (const [i, url] of urls.entries()) {
        observer.records.push({
            name: url,
            initiatorType: "img",
            transferSize: 0,
            encodedBodySize: 0,
            decodedBodySize: 0,
            startTime: i,
            duration: 1,
        });
    }
}

// Cross-realm results fail deepStrictEqual prototype checks; round-trip through JSON.
function readNetwork(window, params) {
    return JSON.parse(JSON.stringify(window.__mcpGetNetworkRequests(params)));
}

test("urlPattern filters resources and rejects invalid or expensive patterns", () => {
    const { observer, window } = loadInterceptor();
    pushResources(observer, [
        "https://example.test/variant-a.webp",
        "https://example.test/original.png",
        "https://example.test/variant-b.webp",
    ]);

    const matched = readNetwork(window, { type: "resource", urlPattern: "variant" });
    assert.deepEqual(matched.map((r) => r.url), [
        "https://example.test/variant-a.webp",
        "https://example.test/variant-b.webp",
    ]);

    assert.throws(() => readNetwork(window, { type: "resource", urlPattern: "([" }));
    assert.throws(() => readNetwork(window, { type: "resource", urlPattern: "(a+)+$" }), /Unsupported filter/);
});

test("maxResults returns the most recent entries", () => {
    const { observer, window } = loadInterceptor();
    pushResources(observer, [
        "https://example.test/1.png",
        "https://example.test/2.png",
        "https://example.test/3.png",
    ]);

    const limited = readNetwork(window, { type: "resource", maxResults: 2 });
    assert.deepEqual(limited.map((r) => r.url), [
        "https://example.test/2.png",
        "https://example.test/3.png",
    ]);
});

test("clear with a filter removes only the returned entries", () => {
    const { observer, window } = loadInterceptor();
    pushResources(observer, [
        "https://example.test/variant-a.webp",
        "https://example.test/original.png",
    ]);

    const cleared = readNetwork(window, { type: "resource", urlPattern: "variant", clear: true });
    assert.equal(cleared.length, 1);

    const remaining = readNetwork(window, { type: "resource" });
    assert.deepEqual(remaining.map((r) => r.url), ["https://example.test/original.png"]);
});

test("urlPattern also filters the fetch feed", async () => {
    const { window } = loadInterceptor();
    await window.fetch("https://example.test/api/feed");
    await window.fetch("https://example.test/api/health");

    const matched = readNetwork(window, { type: "fetch", urlPattern: "feed" });
    assert.deepEqual(matched.map((r) => r.url), ["https://example.test/api/feed"]);

    const limited = readNetwork(window, { maxResults: 1 });
    assert.deepEqual(limited.map((r) => r.url), ["https://example.test/api/health"]);
});

test("status filters the fetch feed by HTTP status", async () => {
    const { window } = loadInterceptor();
    await window.fetch("https://example.test/api/feed");
    await window.fetch("https://example.test/api/missing");

    assert.deepEqual(readNetwork(window, { status: 200 }).map((r) => r.url), [
        "https://example.test/api/feed",
    ]);
    assert.deepEqual(readNetwork(window, { status: 404 }).map((r) => r.url), [
        "https://example.test/api/missing",
    ]);
});

test("cross-origin entries with zeroed fields are marked timingRestricted", () => {
    const { observer, window } = loadInterceptor();
    observer.records.push(
        // Cross-origin, all fields zeroed: Timing-Allow-Origin withheld.
        { name: "https://cdn.other.test/a.png", initiatorType: "img", transferSize: 0, encodedBodySize: 0, decodedBodySize: 0, startTime: 1, duration: 0 },
        // Cross-origin with real timing: TAO granted, no marker.
        { name: "https://cdn.other.test/b.png", initiatorType: "img", transferSize: 0, encodedBodySize: 0, decodedBodySize: 500, startTime: 2, duration: 3 },
        // Same-origin cache hit: legitimately zero, no marker.
        { name: "https://example.test/cached.png", initiatorType: "img", transferSize: 0, encodedBodySize: 0, decodedBodySize: 0, startTime: 3, duration: 0 },
    );

    const entries = readNetwork(window, { type: "resource" });
    assert.equal(entries[0].timingRestricted, true);
    assert.equal(entries[1].timingRestricted, undefined);
    assert.equal(entries[2].timingRestricted, undefined);
});

test("a restricted entry is marked even though its duration is real", () => {
    const { observer, window } = loadInterceptor();
    // The timing allow check zeroes the byte counts and the connection-phase
    // fields, but leaves startTime and responseEnd readable — so the ordinary
    // uncached restricted resource has a real duration. Requiring duration === 0
    // would mark only the cached ones and let this case read as a cache hit.
    observer.records.push({
        name: "https://cdn.other.test/uncached.png",
        initiatorType: "img",
        transferSize: 0,
        encodedBodySize: 0,
        decodedBodySize: 0,
        startTime: 10,
        duration: 143,
    });

    const [entry] = readNetwork(window, { type: "resource" });
    assert.equal(entry.timingRestricted, true);
    assert.equal(entry.duration, 143);
});

test("XHR and fetch capture still install when PerformanceObserver is unavailable", async () => {
    const { window } = loadInterceptor({ observerThrows: true });

    await window.fetch("https://example.test/api/feed");

    assert.deepEqual(readNetwork(window, { type: "fetch" }).map((r) => r.url), [
        "https://example.test/api/feed",
    ]);
    assert.deepEqual(readNetwork(window, { type: "resource" }), []);
});


// The wrappers sit in front of every request the page makes, so a capture bug
// is a broken page. Each of these is a call the native function accepts.
test("fetch with a null init is captured and reaches the native call unchanged", async () => {
    const { window, nativeFetchCalls } = loadInterceptor();

    const response = await window.fetch("https://example.test/api/feed", null);

    assert.equal(response.status, 200);
    assert.deepEqual(nativeFetchCalls[0], ["https://example.test/api/feed", null]);
    assert.deepEqual(readNetwork(window, { type: "fetch" }).map((r) => [r.method, r.url]), [
        ["GET", "https://example.test/api/feed"],
    ]);
});

test("a Request carries its own method into the capture", async () => {
    const { window, Request } = loadInterceptor();

    await window.fetch(new Request("https://example.test/api/feed", { method: "post" }));
    await window.fetch(new Request("https://example.test/api/feed", { method: "POST" }), { method: "put" });
    await window.fetch(new Request("https://example.test/api/feed"));

    assert.deepEqual(readNetwork(window, { type: "fetch" }).map((r) => r.method), ["POST", "PUT", "GET"]);
});

test("fetch with a URL object or an odd init is still captured", async () => {
    const { window } = loadInterceptor();

    await window.fetch(new URL("https://example.test/api/feed"), { method: 5 });
    await window.fetch("https://example.test/api/feed", undefined);

    assert.deepEqual(readNetwork(window, { type: "fetch" }).map((r) => r.method), ["5", "GET"]);
});

test("a throwing init getter does not turn into a wrapper failure", async () => {
    const { window } = loadInterceptor();
    const init = { get method() { throw new Error("getter"); } };

    // The native fake does not read it, so the call succeeds; what matters is
    // that the capture's own read of it could not take the request down.
    const response = await window.fetch("https://example.test/api/feed", init);

    assert.equal(response.status, 200);
});

test("XMLHttpRequest.open tolerates a method that is not a string", () => {
    const { XMLHttpRequest } = loadInterceptor();

    for (const method of [undefined, null, 5, { toString: () => "get" }]) {
        const xhr = new XMLHttpRequest();
        assert.doesNotThrow(() => xhr.open(method, "https://example.test/x"), String(method));
        // The native open sees exactly what the page passed.
        assert.equal(xhr.opened[0], method);
    }
});

test("XMLHttpRequest.open with a lowercase method is captured upper-cased", () => {
    const { window, XMLHttpRequest } = loadInterceptor();
    const xhr = new XMLHttpRequest();

    xhr.open("post", "https://example.test/api/feed");
    xhr.send();
    xhr.listeners.loadend();

    assert.deepEqual(readNetwork(window, { type: "xhr" }).map((r) => [r.method, r.url]), [
        ["POST", "https://example.test/api/feed"],
    ]);
});

test("XMLHttpRequest.open tolerates a url that cannot become a string", () => {
    const { XMLHttpRequest } = loadInterceptor();
    const xhr = new XMLHttpRequest();
    const hostile = { toString() { throw new Error("no string for you"); } };

    assert.doesNotThrow(() => xhr.open("GET", hostile));
    assert.doesNotThrow(() => xhr.send());
});

test("resource URLs have a per-entry cap with a truncation marker", () => {
    const { observer, window } = loadInterceptor();
    pushResources(observer, ["https://example.test/" + "x".repeat(100_000)]);
    const result = readNetwork(window, { type: "resource" });
    assert.equal(result[0].url.length, 2048);
    assert.equal(result[0].truncated, true);
});
