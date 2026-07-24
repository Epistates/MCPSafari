import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/content.js", import.meta.url),
    "utf8"
);

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

// Loads content.js against a fake document whose querySelector returns `target`.
function loadContent(target) {
    let runtimeListener;

    vm.runInNewContext(source, {
        browser: {
            runtime: {
                onMessage: { addListener: (fn) => { runtimeListener = fn; } },
            },
        },
        document: { querySelector: () => target },
        window: { addEventListener() {}, postMessage() {} },
        setTimeout: () => 0,
        clearTimeout() {},
        atob,
        Uint8Array,
        File,
        DataTransfer: FakeDataTransfer,
        Event: FakeEvent,
        DragEvent: FakeEvent,
    });

    return (action, params) => new Promise((resolve) => {
        runtimeListener({ action, params }, {}, resolve);
    });
}

const PNG = { name: "shot.png", type: "image/png", data: Buffer.from([137, 80, 78, 71]).toString("base64") };
const TXT = { name: "note.txt", type: "text/plain", data: Buffer.from("hi").toString("base64") };

test("upload_file assigns decoded files and dispatches input then change", async () => {
    const input = makeFileInput();
    const call = loadContent(input);

    const response = await call("upload_file", { selector: "#file", files: [PNG] });

    assert.equal(response.error, null);
    assert.equal(input.files.length, 1);
    assert.equal(input.files[0].name, "shot.png");
    assert.equal(input.files[0].type, "image/png");
    assert.equal(input.files[0].size, 4);
    assert.deepEqual(input.events.map((event) => event.type), ["input", "change"]);
    assert.equal(input.events[0].bubbles, true);
});

test("upload_file resolves a file input inside a wrapper target", async () => {
    const input = makeFileInput();
    const wrapper = makeElement({ querySelector: (selector) => (selector === 'input[type="file"]' ? input : null) });
    const call = loadContent(wrapper);

    const response = await call("upload_file", { selector: "#dropzone", files: [PNG, TXT] });

    assert.equal(response.error, "Input accepts one file but 2 were provided");

    input.multiple = true;
    const retry = await call("upload_file", { selector: "#dropzone", files: [PNG, TXT] });
    assert.equal(retry.error, null);
    assert.deepEqual(input.files.map((file) => file.name), ["shot.png", "note.txt"]);
});

test("upload_file rejects targets with no file input", async () => {
    const call = loadContent(makeElement({ tagName: "BUTTON" }));

    const response = await call("upload_file", { selector: "button", files: [PNG] });

    assert.equal(response.data, null);
    assert.match(response.error, /is not a file input and contains none/);
});

test("upload_file rejects an empty file list", async () => {
    const call = loadContent(makeFileInput());

    const response = await call("upload_file", { selector: "#file", files: [] });

    assert.equal(response.error, "No files provided");
});

test("drop_file dispatches dragenter, dragover, and drop carrying the files", async () => {
    const zone = makeElement();
    const call = loadContent(zone);

    const response = await call("drop_file", { selector: "#zone", files: [PNG] });

    assert.equal(response.error, null);
    assert.deepEqual(zone.events.map((event) => event.type), ["dragenter", "dragover", "drop"]);
    for (const event of zone.events) {
        assert.equal(event.cancelable, true);
        assert.deepEqual(event.dataTransfer.files.map((file) => file.name), ["shot.png"]);
        assert.equal(event.clientX, 60);
        assert.equal(event.clientY, 45);
    }
});
