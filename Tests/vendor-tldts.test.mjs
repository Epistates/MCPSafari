import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

// tldts is copied into the extension, so nothing installs it and nothing would
// notice it drifting from the version Dependabot keeps pinned. These fail until
// `node .github/scripts/vendor_tldts.mjs` has copied the pinned release.
const ROOT = new URL("../", import.meta.url);
const VENDOR = new URL("MCPSafari/MCPSafari Extension/Resources/vendor/", ROOT);
const pin = JSON.parse(readFileSync(new URL(".github/vendor/package.json", ROOT), "utf8"));
const lock = JSON.parse(readFileSync(new URL(".github/vendor/tldts.json", ROOT), "utf8"));
const REVENDOR = "run node .github/scripts/vendor_tldts.mjs";

test("the vendored tldts is the version the pin names", () => {
    assert.equal(lock.version, pin.dependencies.tldts, `the pin moved: ${REVENDOR}`);
});

test("the vendored tldts files are the ones the vendor script copied", () => {
    assert.deepEqual(Object.keys(lock.files).sort(), ["tldts.LICENSE", "tldts.umd.min.js"]);
    for (const [name, sha256] of Object.entries(lock.files)) {
        const actual = createHash("sha256").update(readFileSync(new URL(name, VENDOR))).digest("hex");
        assert.equal(actual, sha256, `vendor/${name} was changed by hand: ${REVENDOR}`);
    }
});
