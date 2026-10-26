"use strict";

// The WebSocket client: connecting, reconnecting and reporting each port.

// ─── Handshake primitives ────────────────────────────────────────────
//
// The token proves itself without being sent. Each side returns an HMAC of both
// sides' fresh nonces under it, and the extension checks the server's proof before
// it sends its own, so a listener that merely accepted the connection gets nothing
// it could replay, and this socket acts on none of its frames. The two proofs carry
// different labels and take the nonces in different orders, so neither can be
// turned around and offered as the other. `BridgeHandshake.swift` is the other half.

// Built where it is used, not at load: this file runs before anything dials, and
// nothing about loading it should depend on what the page offers.
const utf8 = (text) => new TextEncoder().encode(text);

function base64UrlEncode(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes of unpadded base64url text, or null for anything else. */
function base64UrlDecode(text) {
    if (typeof text !== "string" || !/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
    const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - text.length % 4) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** 32 random bytes, which is always 43 characters of base64url. */
function randomNonce() {
    return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}

function isWellFormedNonce(nonce) {
    const bytes = base64UrlDecode(nonce);
    return bytes !== null && nonce.length === 43 && bytes.length === 32;
}

function importHandshakeKey(token) {
    return crypto.subtle.importKey(
        "raw",
        utf8(token),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"]
    );
}

/** What each side authenticates; `role` is "server" or "client". */
function handshakeMessage(role, port, first, second) {
    return utf8(`mcpsafari-v${BRIDGE_PROTOCOL_VERSION}-${role}|${port}|${first}|${second}`);
}

// ─── WebSocket Connection ────────────────────────────────────────────

function connectToPort(port) {
    const conn = connections.get(port);
    if (!conn) return;
    if (conn.ws && (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)) return;

    // Security: every server instance requires its per-port auth token.
    const authToken = authTokensByPort.get(port);
    if (!authToken) {
        conn.state = "disconnected";
        return; // Skip — can't verify server identity without auth
    }

    conn.state = "connecting";
    // The literal address the server binds, not the name `localhost`. The name can
    // resolve to ::1 first, where another local user could be listening and would
    // receive the handshake.
    const wsUrl = `ws://127.0.0.1:${port}`;
    const socket = new WebSocket(wsUrl);
    conn.ws = socket;

    // Where this socket is in the handshake. Nothing a peer sends is dispatched as a
    // request until `ready`, and `ready` is reached only through the server's proof.
    //   awaitingChallenge -> verifying -> awaitingOk -> ready
    let stage = "awaitingChallenge";
    let clientNonce = null;
    // Whether the server ever accepted this socket. A close before that means the
    // token this dial used may be out of date, which `scheduleReconnect` acts on.
    let authenticated = false;

    // Closing here, not just ignoring the frame: a peer that sent something out of
    // turn is not one to keep talking to.
    const refuse = (reason) => {
        console.error(`[MCPSafari:${port}] ${reason}`);
        stage = "refused";
        socket.close();
    };

    socket.onopen = () => {
        clientNonce = randomNonce();
        // No token in this frame, or in any other this socket sends. It is the key
        // to the two proofs, and a listener that is not the real server must not
        // be handed it just for being dialled.
        socket.send(JSON.stringify({
            hello: {
                clientNonce,
                extensionVersion: EXTENSION_VERSION,
                protocolVersion: BRIDGE_PROTOCOL_VERSION,
                profileId,
            },
        }));
        console.log(`[MCPSafari:${port}] Sent hello`);
    };

    const continueHandshake = async (data) => {
        let msg;
        try {
            msg = JSON.parse(data);
        } catch (_) {
            return refuse("Invalid handshake frame");
        }
        if (!msg || typeof msg !== "object") return refuse("Invalid handshake frame");

        if (msg.auth === "error") {
            if (msg.error === "protocol_version_mismatch") {
                return refuse(
                    `Protocol mismatch: extension=${BRIDGE_PROTOCOL_VERSION}, server=${msg.serverProtocolVersion}. `
                    + "Install matching MCPSafari app and mcp-safari server versions."
                );
            }
            return refuse(`Auth rejected: ${msg.error || "unknown error"}`);
        }

        if (stage === "awaitingChallenge") {
            const challenge = msg.challenge;
            if (!challenge || typeof challenge.serverNonce !== "string"
                || typeof challenge.serverProof !== "string"
                || !isWellFormedNonce(challenge.serverNonce)) {
                return refuse("Expected a challenge from the server");
            }
            // Before any await, so a second frame arriving while this one is
            // being checked finds a stage that accepts nothing.
            stage = "verifying";
            try {
                const key = await importHandshakeKey(authToken);
                const serverProof = base64UrlDecode(challenge.serverProof);
                const genuine = serverProof !== null && await crypto.subtle.verify(
                    "HMAC",
                    key,
                    serverProof,
                    handshakeMessage("server", port, clientNonce, challenge.serverNonce)
                );
                if (!genuine) return refuse("The server did not prove it knows the token; not authenticating");

                const clientProof = await crypto.subtle.sign(
                    "HMAC",
                    key,
                    handshakeMessage("client", port, challenge.serverNonce, clientNonce)
                );
                if (socket.readyState !== WebSocket.OPEN) return;
                stage = "awaitingOk";
                socket.send(JSON.stringify({ auth: { clientProof: base64UrlEncode(new Uint8Array(clientProof)) } }));
            } catch (err) {
                refuse(`Handshake failed: ${err}`);
            }
            return;
        }

        if (stage === "awaitingOk" && msg.auth === "ok") {
            if (msg.protocolVersion !== undefined && msg.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
                return refuse(`Protocol mismatch: extension=${BRIDGE_PROTOCOL_VERSION}, server=${msg.protocolVersion}`);
            }
            stage = "ready";
            authenticated = true;
            conn.lastConnected = Date.now();
            conn.state = "connected";
            conn.attempts = 0;
            conn.disconnectedAt = 0;
            console.log(`[MCPSafari:${port}] Authenticated`);
            return;
        }

        refuse("Unexpected frame during the handshake");
    };

    socket.onmessage = async (event) => {
        if (stage !== "ready") {
            await continueHandshake(event.data);
            return;
        }

        let request;
        try {
            request = JSON.parse(event.data);
        } catch (_) { return; }

        // `JSON.parse` is happy with `null`, `5`, or a bare string, and none of
        // those has an id to answer. Destructuring one threw out of
        // `handleRequest`, and the catch below then threw a second time reading
        // `request.id`, so nothing was ever sent back. Dropping it here is
        // loud and cannot cascade.
        if (!request || typeof request !== "object" || typeof request.id !== "string") {
            console.error(`[MCPSafari:${port}] Ignoring a frame that carries no request id`);
            return;
        }

        try {
            const response = await handleRequest(request);
            socket.send(JSON.stringify(response));
        } catch (err) {
            console.error(`[MCPSafari:${port}] Error:`, err);
            socket.send(JSON.stringify(failureResponse(request.id, err)));
        }
    };

    socket.onclose = () => {
        conn.state = "disconnected";
        conn.ws = null;
        if (conn.disconnectedAt === 0) conn.disconnectedAt = Date.now();
        scheduleReconnect(port, { reloadTokens: !authenticated });
    };

    socket.onerror = () => { /* logged by onclose */ };
}

// `reloadTokens` is for a dial that never got authenticated. A server that
// restarted writes a new token, and the one cached here is for the old run, so
// redialling with it only locks the extension out until the next keepalive
// (#156). It is one native read per attempt, and attempts are already spaced by
// the backoff below, so a server that keeps refusing cannot make this a tight loop.
function scheduleReconnect(port, { reloadTokens = false } = {}) {
    const conn = connections.get(port);
    if (!conn) return;
    if (!conn.manual && conn.lastConnected === 0 && conn.attempts >= AUTO_GIVE_UP_ATTEMPTS) {
        suppressStaleTokenPort(port);
        return;
    }
    const delayMs = Math.min(
        RECONNECT_BASE_MS * Math.pow(2, conn.attempts),
        RECONNECT_MAX_MS
    );
    conn.attempts++;
    setTimeout(async () => {
        if (reloadTokens) await loadAuthTokens();
        connectToPort(port);
    }, delayMs);
}

function connectAll() {
    for (const port of connections.keys()) {
        connectToPort(port);
    }
}

function reconnectKnownPorts() {
    for (const [port, conn] of connections) {
        if (conn.ws && conn.ws.readyState === WebSocket.OPEN) continue;

        if (conn.lastConnected > 0 || conn.manual) {
            conn.attempts = 0;
        }
        connectToPort(port);
    }
}

function ensurePortsForKnownTokens() {
    for (const [port, token] of authTokensByPort) {
        if (staleTokensByPort.get(port) === token) continue;
        staleTokensByPort.delete(port);
        if (isAutoScanPort(port) || manualPorts.has(port)) {
            if (!connections.has(port)) {
                ensurePort(port, manualPorts.has(port));
                connectToPort(port);
            }
        }
    }
}

function suppressStaleTokenPort(port) {
    const token = authTokensByPort.get(port);
    if (token) staleTokensByPort.set(port, token);
    // Close it as `disconnectPort` does. Dropping the record while a socket was
    // still opening left one nothing managed: it would finish its handshake,
    // answer requests, and have no entry in `connections`, so the popup showed
    // nothing and its eventual close found no connection to reconnect.
    const conn = connections.get(port);
    if (conn && conn.ws) conn.ws.close();
    connections.delete(port);
}

function disconnectPort(port) {
    const conn = connections.get(port);
    if (conn) {
        if (conn.ws) conn.ws.close();
        connections.delete(port);
    }
    staleTokensByPort.delete(port);
}

function visibleConnectionStatuses() {
    const ports = [];
    for (const [port, conn] of connections) {
        // Only surface connections worth showing:
        // - Currently connected or attempting an authenticated connection
        // - Manually added by the user
        // - Auto-scan ports with a known token or previous connection
        const isVisible = conn.state === "connected"
            || conn.state === "connecting"
            || conn.manual
            || (isAutoScanPort(port) && (authTokensByPort.has(port) || conn.lastConnected > 0));
        if (!isVisible) continue;
        ports.push({ port, state: conn.state, manual: conn.manual });
    }
    return ports;
}

