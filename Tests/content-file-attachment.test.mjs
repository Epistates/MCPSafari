import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { contentScriptSource } from "./helpers/extension-sources.mjs";

const source = contentScriptSource();

// Minimal stand-ins for the DOM file APIs content.js uses. Node has File but
// neither DataTransfer nor DragEvent.
class FakeDataTransfer {
    constructor() {
        this.files = [];
        this.items = { add: (file) => this.files.push(file) };
    }
}

class FakeEvent {
    constructor(type, options = {}) {
        this.type = type;
        Object.assign(this, options);
    }
}

function makeElement(overrides = {}) {
    return {
        tagName: "DIV",
        events: [],
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; },
        removeAttribute(name) { delete this.attributes[name]; },
        scrollIntoView() {},
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 50 }),
        querySelector: () => null,
        dispatchEvent(event) {
            this.events.push(event);
            return true;
        },
        ...overrides,
    };
}

function makeFileInput(overrides = {}) {
    return makeElement({ tagName: "INPUT", type: "file", files: [], ...overrides });
}

const STAGED_IDLE_MS = 60_000;
const MAIN_WORLD_TIMEOUT_MS = 3000;

// Loads content.js against a fake document whose querySelector returns `target`.
// Bridge requests are collected; `call.reply(request, reply)` answers one the
// way file-drop.js would, `call.timeout()` fires the bridge timeout, and
// `call.idle()` lets the staged files' idle timers run out.
function loadContent(target, { nativeBase64 = false } = {}) {
    let runtimeListener;
    let messageListener;
    const timers = new Map();
    let nextTimer = 1;
    const bridgeRequests = [];
    const window = {
        addEventListener: (_type, fn) => { messageListener = fn; },
        removeEventListener() {},
        postMessage: (message) => bridgeRequests.push(message),
    };
    // Safari 18.2 decodes natively; Node does not, so the fallback is what runs
    // unless a test asks for the native form.
    class ContentUint8Array extends Uint8Array {}
    if (nativeBase64) {
        ContentUint8Array.fromBase64 = (text) => {
            ContentUint8Array.decodedNatively += 1;
            return new Uint8Array(Buffer.from(text, "base64"));
        };
        ContentUint8Array.decodedNatively = 0;
    }

    vm.runInNewContext(source, {
        browser: {
            runtime: {
                onMessage: { addListener: (fn) => { runtimeListener = fn; } },
            },
        },
        document: { querySelector: () => target },
        window,
        // The isolated world always has one; request ids come from it.
        crypto: globalThis.crypto,
        setTimeout: (fn, ms) => {
            const id = nextTimer++;
            timers.set(id, { fn, ms });
            return id;
        },
        clearTimeout: (id) => timers.delete(id),
        atob,
        Uint8Array: ContentUint8Array,
        Blob,
        File,
        DataTransfer: FakeDataTransfer,
        Event: FakeEvent,
        DragEvent: FakeEvent,
    });

    const fire = (ms) => {
        for (const [id, timer] of timers) {
            if (timer.ms !== ms) continue;
            timers.delete(id);
            timer.fn();
            return true;
        }
        return false;
    };
    const call = (action, params, frameId = 0) => new Promise((resolve) => {
        runtimeListener({ action, params, frameId }, {}, resolve);
    });
    call.bridgeRequests = bridgeRequests;
    call.reply = (request, reply) => {
        messageListener({ source: window, data: { source: "MCPSafariPage", id: request.id, ...reply } });
    };
    call.timeout = () => fire(MAIN_WORLD_TIMEOUT_MS);
    call.idle = () => { while (fire(STAGED_IDLE_MS)); };
    call.decodedNatively = () => ContentUint8Array.decodedNatively;
    return call;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const PNG = { name: "shot.png", type: "image/png", bytes: Buffer.from([137, 80, 78, 71]) };
const TXT = { name: "note.txt", type: "text/plain", bytes: Buffer.from("hi") };

// Sends files the way the server does: `stage_files` against the target, then a
// chunk at a time. Answers with the staging reply and the transfer to name in
// the action.
async function sendFiles(call, intent, target, files, chunkSize = 3) {
    const staged = await call("stage_files", {
        ...target,
        intent,
        files: files.map(({ name, type, bytes }) => ({ name, type, size: bytes.length })),
    }, 4);
    if (staged.error) return { staged };
    const transfer = { id: staged.data.transferId, frameId: staged.data.frameId };
    for (const [file, { bytes }] of files.entries()) {
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            const data = bytes.subarray(offset, offset + chunkSize).toString("base64");
            const reply = await call("file_chunk", { transfer, file, offset, data });
            assert.equal(reply.error, null, reply.error);
        }
    }
    return { staged, transfer };
}

