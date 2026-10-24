import { createHmac, randomBytes, webcrypto } from "node:crypto";

/**
 * What the extension's handshake needs from its environment, for a vm context.
 *
 * The background runs in a page with WebCrypto, `btoa` and `TextEncoder`, none of
 * which a bare `vm` context has.
 */
export const handshakeGlobals = {
    atob,
    btoa,
    crypto: webcrypto,
    TextEncoder,
};

export const PROTOCOL_VERSION = 2;

export const base64Url = (bytes) => Buffer.from(bytes).toString("base64url");

export const newNonce = () => base64Url(randomBytes(32));

// Node's own HMAC rather than WebCrypto, so the extension's proofs are checked by
// an implementation that shares no code with the one that made them.
const mac = (token, message) => createHmac("sha256", token).update(message).digest();

/** What a genuine server sends to show it holds `token`. */
export const serverProof = (token, port, clientNonce, serverNonce) =>
    base64Url(mac(token, `mcpsafari-v${PROTOCOL_VERSION}-server|${port}|${clientNonce}|${serverNonce}`));

/** What the extension is expected to answer with. */
export const expectedClientProof = (token, port, clientNonce, serverNonce) =>
    base64Url(mac(token, `mcpsafari-v${PROTOCOL_VERSION}-client|${port}|${serverNonce}|${clientNonce}`));

/** The hello the extension sent most recently on `socket`. */
export const helloOn = (socket) => JSON.parse(socket.sent[0]).hello;

/** A challenge frame as a server holding `token` would send it for `hello`. */
export function challengeFor(hello, { token, port, serverNonce = newNonce(), proof } = {}) {
    return {
        challenge: {
            serverNonce,
            serverProof: proof ?? serverProof(token, port, hello.clientNonce, serverNonce),
            protocolVersion: PROTOCOL_VERSION,
            serverVersion: "9.9.9",
        },
    };
}

/** Delivers one frame from the server to `socket` and waits for the extension to finish with it. */
export const deliver = (socket, frame) =>
    socket.onmessage({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });

/**
 * Plays a genuine server through the whole exchange on an open socket: reads the
 * hello, sends a correct challenge, checks the extension's proof, and says ok.
 * Returns the frames the extension sent, so a test can look at all of them.
 */
export async function serverHandshake(socket, { token, port }) {
    const hello = helloOn(socket);
    const serverNonce = newNonce();
    await deliver(socket, challengeFor(hello, { token, port, serverNonce }));
    const proofFrame = JSON.parse(socket.sent[1]);
    if (proofFrame.auth?.clientProof !== expectedClientProof(token, port, hello.clientNonce, serverNonce)) {
        throw new Error(`the extension's proof was wrong: ${socket.sent[1]}`);
    }
    await deliver(socket, { auth: "ok", protocolVersion: PROTOCOL_VERSION });
    return socket.sent.map((frame) => JSON.parse(frame));
}
