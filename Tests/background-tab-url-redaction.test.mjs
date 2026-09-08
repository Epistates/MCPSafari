import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/background.js", import.meta.url),
    "utf8"
);

const CALLBACK = "https://app.example/cb?code=FAKE-CODE&state=xyz#access_token=FAKE-TOKEN&token_type=bearer";
const REDACTED = "https://app.example/cb?code=[redacted]&state=xyz#access_token=[redacted]&token_type=bearer";

// Every tab the fake browser knows about sits on the OAuth callback URL, so any
// handler that leaks the raw URL fails the same assertion.
function loadBackground() {
    const tab = { id: 7, url: CALLBACK, title: "Signing in", active: true, windowId: 1 };
    const browser = {
        alarms: { create() {}, onAlarm: { addListener() {} } },
        runtime: {
            getManifest: () => ({ version: "9.9.9" }),
            onMessage: { addListener() {} },
            sendNativeMessage: async () => ({ tokens: {} }),
        },
        storage: {
            local: { get: async () => ({}), set() {} },
            session: { get: async () => ({}), set() {}, remove: async () => {} },
        },
        tabs: {
            query: async () => [tab],
            get: async () => tab,
            create: async () => ({ id: 8, url: CALLBACK, title: "" }),
            update: async () => {},
            reload: async () => {},
            onUpdated: { addListener() {}, removeListener() {} },
        },
        windows: { update: async () => {} },
    };

    const context = vm.createContext({
        browser,
        clearTimeout() {},
        console: { error() {}, log() {}, warn() {} },
        Date,
        Promise,
        setTimeout: () => {},
        WebSocket: class { send() {} },
    });
    vm.runInContext(source, context);
    return (expression) => vm.runInContext(expression, context);
}

test("redactUrlSecrets masks bearer values in query and fragment and keeps the rest", () => {
    const evaluate = loadBackground();
    const redact = (url) => evaluate(`redactUrlSecrets(${JSON.stringify(url)})`);

    assert.equal(redact(CALLBACK), REDACTED);
    assert.equal(
        redact("https://a.example/reset?password=hunter2&API_KEY=k1&id_token=t&refresh_token=r&client_secret=s&next=%2Fhome"),
        "https://a.example/reset?password=[redacted]&API_KEY=[redacted]&id_token=[redacted]&refresh_token=[redacted]&client_secret=[redacted]&next=%2Fhome"
    );
    // A hash-routed SPA callback still has ? and & delimiters inside the fragment.
    assert.equal(
        redact("https://spa.example/#/cb?code=FAKE&state=s"),
        "https://spa.example/#/cb?code=[redacted]&state=s"
    );
    // Providers may echo `state` without a value; the code is still an OAuth code.
    assert.equal(redact("https://app.example/cb?code=FAKE&state"), "https://app.example/cb?code=[redacted]&state");
    // `&` is legal in a path and must not start a match that swallows the query.
    assert.equal(
        redact("https://app.example/a&password=chapter?view=full"),
        "https://app.example/a&password=chapter?view=full"
    );
    assert.equal(redact("https://app.example/plain/path"), "https://app.example/plain/path");
    assert.equal(redact(""), "");
    assert.equal(redact(undefined), "");
});

test("code is only redacted next to state, so SKUs and coupons pass through", () => {
    const evaluate = loadBackground();
    const redact = (url) => evaluate(`redactUrlSecrets(${JSON.stringify(url)})`);

    assert.equal(redact("https://shop.example/item?code=SKU-42"), "https://shop.example/item?code=SKU-42");
    assert.equal(redact("https://shop.example/cart?promo=1&code=SAVE10"), "https://shop.example/cart?promo=1&code=SAVE10");
    // Parameter names are matched whole: mystate is not state, and a
    // password-shaped prefix does not widen the match.
    assert.equal(redact("https://x.example/?code=abc&mystate=1"), "https://x.example/?code=abc&mystate=1");
    assert.equal(redact("https://x.example/?password_hint=cat"), "https://x.example/?password_hint=cat");
});

test("tab handlers return the redacted URL", async () => {
    const evaluate = loadBackground();

    const [queried] = await evaluate("handleTabsQuery()");
    assert.equal(queried.url, REDACTED);
    assert.equal(queried.title, "Signing in");

    const created = await evaluate(`handleTabsCreate({ url: ${JSON.stringify(CALLBACK)} })`);
    assert.equal(created.url, REDACTED);

    const selected = await evaluate("handleSelectTab({ tabId: 7 })");
    assert.equal(selected.url, REDACTED);
    assert.equal(selected.selected, true);

    // `reload` resolves through waitForTabLoad's no-navigation timeout, which the
    // harness's inert setTimeout never fires, so drive the summary line directly.
    evaluate("waitForTabLoad = async (tabId) => browser.tabs.get(tabId)");
    const navigated = await evaluate("handleNavigate({ tabId: 7, action: 'reload' })");
    assert.equal(navigated, `Reloaded ${REDACTED} (Signing in)`);
});