const bytesOf = async (file) => Buffer.from(await file.arrayBuffer());
// A reply as the background receives it: Safari carries it across as JSON, which
// also leaves the script's own realm behind.
const asSent = (value) => JSON.parse(JSON.stringify(value));

test("upload_file assigns the sent files and dispatches input then change", async () => {
    const input = makeFileInput();
    const call = loadContent(input);

    const { staged, transfer } = await sendFiles(call, "upload_file", { selector: "#file" }, [PNG]);
    // The frame that holds the files says so, and the rest of the call goes there.
    assert.match(staged.data.transferId, /^mcp-transfer-/);
    assert.equal(staged.data.frameId, 4);
    const response = await call("upload_file", { selector: "#file", transfer });

    assert.equal(response.error, null);
    assert.equal(response.data, "Attached shot.png to file input");
    assert.equal(input.files.length, 1);
    assert.equal(input.files[0].name, "shot.png");
    assert.equal(input.files[0].type, "image/png");
    assert.deepEqual(await bytesOf(input.files[0]), PNG.bytes);
    assert.deepEqual(input.events.map((event) => event.type), ["input", "change"]);
    assert.equal(input.events[0].bubbles, true);
});

test("a file sent in many chunks arrives byte for byte", async () => {
    const input = makeFileInput();
    const call = loadContent(input);
    const movie = { name: "preview.mp4", type: "video/mp4", bytes: Buffer.from(Array.from({ length: 1000 }, (_, i) => (i * 37) % 256)) };

    const { transfer } = await sendFiles(call, "upload_file", { selector: "#file" }, [movie], 64);
    const response = await call("upload_file", { selector: "#file", transfer });

    assert.equal(response.error, null);
    assert.equal(input.files[0].size, 1000);
    assert.deepEqual(await bytesOf(input.files[0]), movie.bytes);
});

test("chunks are decoded natively where Safari can", async () => {
    const input = makeFileInput();
    const call = loadContent(input, { nativeBase64: true });

    const { transfer } = await sendFiles(call, "upload_file", { selector: "#file" }, [TXT], 1);
    await call("upload_file", { selector: "#file", transfer });

    assert.equal(call.decodedNatively(), 2);
    assert.deepEqual(await bytesOf(input.files[0]), TXT.bytes);
});

test("upload_file resolves a file input inside a wrapper target", async () => {
    const input = makeFileInput();
    const wrapper = makeElement({ querySelector: (selector) => (selector === 'input[type="file"]' ? input : null) });
    const call = loadContent(wrapper);

    // Refused when staged, before any of the file is sent.
    const { staged } = await sendFiles(call, "upload_file", { selector: "#dropzone" }, [PNG, TXT]);
    assert.equal(staged.error, "Input accepts one file but 2 were provided");

    input.multiple = true;
    const { transfer } = await sendFiles(call, "upload_file", { selector: "#dropzone" }, [PNG, TXT]);
    const retry = await call("upload_file", { selector: "#dropzone", transfer });
    assert.equal(retry.error, null);
    assert.deepEqual(input.files.map((file) => file.name), ["shot.png", "note.txt"]);
});

test("upload_file is refused when staged against a target with no file input", async () => {
    const call = loadContent(makeElement({ tagName: "BUTTON" }));

    const { staged } = await sendFiles(call, "upload_file", { selector: "button" }, [PNG]);

    assert.equal(staged.data, null);
    assert.match(staged.error, /is not a file input and contains none/);
});

test("a disabled input is refused when staged and again when the files arrive", async () => {
    const input = makeFileInput({ disabled: true });
    const call = loadContent(input);

    assert.equal((await sendFiles(call, "upload_file", { selector: "#file" }, [PNG])).staged.error, "File input is disabled");

    input.disabled = false;
    const { transfer } = await sendFiles(call, "upload_file", { selector: "#file" }, [PNG]);
    input.disabled = true;
    const response = await call("upload_file", { selector: "#file", transfer });
    assert.equal(response.error, "File input is disabled");
    assert.equal(input.files.length, 0);
});

