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

// The top frame is still worth reading when the page's frames cannot be
// listed, so the call degrades to it. `enumerated` is what keeps that from
// being silent: a caller that builds a whole-page answer has to say it only
// saw the top frame, the same way it says so for a frame that will not answer.
async function listFrames(tabId) {
    // Listing frames is a call into the page like any other: on an origin Safari
    // has not decided it parks on the permission dialog, so the caller waited out
    // the bridge timeout instead of hearing `permission_required`. Outside the
    // try below, because a refusal must not read as "frames unavailable".
    await ensureTabAccess(tabId);
    try {
        const frames = await browser.webNavigation.getAllFrames({ tabId });
        if (frames && frames.length > 0) return { frames, enumerated: true };
    } catch (err) {
        console.warn("[MCPSafari] Frame enumeration failed:", err);
    }
    return { frames: [{ frameId: 0, parentFrameId: -1, url: "" }], enumerated: false };
}

// How a whole-page answer says what it could not read: one entry per frame that
// would not answer, and one for a frame list that could not be read at all.
// Not a frame, so the second has no id or origin to give. It takes the same list
// because the caller's question is the same: is this the whole page?
function unreachableFrame(frame) {
    return { frameId: frame.frameId, origin: originOfUrl(frame.url) };
}

const FRAME_ENUMERATION_FAILED = { frameId: null, origin: null, reason: "frame_enumeration_failed" };

// A frame whose document refuses the content script (a sandboxed or already
// unloaded one) must not fail the whole call, so a miss is set aside, but not
// forgotten: the caller is told which frames were not searched.
async function collectFromFrames(tabId, message) {
    const { frames, enumerated } = await listFrames(tabId);
    const collected = [];
    const unreachable = enumerated ? [] : [{ ...FRAME_ENUMERATION_FAILED }];
    for (const frame of frames) {
        try {
            collected.push({
                frameId: frame.frameId,
                data: await sendToContentScript(tabId, message, frame.frameId),
            });
        } catch (err) {
            if (frame.frameId === 0) throw err;
            unreachable.push(unreachableFrame(frame));
        }
    }
    return { collected, unreachable };
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
    const { frames } = await listFrames(tabId);
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
    const { frames, enumerated } = await listFrames(tabId);
    const trees = new Map();
    const unreachable = enumerated ? [] : [{ ...FRAME_ENUMERATION_FAILED }];
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
            unreachable.push(unreachableFrame(frame));
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
        const { collected, unreachable } = await collectFromFrames(params.tabId, payload);
        const matches = collected.flatMap((entry) => entry.data || []);
        // A list that is silently short looks complete, so a search that left
        // frames out says which, as a snapshot does. A complete one stays a
        // plain list.
        return unreachable.length > 0 ? { matches, unreachableFrames: unreachable } : matches;
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
    // The router has named the tab by now (`withResolvedTab`). Not defaulted to
    // the active tab here: a path that arrived without one would act on a page
    // nobody chose, and ignore the tab a server pinned.
    const resolvedTabId = tabId;
    // Before anything that can block on Safari's permission dialog. `wait` and
    // other long actions are unaffected: the probe is separate and short, and
    // the action keeps its own timing once access is established.
    await ensureTabAccess(resolvedTabId);
    // The frame learns its own id from the request it is answering.
    message = { ...message, frameId };
    const ask = () => browser.tabs.sendMessage(resolvedTabId, message, { frameId });

    // Safari's `tabs.sendMessage` does not throw when no content script is
    // listening: it resolves undefined, exactly as it does when the document
    // goes away before replying. After the fact the two cannot be told apart,
    // and guessing wrong either never injects (a tab opened before the extension
    // was enabled fails every action) or sends a click twice. So an action that
    // must not run twice asks first, with a message that changes nothing.
    const repeatable = isRepeatSafe(message);
    if (!repeatable) await ensureListener(resolvedTabId, frameId);

    let response;
    try {
        response = await ask();
        // Cheaper than a ping for an action that can simply be asked again.
        if (!response && repeatable) {
            await injectContentScripts(resolvedTabId);
            response = await ask();
        }
    } catch (err) {
        // The thrown form, which other engines use and the test fake does too.
        // The message never reached a page, so a second send repeats nothing.
        if (!isNoReceiverError(err)) throw err;
        await injectContentScripts(resolvedTabId);
        response = await ask();
    }
    return unpackReply(response, message);
}

// Actions that change nothing, or that leave the page as one run leaves it, so
// that asking twice is harmless. Everything else is sent once and only once.
//   - read_page, get_page_text, snapshot, find: read the page. A snapshot may
//     mint uids, and asking again mints or reuses them, which no caller can see.
//   - element_rect, native_pointer_points: measure, scrolling the target into
//     view, which a second scroll to the same place does not change.
//   - prepare_native_input, prepare_native_key: focus the target, and focusing
//     what is already focused does nothing.
//   - wait: polls or sleeps. `waitAcrossNavigations` already asks it again.
//   - get_console_messages, get_network_requests: reads, but see below.
//   - ping: answers and nothing else.
// Not here: click, type_text, form_input, select_option, press_key, hover, drag
// and the file actions dispatch events, scroll is relative, start_trace,
// stop_trace and handle_dialog hold state that a second call would reset or
// consume.
const REPEAT_SAFE_ACTIONS = new Set([
    "read_page",
    "get_page_text",
    "snapshot",
    "find",
    "element_rect",
    "native_pointer_points",
    "prepare_native_input",
    "prepare_native_key",
    "wait",
    "get_console_messages",
    "get_network_requests",
    "ping",
]);

function isRepeatSafe(message) {
    if (!REPEAT_SAFE_ACTIONS.has(message.action)) return false;
    // A read that clears what it read empties the buffer, so a second one would
    // answer with nothing the first had not already taken.
    const params = message.params || {};
    return !params.clear && !params.clearIds;
}

// Makes sure a content script is listening in this frame, injecting it if not.
// Safari reports a tab with nothing listening as undefined, not as an error, so
// the question is put as a ping: no answer means nobody is there.
async function ensureListener(tabId, frameId) {
    if (await contentScriptAnswers(tabId, frameId)) return;
    await injectContentScripts(tabId);
    if (!(await contentScriptAnswers(tabId, frameId))) {
        throw new Error("Content script did not respond after injection");
    }
}

async function contentScriptAnswers(tabId, frameId) {
    try {
        const response = await browser.tabs.sendMessage(tabId, { action: "ping", frameId }, { frameId });
        return Boolean(response) && !response.error;
    } catch (err) {
        if (isNoReceiverError(err)) return false;
        throw err;
    }
}

function isNoReceiverError(err) {
    return Boolean(err && err.message
        && (err.message.includes("Could not establish connection")
            || err.message.includes("Receiving end does not exist")));
}

// The content script answers every message it takes with an object, so by now
// no answer at all means the document went away before replying, and the
// message was delivered: a click that navigates has clicked. It used to be
// turned into a no-receiver error here, which injected the scripts and sent the
// click a second time.
function unpackReply(response, message) {
    if (!response) throw replyLostError(message.action);
    if (response.error) throw toolErrorFromResponse(response);
    return response.data;
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

