import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// Safari doesn't read the extension's background scripts as UTF-8: the page it
// generates for them names no encoding. A character past ASCII in a string then
// arrives as two or three different ones, and tldts, which walks its packed list
// by character offset, answered `uk` for `co.uk`. Every script, stylesheet and
// page is held to ASCII, so no file depends on how Safari decodes it. The
// locale files are JSON, which Safari reads as UTF-8, and translations need it.
const RESOURCES = new URL("../MCPSafari/MCPSafari Extension/Resources/", import.meta.url);
const TEXT = /\.(js|css|html)$/;

test("every script, stylesheet and page in the extension is ASCII", () => {
    const files = readdirSync(RESOURCES, { recursive: true }).filter((name) => TEXT.test(name));
    assert.ok(files.includes("background.js") && files.includes("vendor/tldts.umd.min.js"), "the walk missed the scripts");
    const offenders = files.flatMap((name) => {
        const bytes = readFileSync(new URL(name, RESOURCES));
        const at = bytes.findIndex((byte) => byte > 0x7f);
        if (at < 0) return [];
        const line = bytes.subarray(0, at).toString("latin1").split("\n").length;
        return [`${name}:${line}`];
    });
    assert.deepEqual(offenders, [],
        "Write a character past ASCII as a \\u escape in code, or as plain ASCII in a comment. "
        + "A vendored file gets the escapes from its vendor script.");
});