test("staging an empty file list is refused", async () => {
    const call = loadContent(makeFileInput());

    const { staged } = await sendFiles(call, "upload_file", { selector: "#file" }, []);

    assert.equal(staged.error, "No files provided");
});

test("a chunk asked for again is taken once, and one out of order is refused", async () => {
    const input = makeFileInput();
    const call = loadContent(input);
    const staged = await call("stage_files", { selector: "#file", intent: "upload_file", files: [{ name: "a.bin", type: "", size: 6 }] });
    const transfer = { id: staged.data.transferId, frameId: 0 };
    const chunk = (offset, text) => call("file_chunk", { transfer, file: 0, offset, data: Buffer.from(text).toString("base64") });

    assert.deepEqual(asSent((await chunk(0, "abc")).data), { received: 3 });
    // The reply to that one was lost, so the server sends it again.
    assert.deepEqual(asSent((await chunk(0, "abc")).data), { received: 3 });
    assert.match((await chunk(4, "ef")).error, /arrived at byte 4, after 3 bytes/);
    assert.match((await chunk(3, "defg")).error, /larger than the 6 bytes it was announced as/);
    assert.deepEqual(asSent((await chunk(3, "def")).data), { received: 6 });

    await call("upload_file", { selector: "#file", transfer });
    assert.equal(await input.files[0].text(), "abcdef");
});

test("a file that has not all arrived is refused, and the transfer is let go", async () => {
    const input = makeFileInput();
    const call = loadContent(input);
    const staged = await call("stage_files", { selector: "#file", intent: "upload_file", files: [{ name: "a.bin", type: "", size: 6 }] });
    const transfer = { id: staged.data.transferId, frameId: 0 };
    await call("file_chunk", { transfer, file: 0, offset: 0, data: Buffer.from("abc").toString("base64") });

    const response = await call("upload_file", { selector: "#file", transfer });
    assert.equal(response.error, "a.bin arrived incomplete: 3 of 6 bytes");
    assert.equal(input.files.length, 0);

    const again = await call("upload_file", { selector: "#file", transfer });
    assert.equal(again.errorCode, "file_transfer_lost");
    assert.equal(again.retryable, true);
});

test("the files are handed over once: the action takes them, success or not", async () => {
    const input = makeFileInput();
    const call = loadContent(input);
    const { transfer } = await sendFiles(call, "upload_file", { selector: "#file" }, [PNG]);

    assert.equal((await call("upload_file", { selector: "#file", transfer })).error, null);
    const second = await call("upload_file", { selector: "#file", transfer });
    assert.equal(second.errorCode, "file_transfer_lost");
    assert.equal(second.recoveryAction, "retry");
});

test("discard_files lets the files go, and saying it twice is harmless", async () => {
    const call = loadContent(makeFileInput());
    const { transfer } = await sendFiles(call, "upload_file", { selector: "#file" }, [PNG]);

    assert.deepEqual(asSent((await call("discard_files", { transfer })).data), { discarded: true });
    assert.deepEqual(asSent((await call("discard_files", { transfer })).data), { discarded: false });
    assert.equal((await call("upload_file", { selector: "#file", transfer })).errorCode, "file_transfer_lost");
});

test("files nothing has added to for a minute are let go, and each chunk restarts the clock", async () => {
    const call = loadContent(makeFileInput());
    const staged = await call("stage_files", { selector: "#file", intent: "upload_file", files: [{ name: "a.bin", type: "", size: 2 }] });
    const transfer = { id: staged.data.transferId, frameId: 0 };

    // One timer at a time: the chunk replaced the one staging started.
    await call("file_chunk", { transfer, file: 0, offset: 0, data: Buffer.from("a").toString("base64") });
    call.idle();
    const late = await call("file_chunk", { transfer, file: 0, offset: 1, data: Buffer.from("b").toString("base64") });
    assert.equal(late.errorCode, "file_transfer_lost");
    assert.match(late.error, /nothing arrived for a minute/);
});

