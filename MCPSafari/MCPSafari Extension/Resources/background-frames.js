"use strict";

// Talking to content scripts, and routing across a page's frames.

// ─── Content Script Communication ────────────────────────────────────

// ─── Frame Routing ───────────────────────────────────────────────────

// content.js runs in every frame, each with its own uid counter, so a uid
// names the frame that minted it. That keeps frames out of the tool contract:
// nothing takes a frameId, the uid carries it.
const UID_PATTERN = /^f(\d+)e\d+$/;

function frameOfUid(value) {
    const match = UID_PATTERN.exec(String(value ?? ""));
    return match ? Number(match[1]) : null;
}

async function listFrames(tabId) {
    try {
        const frames = await browser.webNavigation.getAllFrames({ tabId });
        if (frames && frames.length > 0) return frames;
    } catch (err) {
        console.warn("[MCPSafari] Frame enumeration failed:", err);
    }
    return [{ frameId: 0, parentFrameId: -1, url: "" }];
}

// A frame whose document refuses the content script (a sandboxed or already
// unloaded one) must not fail the whole call, so misses are dropped.
async function collectFromFrames(tabId, message) {
    const frames = await listFrames(tabId);
    const collected = [];
    for (const frame of frames) {
        try {
            collected.push({
                frameId: frame.frameId,
                data: await sendToContentScript(tabId, message, frame.frameId),
            });
        } catch (err) {
            if (frame.frameId === 0) throw err;
        }
    }
    return collected;
}

// The only failures that mean "the target is not in this frame". Anything else
// means the frame resolved the target and the action did not go through, which
// is already the caller's answer.
//
// `permission_required` is in here because that frame could not be asked at
// all, so another one is still worth trying. `wait_timeout` is in here for the
// same reason, which is why `wait` does not use the sequential path below.
const FRAME_MISS_CODES = new Set(["target_not_found", "wait_timeout", "permission_required"]);

// Targeting by selector or text has no frame in it, so the frames are tried in
// order and the first that resolves the target wins. The top frame is tried
// first, which keeps single-frame pages behaving exactly as before.
async function sendToFirstMatchingFrame(tabId, message) {
    const frames = await listFrames(tabId);
    // Asked of every frame at once rather than in turn. A `wait` whose selector
    // never appears costs its entire timeout in each frame otherwise, so a page
    // with a few iframes runs past the server's bridge timeout and the agent
    // gets a generic failure in place of the `wait_timeout` the content script
    // built for it. Racing is also what the caller meant: wait until this shows
    // up anywhere. Nothing is mutated, so there is no double-action risk here.
    if (message.action === "wait") return waitInAnyFrame(tabId, message, frames);

    let firstMiss;
    for (const frame of frames) {
        try {
            return await sendToContentScript(tabId, message, frame.frameId);
        } catch (err) {
            // Carrying on past a frame that found the target would act in a
            // frame the caller never meant, and for a `click` that already
            // fired before throwing it would fire a second time.
            if (!FRAME_MISS_CODES.has(err.code)) throw err;
            if (!firstMiss) firstMiss = err;
        }
    }
    throw firstMiss || new Error("No frame handled the request");
}

async function waitInAnyFrame(tabId, message, frames) {
    try {
        return await Promise.any(
            frames.map((frame) => sendToContentScript(tabId, message, frame.frameId))
        );
    } catch (err) {
        // Every frame failed. The AggregateError itself carries no tool error
        // code, so report one of the real ones and keep `wait_timeout` and its
        // recovery action intact. Read off `errors` rather than tested with
        // `instanceof`, which is false for an AggregateError raised in another
        // realm than the one this code is evaluated in.
        const reasons = Array.isArray(err && err.errors) ? err.errors : [];
        throw reasons.find((reason) => reason && reason.code) || reasons[0] || err;
    }
}

// Reads the whole tab as one tree by asking each frame for its own and hanging
// each result on the <iframe> that hosts it, so an agent sees the page the way
// a person does instead of a top frame with holes in it.
async function snapshotAcrossFrames(tabId, params) {
    const frames = await listFrames(tabId);
    const trees = new Map();
    const unreachable = [];
    for (const frame of frames) {
        try {
            const tree = await sendToContentScript(
                tabId,
                { action: "snapshot", params },
                frame.frameId
            );
            if (tree) trees.set(frame.frameId, tree);
        } catch (err) {
            if (frame.frameId === 0) throw err;
            // A subframe that will not answer leaves a hole, and a tree with a
            // silent hole in it is the exact thing cross-frame snapshots were
            // built to avoid. Safari grants "Always Allow on This Website" for
            // the top level only, so this is the ordinary case on a page with
            // third-party frames, not an exotic one.
            unreachable.push({
                frameId: frame.frameId,
                origin: originOfUrl(frame.url),
            });
        }
    }

    const childFrames = new Map();
    for (const frame of frames) {
        if (frame.frameId === 0) continue;
        const siblings = childFrames.get(frame.parentFrameId) || [];
        siblings.push(frame);
        childFrames.set(frame.parentFrameId, siblings);
    }

    const root = trees.get(0);
    if (root) {
        spliceFrames(root, 0, childFrames, trees);
        if (unreachable.length > 0) root.unreachableFrames = unreachable;
    }
    return root;
}

