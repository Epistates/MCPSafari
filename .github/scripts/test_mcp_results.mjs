// Actual stdio MCP server + authenticated loopback extension fixture; no Safari UI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { backgroundScriptSource } from "../../Tests/helpers/extension-sources.mjs";
import { createContext, runInContext } from "node:vm";

const binary = process.env.MCPSAFARI_TEST_BINARY
    ?? fileURLToPath(new URL("../../MCPServer/.build/debug/MCPSafari", import.meta.url));
/// The bridge protocol both sides speak. `Diagnostics.swift` and `background-config.js`
/// declare it too; the handshake below only works if all three agree.
const BRIDGE_PROTOCOL_VERSION = 2;
const png ="iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1XkAAAAASUVORK5CYII=";

/// Every action the server asked the extension to perform during this run.
const sentActions = new Set();

/// The actions the real extension router can serve, read from its own dispatch
/// tables.
///
/// `background-router.js` evaluates on its own because each table entry defers
/// its handler behind an arrow, so nothing is dereferenced at load. That is
/// what makes it readable from here without standing up the whole background.
async function extensionRoutableActions() {
    const source = await readFile(
        fileURLToPath(new URL("../../MCPSafari/MCPSafari Extension/Resources/background-router.js", import.meta.url)),
        "utf8"
    );
    const context = createContext({});
    runInContext(source, context);
    return new Set([
        ...runInContext("[...BACKGROUND_HANDLERS.keys()]", context),
        ...runInContext("[...CONTENT_ACTIONS]", context),
        ...runInContext("[...CONTENT_PROXIES.keys()]", context),
    ]);
}

function bounded(promise, label, ms = 10000) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms); }),
    ]).finally(() => clearTimeout(timer));
}

