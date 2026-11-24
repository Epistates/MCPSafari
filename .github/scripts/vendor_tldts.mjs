// Copies tldts, the Public Suffix List that `clear_cookies` checks a domain
// against, into the extension at the version .github/vendor/package.json pins.
//
//   node .github/scripts/vendor_tldts.mjs
//
// Dependabot bumps that pin, and the tests then fail until this has run on the
// branch. It fetches the release from npm, checks the tarball against the
// integrity npm publishes for it, and copies the browser build and its licence
// into Resources/vendor. .github/vendor/tldts.json records the version and the
// SHA-256 of each copied file, so an edit to a vendored file fails the tests too.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../", import.meta.url);
const PIN = new URL(".github/vendor/package.json", ROOT);
const LOCK = new URL(".github/vendor/tldts.json", ROOT);
const VENDOR = new URL("MCPSafari/MCPSafari Extension/Resources/vendor/", ROOT);

// The UMD build defines a `tldts` global when Safari loads it as a classic
// background script, and it carries its own copy of tldts-core.
const FILES = {
    "tldts.umd.min.js": "package/dist/index.umd.min.js",
    "tldts.LICENSE": "package/LICENSE",
};

async function fetchOk(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response;
}

const version = JSON.parse(readFileSync(PIN, "utf8")).dependencies.tldts;
if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`.github/vendor/package.json must pin tldts to an exact version, not ${version}`);
}

const release = await (await fetchOk(`https://registry.npmjs.org/tldts/${version}`)).json();
const integrity = release.dist.integrity;
const tarball = Buffer.from(await (await fetchOk(release.dist.tarball)).arrayBuffer());

const separator = integrity.indexOf("-");
const [algorithm, expected] = [integrity.slice(0, separator), integrity.slice(separator + 1)];
if (algorithm !== "sha512") throw new Error(`npm gave a ${algorithm} integrity for tldts ${version}; expected sha512`);
const actual = createHash("sha512").update(tarball).digest("base64");
if (actual !== expected) throw new Error(`tldts ${version} doesn't match npm's integrity: got sha512-${actual}`);

const work = mkdtempSync(join(tmpdir(), "vendor-tldts-"));
try {
    const archive = join(work, "tldts.tgz");
    writeFileSync(archive, tarball);
    execFileSync("tar", ["-xzf", archive, "-C", work, ...Object.values(FILES)]);

    const files = {};
    for (const [name, member] of Object.entries(FILES)) {
        const destination = new URL(name, VENDOR);
        copyFileSync(join(work, member), fileURLToPath(destination));
        files[name] = createHash("sha256").update(readFileSync(destination)).digest("hex");
    }
    writeFileSync(LOCK, `${JSON.stringify({ version, integrity, files }, null, 2)}\n`);
    console.log(`Vendored tldts ${version}.`);
} finally {
    rmSync(work, { recursive: true, force: true });
}
