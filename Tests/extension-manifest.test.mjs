import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
    BACKGROUND_SCRIPT_FILES,
    CONTENT_SCRIPT_FILES,
    extensionSource,
    manifest,
} from "./helpers/extension-sources.mjs";

const RESOURCES = new URL("../MCPSafari/MCPSafari Extension/Resources/", import.meta.url);

// The same list of files now lives in three places: the manifest, the tests,
// and (for content scripts) the re-injection list in the background. Tests
// concatenate the files themselves, so drift between those lists cannot fail a
// behaviour test. It would ship as a file the browser never loads.
test("the manifest's background scripts are the list the tests load", () => {
    assert.deepEqual(manifest().background.scripts, BACKGROUND_SCRIPT_FILES);
});

test("the manifest's content scripts are the list the tests load", () => {
    const declared = manifest().content_scripts.find((entry) => entry.world !== "MAIN");
    assert.deepEqual(declared.js, CONTENT_SCRIPT_FILES);
});

test("the re-injection list matches the content scripts the manifest declares", () => {
    // injectContentScripts re-injects by name when a tab has lost its content
    // script. A file missing from that list leaves the tab half-loaded.
    const source = extensionSource("background-frames.js");
    const literal = /const CONTENT_SCRIPT_FILES = \[([^\]]*)\]/.exec(source);
    assert.ok(literal, "CONTENT_SCRIPT_FILES literal not found in background-frames.js");
    const listed = [...literal[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(listed, CONTENT_SCRIPT_FILES);
});

test("every script the manifest names exists", () => {
    for (const file of [...BACKGROUND_SCRIPT_FILES, ...CONTENT_SCRIPT_FILES]) {
        assert.ok(existsSync(new URL(file, RESOURCES)), `${file} is missing`);
    }
});

test("the background is not declared as a module", () => {
    // The background files are classic scripts that share one global: a
    // function in any of them may call a function in any other, with no
    // imports. `"type": "module"` would give each file its own scope and break
    // every cross-file reference at once, and no test here would catch it,
    // because the tests concatenate the files into a single realm.
    assert.equal(manifest().background.type, undefined);
});
