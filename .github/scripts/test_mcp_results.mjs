// Actual stdio MCP server + authenticated loopback extension fixture; no Safari UI.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

const binary = process.env.MCPSAFARI_TEST_BINARY
    ?? fileURLToPath(new URL("../../MCPServer/.build/debug/MCPSafari", import.meta.url));
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1XkAAAAASUVORK5CYII=";

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
            for (const root of ["Library/Application Support/MCPSafari", ".config/mcp-safari"]) {
                const path = join(homedir(), root, "tokens", String(port));
                // Never delete another process's replacement token.
                if (await readFile(path, "utf8").catch(() => null) === token) await rm(path);
            }
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
    const statusResult = await tool("status");
    const status = statusResult.structuredContent.status;
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
        const authenticated = new Promise((resolve, reject) => {
            socket.addEventListener("error", () => reject(new Error("WebSocket failed")));
            socket.addEventListener("open", () => socket.send(JSON.stringify({ auth: token, protocolVersion: 1, profileId })));
            socket.addEventListener("message", ({ data }) => {
                const message = JSON.parse(data);
                if (message.auth) {
                    if (message.auth === "ok") resolve();
                    else reject(new Error("Authentication failed"));
                    return;
                }
                socket.send(JSON.stringify({ id: message.id, ...respond(message) }));
            });
        });
        await bounded(authenticated, "extension authentication");
    };
    await connect("default", ({ action, params }) => {
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

    failAction = "click";
    const failed = await tool("click", { selector: "body" }, false);
    assert.equal(failed.structuredContent.code, "permission_required");
    assert.equal(failed.structuredContent.recoveryAction, "ask_user");
    await connect("work", () => ({ success: false, error: "Profile unavailable" }));
    const partial = await tool("tabs_context");
    assert.equal(partial.structuredContent.tabs.length, 1);
    assert.equal(partial.structuredContent.profileFailures.length, 1);
    assert.match(partial.structuredContent.profileFailures[0], /Profile unavailable/);
});
