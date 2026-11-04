import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

import { extensionSource } from "./helpers/extension-sources.mjs";

// The server and the extension agree on several numbers without sharing a file.
// Each side's own tests can only show it matches its own copy, so a change to one
// went unnoticed until a real Safari disagreed with a real server. These read the
// Swift constants straight out of the sources and compare them with the JS ones.

const MCP_SAFARI = new URL("../MCPServer/Sources/mcp-safari/", import.meta.url);
const swiftSource = (file) => readFileSync(new URL(file, MCP_SAFARI), "utf8");

/** The integer a Swift declaration assigns, which may be a product such as `32 * 1024 * 1024`. */
function swiftConstant(file, declaration) {
    const match = swiftSource(file).match(new RegExp(`${declaration}\\s*(?::\\s*\\w+\\s*)?=\\s*([0-9_]+(?:\\s*\\*\\s*[0-9_]+)*)`));
    assert.ok(match, `no declaration of ${declaration} in ${file}`);
    return match[1].split("*").map((factor) => Number(factor.replaceAll("_", "").trim())).reduce((a, b) => a * b, 1);
}

function extensionConstants() {
    const context = vm.createContext({
        browser: { runtime: { getManifest: () => ({ version: "0.0.0" }) } },
        TextEncoder,
    });
    vm.runInContext(`${extensionSource("background-config.js")}\n${extensionSource("background-bridge.js")}`, context);
    return {
        protocolVersion: vm.runInContext("BRIDGE_PROTOCOL_VERSION", context),
        maxDiscoveredPorts: vm.runInContext("MAX_DISCOVERED_PORTS", context),
        minPort: vm.runInContext("MIN_BRIDGE_PORT", context),
        maxReplyBytes: vm.runInContext("MAX_REPLY_BYTES", context),
        handshakeTimeoutMs: vm.runInContext("HANDSHAKE_TIMEOUT_MS", context),
    };
}

const extension = extensionConstants();

test("the protocol version is the same on both sides", () => {
    assert.equal(extension.protocolVersion, swiftConstant("Diagnostics.swift", "static let bridgeProtocolVersion"));
});

test("the extension dials as many ports as one server is allowed to try", () => {
    assert.equal(extension.maxDiscoveredPorts, swiftConstant("WebSocketBridge.swift", "static let maxPortCount"));
});

test("the lowest port the server will start on is the lowest the extension dials", () => {
    assert.equal(extension.minPort, swiftConstant("WebSocketBridge.swift", "static let minPort"));
});

test("a reply the extension will send always fits under what the server accepts", () => {
    const serverLimit = swiftConstant("WebSocketBridge.swift", "static let maxMessageBytes");
    assert.ok(extension.maxReplyBytes < serverLimit, "the server drops the connection at its limit");
    // Close enough that the limit does not turn away replies the bridge could carry.
    assert.ok(serverLimit - extension.maxReplyBytes <= 2 * 1024 * 1024, "and not so far under it that it wastes the room");
});

test("the extension gives the server longer than the server gives itself", () => {
    // The server answers a bad token and drops a silent socket at its own deadline;
    // the extension's limit is for a listener that does neither, so it has to be
    // the later of the two or it would cut off a handshake that was about to finish.
    const match = swiftSource("WebSocketBridge.swift").match(/handshakeDeadline: Duration = \.seconds\((\d+)\)/);
    assert.ok(match, "the server's default handshake deadline moved");
    assert.ok(extension.handshakeTimeoutMs > Number(match[1]) * 1000);
});
