"use strict";

// The WebSocket client: connecting, reconnecting and reporting each port.

// ─── WebSocket Connection ────────────────────────────────────────────

function connectToPort(port) {
    const conn = connections.get(port);
    if (!conn) return;
    if (conn.ws && (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING)) return;

    // Security: every server instance requires its per-port auth token.
    const authToken = authTokensByPort.get(port) || legacyAuthToken;
    if (!authToken) {
        conn.state = "disconnected";
        return; // Skip — can't verify server identity without auth
    }

    conn.state = "connecting";
    const wsUrl = `ws://localhost:${port}`;
    const socket = new WebSocket(wsUrl);
    conn.ws = socket;

    let pendingAuth = true;

    socket.onopen = () => {
        socket.send(JSON.stringify({
            auth: authToken,
            extensionVersion: EXTENSION_VERSION,
            protocolVersion: BRIDGE_PROTOCOL_VERSION,
            profileId,
        }));
        console.log(`[MCPSafari:${port}] Sent auth token`);
    };

    socket.onmessage = async (event) => {
        if (pendingAuth) {
            pendingAuth = false;
            try {
                const msg = JSON.parse(event.data);
                if (msg.auth === "ok") {
                    if (msg.protocolVersion !== undefined && msg.protocolVersion !== BRIDGE_PROTOCOL_VERSION) {
                        console.error(`[MCPSafari:${port}] Protocol mismatch: extension=${BRIDGE_PROTOCOL_VERSION}, server=${msg.protocolVersion}`);
                        socket.close();
                        return;
                    }
                    conn.lastConnected = Date.now();
                    conn.state = "connected";
                    conn.attempts = 0;
                    conn.disconnectedAt = 0;
                    console.log(`[MCPSafari:${port}] Authenticated`);
                } else {
                    console.error(`[MCPSafari:${port}] Auth rejected: ${msg.error || "unknown error"}`);
                    socket.close();
                }
            } catch (err) {
                console.error(`[MCPSafari:${port}] Invalid auth response:`, err);
                socket.close();
            }
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
        scheduleReconnect(port);
    };

    socket.onerror = () => { /* logged by onclose */ };
}

function scheduleReconnect(port) {
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
    setTimeout(() => connectToPort(port), delayMs);
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