function collectFrameHosts(node, hosts = []) {
    if (!node || typeof node !== "object") return hosts;
    if (typeof node.frameSrc === "string") hosts.push(node);
    for (const child of node.children || []) collectFrameHosts(child, hosts);
    return hosts;
}

// getAllFrames reports each frame's URL but not which element hosts it, so the
// two are matched on the resolved src. Identical srcs are matched in document
// order, and a frame whose host cannot be identified is attached to the parent
// tree rather than dropped.
function spliceFrames(tree, frameId, childFrames, trees) {
    const children = childFrames.get(frameId) || [];
    const hosts = collectFrameHosts(tree);
    const claimed = new Set();
    const orphans = [];

    for (const frame of children) {
        const subtree = trees.get(frame.frameId);
        if (!subtree) continue;
        spliceFrames(subtree, frame.frameId, childFrames, trees);

        const host = hosts.find((h) => !claimed.has(h) && h.frameSrc === frame.url);
        if (host) {
            claimed.add(host);
            host.children = [subtree];
        } else {
            orphans.push(subtree);
        }
    }

    if (orphans.length > 0) {
        tree.children = (tree.children || []).concat(orphans);
        tree.unmatchedFrames = orphans.length;
    }
    for (const host of hosts) delete host.frameSrc;
}

// Routes one content action. Frames are an implementation detail here: a uid
// says which frame owns the element, a search spans them all, and everything
// else stays on the top frame where it always ran.
async function dispatchToContent(action, params, message) {
    const payload = message || { action, params };
    const targetFrame = frameOfUid(params.uid) ?? frameOfUid(params.fromUid);
    if (targetFrame !== null) {
        return sendToContentScript(params.tabId, payload, targetFrame);
    }

    if (action === "snapshot") return snapshotAcrossFrames(params.tabId, params);
    if (action === "read_page" && params.format === "snapshot") {
        return snapshotAcrossFrames(params.tabId, params);
    }

    if (action === "find") {
        const collected = await collectFromFrames(params.tabId, payload);
        return collected.flatMap((entry) => entry.data || []);
    }

    if (FRAME_SEARCHING_ACTIONS.has(action) && (params.selector || params.text)) {
        return sendToFirstMatchingFrame(params.tabId, payload);
    }

    return sendToContentScript(params.tabId, payload, 0);
}

// Acting on an element the caller named by selector or text: the element can
// live in any frame, so the search has to cross them.
const FRAME_SEARCHING_ACTIONS = new Set([
    "click",
    "type_text",
    "form_input",
    "select_option",
    "hover",
    "drag",
    "upload_file",
    "drop_file",
    "scroll",
    "wait",
]);

async function sendToContentScript(tabId, message, frameId = 0) {
    const resolvedTabId = tabId || (await getActiveTabId());
    // Before anything that can block on Safari's permission dialog. `wait` and
    // other long actions are unaffected: the probe is separate and short, and
    // the action keeps its own timing once access is established.
    await ensureTabAccess(resolvedTabId);
    // The frame learns its own id from the request it is answering.
    message = { ...message, frameId };
    const options = { frameId };

    try {
        const response = await browser.tabs.sendMessage(resolvedTabId, message, options);
        if (!response) throw new Error("Receiving end does not exist");
        if (response && response.error) {
            throw toolErrorFromResponse(response);
        }
        return response ? response.data : null;
    } catch (err) {
        // Content script might not be injected yet
        if (
            err.message &&
            (err.message.includes("Could not establish connection") ||
                err.message.includes("Receiving end does not exist"))
        ) {
            await injectContentScripts(resolvedTabId);
            const response = await browser.tabs.sendMessage(
                resolvedTabId,
                message,
                options
            );
            if (!response) throw new Error("Content script did not respond after injection");
            if (response && response.error) {
                throw toolErrorFromResponse(response);
            }
            return response ? response.data : null;
        }
        throw err;
    }
}

// Must stay in step with `content_scripts` in the manifest, in this order:
// each file reads what the ones before it published onto the namespace, and
// the dispatcher goes last because it needs every handler.
const CONTENT_SCRIPT_FILES = [
    "content-core.js",
    "content-snapshot.js",
    "content-target.js",
    "content-input.js",
    "content-gesture.js",
    "content-io.js",
    "content.js",
];

async function injectContentScripts(tabId) {
    try {
        await browser.scripting.executeScript({
            target: { tabId },
            files: [
                "trace-interceptor.js",
                "dialog-interceptor.js",
                "console-interceptor.js",
                "network-interceptor.js",
                "file-drop.js",
            ],
            world: "MAIN",
        });
        // The content script is declared for all frames, so a re-injection has
        // to cover them too or the frames stay unreachable until the next
        // navigation. The order has to match `content_scripts` in the manifest:
        // each file reads what the ones before it published.
        await browser.scripting.executeScript({
            target: { tabId, allFrames: true },
            files: CONTENT_SCRIPT_FILES,
        });
        await delay(100);
    } catch (err) {
        console.warn("[MCPSafari] Failed to inject content scripts:", err);
        throw new Error(
            `Cannot inject content scripts into this tab: ${err.message}`
        );
    }
}

