import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { backgroundScriptSource } from "./helpers/extension-sources.mjs";

const source = backgroundScriptSource();

const SECRET_URL = "https://api.example/v1/items?access_token=LEAK1&page=2";
const REDACTED_URL = "https://api.example/v1/items?access_token=[redacted]&page=2";

// Page data comes back from the content script verbatim, so this drives the
// router with a content script that reports URLs carrying credentials.
function loadBackground(respond) {
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        scripting: { executeScript: async () => [{ result: true }] },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            get: async (id) => ({ id, active: true, windowId: 1, url: "https://ok.example/" }),
            query: async () => [{ id: 1, active: true, windowId: 1 }],
            sendMessage: async (_tabId, message) => ({ data: respond(message), error: null }),
            onUpdated: { addListener() {}, removeListener() {} },
            onRemoved: { addListener() {} },
        },
        webNavigation: { getAllFrames: async () => [{ frameId: 0, parentFrameId: -1, url: "https://ok.example/" }] },
        windows: { update: async () => {} },
    };

    const context = vm.createContext({
        browser,
        clearTimeout() {},
        console: { error() {}, log() {}, warn() {} },
        Date,
        Error,
        Promise,
        URL,
        setTimeout: (callback, ms) => { if ((ms || 0) <= 200) queueMicrotask(callback); return 0; },
        WebSocket: class { send() {} },
    });
    vm.runInContext(source, context);

    const raw = (action, params = {}) => vm.runInContext(
        `handleRequest(${JSON.stringify({ id: "r1", action, params: { tabId: 1, ...params } })})`,
        context
    );
    const request = async (action, params = {}) => {
        const response = await raw(action, params);
        assert.equal(response.success, true, response.error);
        // A string result travels as itself rather than as JSON.
        try {
            return JSON.parse(response.data);
        } catch {
            return response.data;
        }
    };
    // The whole response, for a call that is expected to fail.
    request.raw = raw;
    return request;
}

test("read_network reports request URLs without their credentials", async () => {
    const request = loadBackground(() => [
        { type: "fetch", method: "GET", url: SECRET_URL, status: 200 },
        { type: "resource", url: "https://cdn.example/a.js?X-Amz-Signature=LEAK2", initiatorType: "script" },
        { type: "xhr", method: "GET", url: "https://user:LEAK3@host.example/x", status: 200 },
    ]);

    const records = await request("read_network", {});

    assert.equal(records[0].url, REDACTED_URL);
    assert.equal(records[1].url, "https://cdn.example/a.js?X-Amz-Signature=[redacted]");
    assert.equal(records[2].url, "https://[redacted]@host.example/x");
    assert.doesNotMatch(JSON.stringify(records), /LEAK/);
    // Everything else about the record is as the page reported it.
    assert.equal(records[0].status, 200);
});

// ─── urlPattern ──────────────────────────────────────────────────────

// Stands in for network-interceptor.js as the extension drives it: it filters by
// type and status, can number what it returns, and clears by number. It holds
// the URLs unredacted, as the real one does, and throws if it is ever given a
// pattern, since a filter run there is the oracle this is guarding against.
function networkPage(records) {
    const held = records.map((record, index) => ({ ...record, held: index + 1 }));
    const messages = [];
    const respond = (message) => {
        const params = message.params;
        messages.push(params);
        if (params.urlPattern) throw new Error("the page was asked to filter by URL");
        if (Array.isArray(params.clearIds)) {
            for (let i = held.length - 1; i >= 0; i--) {
                if (params.clearIds.includes(held[i].held)) held.splice(i, 1);
            }
            return [];
        }
        return held
            .filter((record) => !params.type || params.type === "all" || record.type === params.type)
            .filter((record) => params.status == null || record.status === params.status)
            .map(({ held: id, ...record }) => (params.includeIds ? { ...record, id } : record));
    };
    return { respond, messages, remaining: () => held.map((record) => record.url) };
}

