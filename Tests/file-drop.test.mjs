import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(
    new URL("../MCPSafari/MCPSafari Extension/Resources/file-drop.js", import.meta.url),
    "utf8"
);

// Safari mints an entry for an in-memory File whose file() rejects, which is
// the behavior the script papers over.
function brokenEntry(file) {
    return {
        isFile: true,
        isDirectory: false,
        name: file.name,
        fullPath: `/${file.name}`,
        filesystem: { root: { isDirectory: true, fullPath: "/" } },
        file(_onSuccess, onError) {
            onError(new Error("NotFoundError: Path does not exist"));
        },
        getParent(_onSuccess, onError) {
            onError(new Error("NotFoundError: Path does not exist"));
        },
    };
}

class FakeDataTransfer {
    constructor(entryFor = brokenEntry) {
        this.items = [];
        this.items.add = (file) => {
            this.items.push({
                kind: "file",
                getAsFile: () => file,
                webkitGetAsEntry: () => entryFor(file),
            });
        };
    }
    get files() {
        return this.items.map((item) => item.getAsFile());
    }
}

class FakeEvent {
    constructor(type, options = {}) {
        this.type = type;
        Object.assign(this, options);
    }
}

function makeTarget() {
    return {
        events: [],
        scrollIntoView() {},
        getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 50 }),
        dispatchEvent(event) {
            this.events.push(event);
            return true;
        },
    };
}

// Loads file-drop.js and returns a function that posts a bridge request and
// resolves with the page's reply.
function loadFileDrop({ target, DataTransfer = FakeDataTransfer } = {}) {
    let onMessage;
    const replies = [];
    const window = {
        addEventListener: (_type, fn) => { onMessage = fn; },
        postMessage: (message) => replies.push(message),
    };

    vm.runInNewContext(source, {
        window,
        document: { querySelector: (selector) => (selector.includes("marker-1") ? target : null) },
        DataTransfer,
        DragEvent: FakeEvent,
    });

    return (params) => {
        onMessage({ source: window, data: { source: "MCPSafariContent", id: "req", type: "drop_files", params } });
        return replies.pop();
    };
}

const PNG = new File([new Uint8Array([137, 80, 78, 71])], "shot.png", { type: "image/png" });
const TXT = new File(["hi"], "note.txt", { type: "text/plain" });

test("drop dispatches dragenter, dragover, drop with entries that resolve the files", async () => {
    const target = makeTarget();
    const request = loadFileDrop({ target });

    const reply = request({ marker: "marker-1", files: [PNG, TXT] });

    assert.equal(reply.source, "MCPSafariPage");
    assert.equal(reply.id, "req");
    assert.equal(reply.error, undefined);
    assert.equal(reply.data.dropped, 2);
    assert.deepEqual(target.events.map((event) => event.type), ["dragenter", "dragover", "drop"]);
    const { dataTransfer } = target.events[2];
    assert.equal(target.events[2].clientX, 60);
    assert.equal(target.events[2].clientY, 45);
    assert.deepEqual(dataTransfer.files.map((file) => file.name), ["shot.png", "note.txt"]);

    for (const [index, item] of dataTransfer.items.entries()) {
        const entry = item.webkitGetAsEntry();
        assert.equal(entry.isFile, true);
        assert.equal(entry.isDirectory, false);
        assert.equal(entry.name, dataTransfer.files[index].name);
        assert.equal(entry.fullPath, `/${entry.name}`);
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        assert.equal(file, dataTransfer.files[index]);
        const parent = await new Promise((resolve, reject) => entry.getParent(resolve, reject));
        assert.equal(parent, entry.filesystem.root);
    }
});

test("drop still dispatches when the native entry API throws", () => {
    const target = makeTarget();
    class ThrowingDataTransfer extends FakeDataTransfer {
        constructor() {
            super(() => { throw new Error("entry unavailable"); });
        }
    }
    const request = loadFileDrop({ target, DataTransfer: ThrowingDataTransfer });

    const reply = request({ marker: "marker-1", files: [PNG] });

    assert.equal(reply.data.dropped, 1);
    assert.deepEqual(target.events.map((event) => event.type), ["dragenter", "dragover", "drop"]);
    assert.throws(() => target.events[2].dataTransfer.items[0].webkitGetAsEntry(), /entry unavailable/);
});

test("drop leaves a null entry alone", () => {
    const target = makeTarget();
    class NullEntryDataTransfer extends FakeDataTransfer {
        constructor() {
            super(() => null);
        }
    }
    const request = loadFileDrop({ target, DataTransfer: NullEntryDataTransfer });

    request({ marker: "marker-1", files: [PNG] });

    assert.equal(target.events[2].dataTransfer.items[0].webkitGetAsEntry(), null);
});

test("drop reports a missing target instead of dispatching", () => {
    const target = makeTarget();
    const request = loadFileDrop({ target });

    const reply = request({ marker: "other", files: [PNG] });

    assert.equal(reply.error, "Drop target not found in page");
    assert.equal(target.events.length, 0);
});
