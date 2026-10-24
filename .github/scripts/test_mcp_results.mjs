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
    const tab = { id: 7, url: "https://example.com/", title: "Example" };
    const snapshot = { uid: "f0e1", tag: "body", children: [] };
    const trace = { events: [{ type: "click", timestamp: 1 }] };
    const responseData = (action, params) => {
        switch (action) {
            case "tabs_query": return [tab];
            case "tabs_create": return tab;
            case "select_tab": return { ...tab, selected: true };
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
    await connect("default", async ({ action, params }) => {
        sentActions.add(action);
        inFlight.set(action, (inFlight.get(action) ?? 0) + 1);
        peakInFlight.set(action, Math.max(peakInFlight.get(action) ?? 0, inFlight.get(action)));
        if (answerDelayMs) await new Promise((resolve) => setTimeout(resolve, answerDelayMs));
        inFlight.set(action, inFlight.get(action) - 1);
        if (action === failAction) return { success: false, error: "Fixture refusal", errorCode: "permission_required", retryable: true, recoveryAction: "ask_user" };
        const data = responseData(action, params);
        return { success: true, data: typeof data === "string" ? data : JSON.stringify(data) };
    });

    const { tools } = await call("tools/list");
    const tabs = await tool("tabs_context");
    assert.equal(tabs.structuredContent.tabs[0].id, "p0t7");
    assert.deepEqual(tabs.structuredContent.profileFailures, []);
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

    failAction = "click";
    const failed = await tool("click", { selector: "body" }, false);
    assert.equal(failed.structuredContent.code, "permission_required");
    assert.equal(failed.structuredContent.recoveryAction, "ask_user");
    await connect("work", () => ({ success: false, error: "Profile unavailable" }));
    const partial = await tool("tabs_context");
    assert.equal(partial.structuredContent.tabs.length, 1);
    assert.equal(partial.structuredContent.profileFailures.length, 1);
    assert.match(partial.structuredContent.profileFailures[0], /Profile unavailable/);


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