test("every advertised tool returns object structuredContent over MCP", { timeout: 45000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "mcpsafari-results-"));
    const server = spawn(binary, ["--port", "0"], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = once(server, "exit");
    const lines = createInterface({ input: server.stdout });
    let stderr = "";
    server.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    const pending = new Map();
    let nextId = 1;
    let port, token;
    const sockets = [];
    t.after(async () => {
        for (const socket of sockets) socket.close();
        server.stdin.end();
        try { await bounded(exited, "server shutdown", 2000); }
        catch { server.kill("SIGKILL"); await bounded(exited, "kill server"); }
        lines.close();
        if (port && token) {
            const path = join(homedir(), "Library/Application Support/MCPSafari/tokens", String(port));
            // Never delete another process's replacement token.
            if (await readFile(path, "utf8").catch(() => null) === token) await rm(path);
        }
        await rm(directory, { recursive: true, force: true });
    });
    lines.on("line", (line) => {
        const message = JSON.parse(line);
        const callbacks = pending.get(message.id);
        if (!callbacks) return;
        pending.delete(message.id);
        if (message.error) callbacks.reject(new Error(JSON.stringify(message.error)));
        else callbacks.resolve(message.result);
    });
    server.on("error", (error) => { for (const request of pending.values()) request.reject(error); });
    server.on("exit", () => {
        for (const request of pending.values()) request.reject(new Error(`Server exited: ${stderr}`));
        pending.clear();
    });
    const send = (message) => server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    const call = (method, params = {}) => {
        const id = nextId++;
        const response = new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            send({ id, method, params });
        });
        return bounded(response, method).finally(() => pending.delete(id));
    };
    const exercised = new Set();
    const tool = async (name, args = {}, success = true) => {
        const result = await call("tools/call", { name, arguments: args });
        assert.equal(result.isError === true, !success, `${name}: ${JSON.stringify(result)}`);
        assert.ok(result.structuredContent && typeof result.structuredContent === "object"
            && !Array.isArray(result.structuredContent), `${name} has no structured object`);
        exercised.add(name);
        return result;
    };
    const initialize = await call("initialize", {
        protocolVersion: "2025-11-25", capabilities: {},
        clientInfo: { name: "result-contract-test", version: "1.0" },
    });
    assert.equal(initialize.serverInfo.name, "mcp-safari");
    send({ method: "notifications/initialized" });
    // The server answers `initialize` without waiting for its bridge to bind, so the
    // listener may still be coming up on the first look.
    let statusResult, status;
    for (let attempt = 0; attempt < 50; attempt++) {
        statusResult = await tool("status");
        status = statusResult.structuredContent.status;
        if (status.listener === "listening") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(status, JSON.parse(statusResult.content[0].text));
    assert.equal(status.listener, "listening");
    assert.ok(status.port > 0);
    port = status.port;
    token = await readFile(join(homedir(), "Library/Application Support/MCPSafari/tokens", String(port)), "utf8");

    let pageText = "Example Domain";
    let jsText = "42";
    let failAction;
    // The shape the extension sends: tabs_query entries carry the browser's tab
    // fields plus `access`, and url and title only for a granted site. An
    // ungranted tab also carries `accessHint`.
    const tab = {
        id: 7, active: true, pinned: false, audible: false, muted: false, status: "complete",
        windowId: 1, index: 0, access: "granted", url: "https://example.com/", title: "Example",
    };
    const ungrantedTab = (id) => ({
        id, active: false, pinned: false, audible: false, muted: false, status: "complete",
        windowId: 1, index: id, access: "not_granted",
        accessHint: "Grant access from the MCPSafari button in Safari's toolbar.",
    });
    let queryTabs = [tab];
    const snapshot = { uid: "f0e1", tag: "body", children: [] };
    const trace = { events: [{ type: "click", timestamp: 1 }] };
    const responseData = (action, params) => {
        switch (action) {
            case "tabs_query": return queryTabs;
            case "tabs_create": return { id: tab.id, access: "granted", url: tab.url, title: tab.title };
            case "select_tab": return { id: tab.id, selected: true, access: "granted", url: tab.url, title: tab.title };
            case "read_page": return params.format === "snapshot" ? snapshot : pageText;
            case "snapshot": return snapshot;
            case "find": return [{ uid: "f0e1", tag: "body" }];
            case "read_console": return [{ level: "log", message: "hello" }];
            case "read_network": return [{ url: "https://example.com/", status: 200 }];
            case "start_trace": return "trace-1";
            case "stop_trace": return trace;
            case "javascript_tool": return jsText;
            case "screenshot": return { image: png, viewport: { width: 1, height: 1 }, devicePixelRatio: 1, visible: true, hasFocus: true };
            case "wait": return { matched: true };
            default: return `Completed ${action}`;
        }
    };
    const connect = async (profileId, respond) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}`);
        sockets.push(socket);
        // The extension's half of the challenge-response handshake. The token is the
        // key to both proofs and is never sent; the fixture checks the server's proof
        // before it sends its own, as the extension does.
        const clientNonce = randomBytes(32).toString("base64url");
        let serverNonce;
        const proof = (role, first, second) => createHmac("sha256", token)
            .update(`mcpsafari-v${BRIDGE_PROTOCOL_VERSION}-${role}|${port}|${first}|${second}`)
            .digest("base64url");
        const authenticated = new Promise((resolve, reject) => {
            socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
            socket.addEventListener("open", () => socket.send(JSON.stringify({
                hello: { clientNonce, extensionVersion: "9.9.9", protocolVersion: BRIDGE_PROTOCOL_VERSION, profileId },
            })));
            socket.addEventListener("message", async ({ data }) => {
                const message = JSON.parse(data);
                if (message.challenge) {
                    serverNonce = message.challenge.serverNonce;
                    if (message.challenge.serverProof !== proof("server", clientNonce, serverNonce)) {
                        reject(new Error("The server's proof was wrong"));
                        return;
                    }
                    socket.send(JSON.stringify({ auth: { clientProof: proof("client", serverNonce, clientNonce) } }));
                    return;
                }
                if (message.auth) {
                    if (message.auth === "ok") resolve();
                    else reject(new Error(`Authentication failed: ${message.error}`));
                    return;
                }
                socket.send(JSON.stringify({ id: message.id, ...(await respond(message)) }));
            });
        });
        await bounded(authenticated, "extension authentication");
    };
    // How many requests for each action the extension holds at once, and for how
    // long it takes to answer one. The delay is what lets overlap happen at all.
    const inFlight = new Map();
    const peakInFlight = new Map();
    let answerDelayMs = 0;
    // Every request the extension received, in order, so a test can show that a
    // refused call never reached it.
    const received = [];
    // The tab the user has selected, which a request that names none acts on.
    // `moveSelectionAfter` makes the user switch tabs once that action has been
    // answered, the way they can while a multi-request call is still running.
    let selectedTab = 7;
    let moveSelectionAfter;
    const requests = [];
    const untargeted = new Set(["tabs_query", "tabs_create", "tabs_close", "select_tab"]);
    await connect("default", async ({ action, params }) => {
        sentActions.add(action);
        received.push(action);
        requests.push({ action, tabId: params.tabId });
        inFlight.set(action, (inFlight.get(action) ?? 0) + 1);
        peakInFlight.set(action, Math.max(peakInFlight.get(action) ?? 0, inFlight.get(action)));
        if (answerDelayMs) await new Promise((resolve) => setTimeout(resolve, answerDelayMs));
        inFlight.set(action, inFlight.get(action) - 1);
        // Reported on success and failure alike, null where no tab is involved.
        const resolvedTabId = untargeted.has(action) ? null : (params.tabId ?? selectedTab);
        if (action === moveSelectionAfter) selectedTab = 9;
        if (action === failAction) return { success: false, error: "Fixture refusal", errorCode: "permission_required", retryable: true, recoveryAction: "ask_user", resolvedTabId };
        const data = responseData(action, params);
        return { success: true, data: typeof data === "string" ? data : JSON.stringify(data), resolvedTabId };
    });

    const { tools } = await call("tools/list");
    const tabs = await tool("tabs_context");
    assert.equal(tabs.structuredContent.tabs[0].id, "p0t7");
    assert.deepEqual(tabs.structuredContent.profileFailures, []);
    // A granted listing has nothing to add. An ungranted one says so once for
    // the whole listing, with the extension's hint said once rather than per tab.
    assert.equal(tabs.content.length, 1);
    queryTabs = [tab, ungrantedTab(11), ungrantedTab(12)];
    const mixed = await tool("tabs_context");
    queryTabs = [tab];
    assert.equal(mixed.structuredContent.tabs.length, 3);
    assert.equal(mixed.structuredContent.tabs[1].access, "not_granted");
    assert.equal(mixed.content.length, 2);
    assert.match(mixed.content[1].text, /Access to 2 tabs' sites is not granted/);
    assert.equal(mixed.content[1].text.split("Grant access from the MCPSafari button").length - 1, 1);
    for (const name of ["tabs_create", "select_tab"]) {
        const result = await tool(name, name === "select_tab" ? { tabId: "p0t7" } : {});
        assert.equal(result.structuredContent.tab.id, "p0t7");
    }
    assert.deepEqual((await tool("close_tab", { tabId: "p0t7" })).structuredContent.tab, { id: "p0t7", closed: true });

    for (const text of ["42", "true", "null", '"quoted"', "{}", "[]", '{"nested":[1,true]}', "<p>hello</p>"]) {
        pageText = text;
        for (const format of [undefined, "text", "html"]) {
            const result = await tool("read_page", format ? { format } : {});
            assert.equal(result.structuredContent.page, text);
            assert.equal(result.content[0].text, text);
        }
    }
    assert.deepEqual((await tool("read_page", { format: "snapshot" })).structuredContent.page, snapshot);
    assert.deepEqual((await tool("snapshot")).structuredContent.snapshot, snapshot);
    assert.ok(Array.isArray((await tool("find", { selector: "body" })).structuredContent.matches));
    assert.ok(Array.isArray((await tool("read_console")).structuredContent.messages));
    assert.ok(Array.isArray((await tool("read_network")).structuredContent.requests));
    for (const value of [42, true, null, "text", [1, 2], { a: true }]) {
        jsText = JSON.stringify(value);
        assert.deepEqual((await tool("javascript_tool", { code: "fixture" })).structuredContent.result, value);
    }
    jsText = '42\n\n[Ran in the extension\'s isolated world]';
    assert.equal((await tool("javascript_tool", { code: "fixture" })).structuredContent.result, jsText);

    const input = join(directory, "input.txt");
    await writeFile(input, "attached file");
    const actions = {
        navigate: { url: "https://example.com/" }, click: { selector: "body" },
        type_text: { selector: "input", text: "hello" }, form_input: { fields: { name: "Ada" } },
        select_option: { selector: "select", value: "a" }, scroll: { direction: "down" },
        press_key: { key: "Enter" }, hover: { selector: "body" },
        drag: { fromSelector: "#source", toSelector: "#target" },
        upload_file: { selector: "input", filePath: input }, drop_file: { selector: "body", filePath: input },
        handle_dialog: { action: "dismiss" },
    };
    for (const [name, args] of Object.entries(actions)) {
        const properties = tools.find((tool) => tool.name === name).inputSchema.properties;
        const options = {};
        if (properties.includeSnapshot) options.includeSnapshot = true;
        if (properties.trace) Object.assign(options, { trace: true, traceDuration: 0 });
        if (properties.waitForSelector) options.waitForSelector = "body";
        const result = await tool(name, { ...args, ...options });
        assert.equal(typeof result.structuredContent.result, "string", name);
        if (options.includeSnapshot) assert.deepEqual(result.structuredContent.snapshot, snapshot, name);
        if (options.trace) assert.deepEqual(result.structuredContent.trace, trace, name);
        if (options.waitForSelector) assert.deepEqual(result.structuredContent.wait, { matched: true }, name);
    }
    await tool("resize_window", { width: 800, height: 600 });
    assert.deepEqual((await tool("wait", { seconds: 0 })).structuredContent.wait, { seconds: 0 });
    assert.deepEqual((await tool("wait", { selector: "body" })).structuredContent.wait, { matched: true });

    const inline = await tool("screenshot");
    assert.equal(inline.content[0].type, "image");
    assert.equal(inline.content[0].data, png);
    assert.equal(inline.structuredContent.screenshot.image, undefined);
    const filePath = join(directory, "capture.png");
    const saved = await tool("screenshot", { filePath });
    assert.equal(saved.structuredContent.screenshot.filePath, filePath);
    assert.equal(saved.structuredContent.screenshot.byteCount, Buffer.from(png, "base64").length);
    assert.deepEqual(await readFile(filePath), Buffer.from(png, "base64"));

    const batch = await tool("run_steps", {
        steps: [{ tool: "click", arguments: { selector: "body" } }, { tool: "wait", arguments: { seconds: 0 } }],
        includeSnapshot: true, trace: true, traceDuration: 0,
    });
    assert.equal(batch.structuredContent.completedSteps, 2);
    for (const entry of batch.structuredContent.results) assert.ok(entry.result.structuredContent);
    assert.deepEqual(batch.structuredContent.snapshot, snapshot);
    assert.deepEqual(batch.structuredContent.trace, trace);
    assert.deepEqual([...exercised].sort(), tools.map(({ name }) => name).sort());

    // A screenshot may activate its tab, and the extension's prepare step and the
    // capture must not be pulled apart by a parallel call that focuses something
    // else. The server serialises such calls end to end; an ordinary read is
    // free to overlap, which is what shows the fixture could have caught it.
    answerDelayMs = 40;
    await Promise.all([0, 1, 2, 3].map(() => tool("screenshot")));
    assert.equal(peakInFlight.get("screenshot"), 1, "screenshots overlapped at the extension");
    await Promise.all([0, 1, 2, 3].map(() => tool("snapshot")));
    assert.ok(peakInFlight.get("snapshot") > 1, "the fixture never overlapped two plain reads");
    answerDelayMs = 0;

    // A call that names no tab acts on the selected one, and its own follow-ups
    // are separate requests. The extension reports the tab it resolved, and the
    // follow-ups go to that tab even if the user switches while the call runs.
    const sentSince = (start) => requests.slice(start).map(({ action, tabId }) => `${action}:${tabId ?? "-"}`);
    selectedTab = 7;
    moveSelectionAfter = "click";
    let start = requests.length;
    await tool("click", { selector: "body", waitForText: "Done", includeSnapshot: true });
    moveSelectionAfter = undefined;
    assert.deepEqual(sentSince(start), ["click:-", "wait:7", "snapshot:7"]);

    selectedTab = 7;
    moveSelectionAfter = "click";
    start = requests.length;
    await tool("click", { selector: "body", trace: true, traceDuration: 0 });
    moveSelectionAfter = undefined;
    assert.deepEqual(sentSince(start), ["start_trace:-", "click:-", "stop_trace:7"]);

    // An explicit tab is left alone.
    selectedTab = 9;
    start = requests.length;
    await tool("click", { selector: "body", tabId: "p0t3", includeSnapshot: true });
    assert.deepEqual(sentSince(start), ["click:3", "snapshot:3"]);

    // A batch with no tab pins the first step's tab for every later step, and
    // for its final snapshot and trace.
    selectedTab = 7;
    moveSelectionAfter = "click";
    start = requests.length;
    const pinnedBatch = await tool("run_steps", {
        steps: [
            { tool: "click", arguments: { selector: "body" } },
            { tool: "hover", arguments: { selector: "body" } },
            { tool: "wait", arguments: { text: "Done" } },
            { tool: "click", arguments: { selector: "body", tabId: "p0t3" } },
        ],
        includeSnapshot: true, trace: true, traceDuration: 0,
    });
    moveSelectionAfter = undefined;
    assert.equal(pinnedBatch.structuredContent.completedSteps, 4);
    assert.deepEqual(sentSince(start), [
        "start_trace:-", "click:-", "hover:7", "wait:7", "click:3", "stop_trace:7", "snapshot:7",
    ]);
    selectedTab = 7;

    // A batch that names a tab uses it throughout.
    start = requests.length;
    await tool("run_steps", {
        tabId: "p0t5",
        steps: [{ tool: "click", arguments: { selector: "body" } }, { tool: "wait", arguments: { seconds: 0 } }],
    });
    assert.deepEqual(sentSince(start), ["click:5"]);

    // A wrong-typed argument is refused before the extension hears of the call.
    // Reading it as absent would have run the call with a default the caller
    // never asked for: bringToFront "false" activates the tab, and a status
    // filter given as "500" returns every request.
    const refuse = async (name, args, expected) => {
        const before = received.length;
        const refused = await tool(name, args, false);
        assert.equal(refused.structuredContent.code, "invalid_input", `${name}: ${JSON.stringify(refused)}`);
        assert.equal(refused.structuredContent.recoveryAction, "fix_input", name);
        assert.match(refused.structuredContent.message, expected, name);
        assert.equal(received.length, before, `${name} reached the extension`);
    };
    await refuse("select_tab", { tabId: "p0t7", bringToFront: "false" }, /bringToFront must be a boolean/);
    await refuse("read_network", { status: "500" }, /status must be an integer/);
    await refuse("read_console", { pattern: 5, clear: true }, /pattern must be a string/);
    await refuse("resize_window", { width: 800 }, /height is required/);
    await refuse("navigate", { url: "javascript:alert(1)" }, /disallowed scheme/);
    // The wait and trace options are read before the action is sent. Checking
    // them afterwards meant a caller who corrected the argument and retried
    // submitted the form twice, or left a trace running that nothing stopped.
    await refuse("click", { selector: "#submit", waitForSelector: "" }, /waitForSelector must not be empty/);
    await refuse("click", { selector: "#submit", waitForText: 5 }, /waitForText must be a string/);
    await refuse("click", { selector: "#submit", waitForText: "Done", waitTimeout: "5" }, /waitTimeout must be a number/);
    await refuse("navigate", { url: "https://example.com/", trace: true, traceDuration: "long" }, /traceDuration must be a number/);
    await refuse("type_text", { selector: "input", text: "x", trace: true, eventTypes: [""] }, /eventTypes must be an array/);
    // The bridge token is a file the same account can read, so a file tool that
    // took any caller-named path would hand it to a page. It is refused as a
    // file to attach and as a file: URL to open, before the extension is asked.
    const tokenPath = join(homedir(), "Library/Application Support/MCPSafari/tokens", String(port));
    await refuse("upload_file", { selector: "input", filePath: tokenPath }, /bridge token/);
    await refuse("drop_file", { selector: "body", filePaths: [tokenPath] }, /bridge token/);
    await refuse("navigate", { url: `file://${tokenPath}` }, /bridge token/);
    await refuse("tabs_create", { url: `file://${tokenPath}` }, /bridge token/);
    // A screenshot save may only create a .png or replace a PNG: it used to
    // overwrite any file the account could write.
    const notes = join(directory, "notes.png");
    await writeFile(notes, "not an image");
    await refuse("screenshot", { filePath: join(directory, "profile.sh") }, /must end in \.png/);
    await refuse("screenshot", { filePath: notes }, /not a PNG image/);
    assert.equal(await readFile(notes, "utf8"), "not an image");
    await refuse("screenshot", { filePath: `${tokenPath}.png` }, /bridge token/);
    // A batch is validated as a whole before its first step runs: a bad URL in
    // step 3 must not leave steps 1 and 2 already performed.
    await refuse("run_steps", {
        steps: [
            { tool: "click", arguments: { selector: "body" } },
            { tool: "wait", arguments: { seconds: 0 } },
            { tool: "navigate", arguments: { url: "jav\tascript:alert(1)" } },
        ],
    }, /steps\[2\] \(navigate\): Invalid URL or disallowed scheme/);
    await refuse("run_steps", {
        steps: [
            { tool: "click", arguments: { selector: "body" } },
            { tool: "navigate", arguments: { action: "sideways" } },
        ],
    }, /steps\[1\] \(navigate\): Invalid navigation action/);

    failAction = "click";
    const failed = await tool("click", { selector: "body" }, false);
    assert.equal(failed.structuredContent.code, "permission_required");
    assert.equal(failed.structuredContent.recoveryAction, "ask_user");
    await connect("work", () => ({ success: false, error: "Profile unavailable" }));
    const partial = await tool("tabs_context");
    assert.equal(partial.structuredContent.tabs.length, 1);
    assert.equal(partial.structuredContent.profileFailures.length, 1);
    assert.match(partial.structuredContent.profileFailures[0], /Profile unavailable/);

    // Selecting a tab on a site Safari has not granted succeeds and says so. It
    // still pins the tab's profile, and the result tells the model in prose that
    // the next read will be refused rather than leaving it to find out.
    await connect("third", ({ action }) => action === "select_tab"
        ? { success: true, data: JSON.stringify({ id: 9, selected: true, access: "not_granted", accessHint: "Grant example.org from the MCPSafari toolbar button." }) }
        : { success: false, error: "Not used" });
    const ungranted = await tool("select_tab", { tabId: "p2t9" });
    assert.equal(ungranted.structuredContent.tab.id, "p2t9");
    assert.equal(ungranted.structuredContent.tab.access, "not_granted");
    assert.match(ungranted.content[0].text, /not_granted/);
    const ungrantedText = ungranted.content.map(({ text }) => text).join("\n");
    assert.match(ungrantedText, /Access to one tab's site is not granted/);
    assert.match(ungrantedText, /Grant example\.org from the MCPSafari toolbar button\./);
    const pinned = (await tool("status")).structuredContent.status.profiles.find((profile) => profile.selected);
    assert.equal(pinned.handle, "p2");


    // The one boundary that spans both languages. This fixture answers any
    // action it is sent, including `default: Completed ${action}`, so every
    // tool above passes whether or not the real extension knows the action the
    // server used. A renamed or mistyped action would reach a user as
    // "Unknown action" having passed CI.
    //
    // The action names come from the server actually sending them rather than
    // from reading the Swift source, so there is no pattern here to drift.
    const routable = await extensionRoutableActions();
    const unroutable = [...sentActions].filter((action) => !routable.has(action)).sort();
    assert.deepEqual(unroutable, [], `the extension has no handler for: ${unroutable.join(", ")}`);
    assert.ok(sentActions.size >= 15, `expected the tools above to exercise the bridge, saw ${sentActions.size} actions`);
});