const TOKENS = [
    { type: "fetch", url: "https://api.example/a?token=SECRET1", status: 200 },
    { type: "fetch", url: "https://api.example/b?page=2", status: 200 },
    { type: "fetch", url: "https://api.example/c?token=SECRET2", status: 500 },
];

test("urlPattern is matched against the URL as it will be reported, never the secret in it", async () => {
    const page = networkPage(TOKENS);
    const request = loadBackground(page.respond);

    // The pattern that would confirm a guess at the secret finds nothing...
    assert.deepEqual(await request("read_network", { urlPattern: "token=SECRET1" }), []);
    assert.deepEqual(await request("read_network", { urlPattern: "token=S" }), []);
    // ...and one written against what the caller can see finds the entry.
    const found = await request("read_network", { urlPattern: "token=\\[redacted\\]" });
    assert.deepEqual(found.map((record) => record.url), [
        "https://api.example/a?token=[redacted]",
        "https://api.example/c?token=[redacted]",
    ]);
    assert.doesNotMatch(JSON.stringify(found), /SECRET/);
    assert.ok(page.messages.every((params) => !params.urlPattern), "the pattern reached the page");
});

test("urlPattern composes with the other filters, and the page's numbering stays out of the result", async () => {
    const request = loadBackground(networkPage(TOKENS).respond);

    const failed = await request("read_network", { urlPattern: "api\\.example", status: 500 });
    assert.deepEqual(failed.map((record) => record.url), ["https://api.example/c?token=[redacted]"]);
    assert.equal("id" in failed[0], false);

    // maxResults is the most recent N of the entries that matched, not of all.
    const latest = await request("read_network", { urlPattern: "token", maxResults: 1 });
    assert.deepEqual(latest.map((record) => record.url), ["https://api.example/c?token=[redacted]"]);
});

test("clear with a urlPattern removes exactly the entries it returned", async () => {
    const page = networkPage(TOKENS);
    const request = loadBackground(page.respond);

    const cleared = await request("read_network", { urlPattern: "token", maxResults: 1, clear: true });

    assert.equal(cleared.length, 1);
    assert.deepEqual(page.remaining(), [
        "https://api.example/a?token=SECRET1",
        "https://api.example/b?page=2",
    ]);
});

test("without a urlPattern the page filters, limits and clears as before", async () => {
    const page = networkPage(TOKENS);
    const request = loadBackground(page.respond);

    await request("read_network", { status: 200, maxResults: 5, clear: true });

    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].clear, true);
    assert.equal(page.messages[0].maxResults, 5);
    assert.equal(page.messages[0].includeIds, undefined);
});

test("a urlPattern outside the bounded subset is refused before the page is asked", async () => {
    for (const urlPattern of ["(a+)+$", "a*", "x".repeat(201), "["]) {
        const page = networkPage(TOKENS);
        const response = await loadBackground(page.respond).raw("read_network", { urlPattern });

        assert.equal(response.success, false, urlPattern);
        assert.equal(response.errorCode, "invalid_input", urlPattern);
        assert.equal(response.recoveryAction, "fix_input", urlPattern);
        assert.equal(page.messages.length, 0, `${urlPattern} reached the page`);
    }
});

test("a stopped trace reports its URLs without their credentials", async () => {
    const request = loadBackground(() => ({
        id: "t1",
        startUrl: "https://app.example/cb?code=LEAK1&state=s",
        endUrl: "https://app.example/home#id_token=LEAK2",
        events: [
            { type: "url", from: "https://app.example/a?token=LEAK3", to: "https://app.example/b", reason: "history.pushState" },
            { type: "network.fetch", url: SECRET_URL, method: "GET" },
            { type: "console.log", message: "unrelated" },
        ],
    }));

    const trace = await request("stop_trace", { id: "t1" });

    assert.equal(trace.startUrl, "https://app.example/cb?code=[redacted]&state=s");
    assert.equal(trace.endUrl, "https://app.example/home#id_token=[redacted]");
    assert.equal(trace.events[0].from, "https://app.example/a?token=[redacted]");
    assert.equal(trace.events[1].url, REDACTED_URL);
    assert.doesNotMatch(JSON.stringify(trace), /LEAK/);
});

