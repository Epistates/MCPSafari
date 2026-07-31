import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/network-interceptor.js", import.meta.url),
    "utf8"
);

function loadInterceptor() {
    let observer;

    class XMLHttpRequest {
        open() {}
        send() {}
    }

    class PerformanceObserver {
        constructor() {
            observer = { options: null, records: [] };
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
        fetch: async (input) => ({
            status: String(input).includes("feed") ? 200 : 404,
            statusText: "OK",
        }),
        postMessage() {},
    };
    window.window = window;

    vm.runInNewContext(source, {
        PerformanceObserver,
        URL,
        XMLHttpRequest,
        location: { origin: "https://example.test" },
        performance: { timeOrigin: 1_700_000_000_000 },
        window,
    });

    return { observer, window };
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

test("urlPattern filters resources by regex and ignores invalid patterns", () => {
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

    const unfiltered = readNetwork(window, { type: "resource", urlPattern: "([" });
    assert.equal(unfiltered.length, 3);
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