/// Starts the real server on any free port and waits until its bridge is listening.
/// The port it bound is how the token file is found.
async function startServer(t, name) {
    const server = spawn(binary, ["--port", "0"], { stdio: ["pipe", "pipe", "pipe"] });
    const exited = new Promise((resolve) => server.once("exit", (code, by) => resolve({ code, by })));
    const lines = createInterface({ input: server.stdout });
    let stderr = "";
    server.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4000); });
    t.after(() => { lines.close(); server.kill("SIGKILL"); });

    const answers = new Map();
    lines.on("line", (line) => { const message = JSON.parse(line); answers.set(message.id, message); });
    let nextId = 1;
    const ask = async (method, params = {}) => {
        const id = nextId++;
        server.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        for (let attempt = 0; attempt < 100 && !answers.has(id); attempt++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(answers.has(id), `no answer to ${method}: ${stderr}`);
        return answers.get(id).result;
    };
    await ask("initialize", {
        protocolVersion: "2025-11-25", capabilities: {},
        clientInfo: { name, version: "1.0" },
    });
    // Status is how the port is learned, and asking also proves it came up.
    let status;
    for (let attempt = 0; attempt < 50; attempt++) {
        status = (await ask("tools/call", { name: "status", arguments: {} })).structuredContent.status;
        if (status.listener === "listening") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(status.listener, "listening", `the bridge never came up: ${stderr}`);

    const directory = join(homedir(), "Library/Application Support/MCPSafari/tokens");
    const port = status.port;
    return {
        server, exited, ask, port,
        tokenFile: join(directory, String(port)),
        ownerFile: join(directory, `${port}.pid`),
    };
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    test(`${signal} removes the server's token files before it exits`, { timeout: 30000 }, async (t) => {
        const { server, exited, tokenFile, ownerFile } = await startServer(t, "signal-test");

        assert.ok(await readFile(tokenFile, "utf8").catch(() => null), "the token is published while it runs");
        assert.equal(await readFile(ownerFile, "utf8"), String(server.pid), "and records which process owns it");

        server.kill(signal);
        const { code, by } = await bounded(exited, `exit on ${signal}`, 5000);
        // A handled signal is a normal exit with the conventional status. Dying of the
        // signal itself would mean nothing handled it, and no cleanup ran.
        assert.equal(by, null, `killed by ${by} instead of exiting`);
        assert.equal(code, 128 + { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 }[signal]);
        assert.equal(await readFile(tokenFile, "utf8").catch(() => null), null, "the token file is gone");
        assert.equal(await readFile(ownerFile, "utf8").catch(() => null), null, "and so is its owner record");
    });
}

// The two halves of the handshake are written in different languages, so each side's
// own tests can only show it agrees with its own reading of the protocol. This runs
// the extension's real background code, with its WebCrypto, against the real server.
test("the extension's own handshake code authenticates against the server", { timeout: 30000 }, async (t) => {
    const { ask, port, tokenFile } = await startServer(t, "interop-test");
    const token = await readFile(tokenFile, "utf8");

    const listeners = [];
    const noop = () => {};
    const context = createContext({
        atob, btoa, crypto: globalThis.crypto, TextEncoder, URL, Error, Date, Promise,
        clearTimeout, setTimeout,
        console: { error: noop, log: noop, warn: noop },
        WebSocket,
        browser: {
            alarms: { create: noop, onAlarm: { addListener: noop } },
            runtime: {
                getManifest: () => ({ version: "9.9.9" }),
                onMessage: { addListener: (listener) => listeners.push(listener) },
                sendNativeMessage: async () => ({ tokens: { [port]: token } }),
            },
            storage: {
                local: { get: async () => ({}), set: noop },
                session: { get: async () => ({}), set: noop, remove: async () => {} },
            },
            tabs: {
                get: async () => { throw new Error("not found"); },
                onUpdated: { addListener: noop, removeListener: noop },
                onRemoved: { addListener: noop },
            },
        },
    });
    runInContext(backgroundScriptSource(), context);
    // Answer requests without a browser behind them.
    runInContext(
        `handleRequest = async (request) => ({ id: request.id, success: true, data: JSON.stringify([{ id: 7, url: "https://example.com/", title: "T" }]) })`,
        context
    );
    // Forget the connections as well as closing them, or the close schedules a
    // reconnect and the timer keeps this process alive after the test is over.
    t.after(() => runInContext("for (const conn of connections.values()) conn.ws?.close(); connections.clear()", context));

    // The server's port is not in the extension's scan range, so add it the way the popup does.
    listeners[0]({ type: "addPort", port: String(port) }, {}, noop);
    for (let attempt = 0; attempt < 100; attempt++) {
        if (runInContext(`connections.get(${port})?.state`, context) === "connected") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(runInContext(`connections.get(${port})?.state`, context), "connected");

    const status = (await ask("tools/call", { name: "status", arguments: {} })).structuredContent.status;
    assert.deepEqual(status.profiles.map(({ id }) => id), ["default"]);
    assert.equal(status.extensionVersion, "9.9.9");
    assert.equal(status.extensionProtocolVersion, BRIDGE_PROTOCOL_VERSION);

    const tabs = (await ask("tools/call", { name: "tabs_context", arguments: {} })).structuredContent;
    assert.equal(tabs.tabs[0].id, "p0t7", "a request made it to the extension and back");
});