test("a DOM mutation of a link reports the old and new address without their credentials", async () => {
    // The mutation observer records the attribute's before and after, which for
    // an href, src or form action is a URL like any other in the trace.
    const request = loadBackground(() => ({
        id: "t1",
        events: [
            {
                type: "dom.mutation", mutationType: "attributes", selector: "a#next", attribute: "href",
                oldValue: "https://app.example/old?access_token=LEAK1&p=1",
                value: "/cb?reset_token=LEAK2#frag",
            },
            { type: "dom.mutation", mutationType: "attributes", selector: "form", attribute: "action", value: "https://user:LEAK3@pay.example/submit" },
            { type: "dom.mutation", mutationType: "attributes", selector: "img", attribute: "SRC", value: "https://cdn.example/a.png?X-Amz-Signature=LEAK4" },
            // Not a URL attribute by name, but the value is one.
            { type: "dom.mutation", mutationType: "attributes", selector: "div", attribute: "data-next", value: "https://app.example/n?token=LEAK5" },
            // Neither, and so left exactly as it was.
            { type: "dom.mutation", mutationType: "attributes", selector: "div", attribute: "class", oldValue: "a", value: "a b?token=kept" },
            { type: "dom.mutation", mutationType: "childList", selector: "ul", added: 1, removed: 0 },
        ],
    }));

    const { events } = await request("stop_trace", { id: "t1" });

    assert.equal(events[0].oldValue, "https://app.example/old?access_token=[redacted]&p=1");
    assert.equal(events[0].value, "/cb?reset_token=[redacted]#frag");
    assert.equal(events[1].value, "https://[redacted]@pay.example/submit");
    assert.equal(events[2].value, "https://cdn.example/a.png?X-Amz-Signature=[redacted]");
    assert.equal(events[3].value, "https://app.example/n?token=[redacted]");
    assert.equal(events[4].value, "a b?token=kept");
    assert.equal(events[5].added, 1);
    assert.doesNotMatch(JSON.stringify(events), /LEAK/);
});

test("snapshot link hrefs are redacted at any depth, frames included", async () => {
    const tree = () => ({
        uid: "f0e1",
        tag: "body",
        children: [
            { uid: "f0e2", tag: "a", role: "link", href: "https://app.example/reset?reset_token=LEAK1" },
            {
                uid: "f0e3",
                tag: "div",
                children: [{ uid: "f0e4", tag: "a", role: "link", href: SECRET_URL }],
            },
        ],
    });
    const request = loadBackground(tree);

    for (const [action, params] of [["snapshot", {}], ["read_page", { format: "snapshot" }]]) {
        const result = await request(action, params);
        assert.equal(result.children[0].href, "https://app.example/reset?reset_token=[redacted]");
        assert.equal(result.children[1].children[0].href, REDACTED_URL);
        assert.doesNotMatch(JSON.stringify(result), /LEAK/);
    }
});

test("odd shapes from a hostile page are passed through rather than failing the call", async () => {
    for (const data of [null, "text", 5, [], { events: "nope" }, [null, 3, { url: 7 }], { events: [null, 3, "x", { type: "dom.mutation", value: 7 }] }]) {
        const request = loadBackground(() => data);
        // Both the network and trace redactors, and a plain read. `request`
        // asserts that each succeeded; what comes back is the page's own value,
        // untouched, which is the point of not refusing.
        const expected = JSON.parse(JSON.stringify(data));
        assert.deepEqual(await request("read_network", {}), expected);
        assert.deepEqual(await request("stop_trace", { id: "t" }), expected);
        assert.deepEqual(await request("read_page", { format: "text" }), expected);
    }
});
