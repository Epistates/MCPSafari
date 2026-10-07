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

/**
 * The background scripts, in the order the manifest loads them.
 *
 * Order matters at load time rather than at call time. These are classic
 * scripts sharing one global, so a function in any file may call a function in
 * any other, but a statement that runs while the page is loading can only see
 * what the files before it have already declared. That is why `background.js`
 * is last: it is the file that registers listeners and starts things.
 */
export const BACKGROUND_SCRIPT_FILES = [
    "background-config.js",
    "background-state.js",
    "background-bridge.js",
    "background-router.js",
    "background-tabs.js",
    "background-navigation.js",
    "background-page.js",
    "background-frames.js",
    "background.js",
];

/**
 * The background script as one source string.
 *
 * Concatenation is faithful here for the same reason the browser can load these
 * as separate files: they share one global scope, so evaluating them back to
 * back in one realm is what the background page already does.
 */
export function backgroundScriptSource() {
    return BACKGROUND_SCRIPT_FILES
        .map((file) => readFileSync(new URL(file, RESOURCES), "utf8"))
        .join("\n");
}

export function extensionSource(file) {
    return readFileSync(new URL(file, RESOURCES), "utf8");
}

export function manifest() {
    return JSON.parse(readFileSync(new URL("manifest.json", RESOURCES), "utf8"));
}