test("drop_file hands the sent files to the page world and unmarks the target", async () => {
    const zone = makeElement();
    const call = loadContent(zone);

    const { transfer } = await sendFiles(call, "drop_file", { selector: "#zone" }, [PNG, TXT]);
    const pending = call("drop_file", { selector: "#zone", transfer });
    await tick();

    assert.equal(call.bridgeRequests.length, 1);
    const request = call.bridgeRequests[0];
    assert.equal(request.type, "drop_files");
    assert.deepEqual(request.params.files.map((file) => file.name), ["shot.png", "note.txt"]);
    assert.deepEqual(await bytesOf(request.params.files[0]), PNG.bytes);
    assert.match(request.params.marker, /^mcp-drop-/);
    assert.equal(zone.attributes["data-mcp-drop-target"], request.params.marker);

    call.reply(request, { data: { dropped: 2 } });
    const response = await pending;

    assert.equal(response.error, null);
    assert.equal(response.data, "Dropped shot.png, note.txt on <div>");
    assert.equal(zone.events.length, 0);
    assert.deepEqual(zone.attributes, {});
});

test("drop_file runs one drop at a time so markers never overlap", async () => {
    const zone = makeElement();
    const call = loadContent(zone);

    const first = call("drop_file", { selector: "#zone", transfer: (await sendFiles(call, "drop_file", { selector: "#zone" }, [PNG])).transfer });
    const second = call("drop_file", { selector: "#zone", transfer: (await sendFiles(call, "drop_file", { selector: "#zone" }, [TXT])).transfer });
    await tick();

    assert.equal(call.bridgeRequests.length, 1);
    // The waiting drop already holds its files, so the idle clock cannot take them.
    call.idle();
    call.reply(call.bridgeRequests[0], { data: { dropped: 1 } });
    await first;
    await tick();

    assert.equal(call.bridgeRequests.length, 2);
    assert.notEqual(call.bridgeRequests[1].params.marker, call.bridgeRequests[0].params.marker);
    assert.equal(zone.attributes["data-mcp-drop-target"], call.bridgeRequests[1].params.marker);
    call.reply(call.bridgeRequests[1], { data: { dropped: 1 } });
    assert.equal((await second).data, "Dropped note.txt on <div>");
    assert.deepEqual(zone.attributes, {});
});

test("drop_file reports a page-world error instead of dispatching blind", async () => {
    const zone = makeElement();
    const call = loadContent(zone);

    const { transfer } = await sendFiles(call, "drop_file", { selector: "#zone" }, [PNG]);
    const pending = call("drop_file", { selector: "#zone", transfer });
    await tick();
    call.reply(call.bridgeRequests[0], { error: "Drop target not found in page" });
    const response = await pending;

    assert.equal(response.error, "Drop target not found in page");
    assert.equal(zone.events.length, 0);
    assert.deepEqual(zone.attributes, {});
});

test("drop_file dispatches in its own world when the page bridge does not answer", async () => {
    const zone = makeElement();
    const call = loadContent(zone);

    const { transfer } = await sendFiles(call, "drop_file", { selector: "#zone" }, [PNG]);
    const pending = call("drop_file", { selector: "#zone", transfer });
    await tick();
    assert.ok(call.timeout());
    const response = await pending;

    assert.equal(response.error, null);
    assert.match(response.data, /^Dropped shot.png on <div> \(page bridge unavailable/);
    assert.deepEqual(zone.events.map((event) => event.type), ["dragenter", "dragover", "drop"]);
    for (const event of zone.events) {
        assert.equal(event.cancelable, true);
        assert.deepEqual(event.dataTransfer.files.map((file) => file.name), ["shot.png"]);
        assert.equal(event.clientX, 60);
        assert.equal(event.clientY, 45);
    }
    assert.deepEqual(zone.attributes, {});
});

test("drop_file with files that never arrived is refused without touching the page", async () => {
    const zone = makeElement();
    const call = loadContent(zone);

    const response = await call("drop_file", { selector: "#zone", transfer: { id: "mcp-transfer-unknown", frameId: 0 } });

    assert.equal(response.errorCode, "file_transfer_lost");
    assert.equal(call.bridgeRequests.length, 0);
    assert.deepEqual(zone.attributes, {});
});
