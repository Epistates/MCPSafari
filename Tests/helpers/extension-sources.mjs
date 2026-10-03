import { readFileSync } from "node:fs";

const RESOURCES = new URL("../../MCPSafari/MCPSafari Extension/Resources/", import.meta.url);

/**
 * The content script files, in the order the manifest injects them.
 *
 * Kept here rather than in each test so there is one list to change, and so a
 * file added to the manifest without being added to the tests shows up as a
 * failure rather than as silently untested code.
 */
export const CONTENT_SCRIPT_FILES = [
    "content-core.js",
    "content-snapshot.js",
    "content-target.js",
    "content-input.js",
    "content-gesture.js",
    "content-io.js",
    "content.js",
];

/**
 * The content script as one source string.
 *
 * Concatenation is faithful to how Safari runs these: every file is its own
 * IIFE sharing one namespace on the isolated world, so running them back to
 * back in a single realm is exactly sequential injection. The boundaries still
 * hold, because a file can only see what the ones before it published.
 */
export function contentScriptSource() {
    return CONTENT_SCRIPT_FILES
        .map((file) => readFileSync(new URL(file, RESOURCES), "utf8"))
        .join("\n");
}

export function extensionSource(file) {
    return readFileSync(new URL(file, RESOURCES), "utf8");
}
