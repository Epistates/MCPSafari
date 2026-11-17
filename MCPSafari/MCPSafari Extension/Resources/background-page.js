"use strict";

// Screenshots, page JavaScript execution and window resizing.

// ─── Screenshot Handler ─────────────────────────────────────────────

async function handleScreenshot(params) {
    requireTopFrameTarget(params, SCREENSHOT_TOP_FRAME_ONLY);
    const tabId = params.tabId;
    // Before the `tabs.get` below, which blocks on Safari's dialog just like the
    // capture does. Deadlining only the capture left this line to absorb the
    // whole wait, so a blocked screenshot still took the full bridge timeout and
    // still reported the wrong reason.
    await ensureTabAccess(tabId);
    const tab = await browser.tabs.get(tabId);

    // captureVisibleTab captures the active tab in a window
    if (!tab.active) {
        await browser.tabs.update(tabId, { active: true });
        await delay(300);
    }

    // Context before the frame: a page that loses focus between the two reads
    // then produces a warning about a good frame rather than an all-clear on a
    // stale one.
    // The target is scrolled into view before the context read so the
    // reported viewport matches the frame.
    const target = params.uid || params.selector
        ? await sendToContentScript(tabId, {
            action: "element_rect",
            params: { uid: params.uid, selector: params.selector },
        })
        : null;
    const context = await capturePageContext(tabId);
    // Deliberately not `ensureTabAccess`: the context read above is allowed to
    // fail and still produce a picture, and a probe would turn that graceful
    // degradation into a refusal. A capture is sub-second when it is permitted
    // at all, so a deadline here separates "blocked on the dialog" from "slow".
    // captureVisibleTab takes the window, not the tab, and returns whichever
    // tab is showing. The activation above is a request that the user's next
    // click can undo, so it is confirmed on both sides of the capture: before,
    // so a stale tab is not captured, and after, so a switch during the capture
    // does not return another page's pixels under this tab's metadata.
    await assertTabShowing(tabId, tab.windowId, "the screenshot");
    const dataUrl = await withPermissionDeadline(
        browser.tabs.captureVisibleTab(tab.windowId, { format: "png" }),
        tabId
    );
    await assertTabShowing(tabId, tab.windowId, "the screenshot");

    return {
        // Raw base64, data URI prefix stripped
        image: dataUrl.replace(/^data:image\/\w+;base64,/, ""),
        ...context,
        ...(target ? { target } : {}),
    };
}

// Viewport, scale, visibility, and focus at capture time. Safari does not
// repaint an occluded page, so a capture of a hidden page can predate the last
// action, and it does not match :focus while its window is not key.
async function capturePageContext(tabId) {
    try {
        const results = await browser.scripting.executeScript({
            target: { tabId },
            func: () => ({
                visible: document.visibilityState === "visible",
                hasFocus: document.hasFocus(),
                viewport: {
                    width: window.innerWidth,
                    height: window.innerHeight,
                },
                devicePixelRatio: window.devicePixelRatio,
            }),
        });
        return results[0]?.result || {};
    } catch (err) {
        console.warn("[MCPSafari] Screenshot context unavailable:", err);
        return {};
    }
}

// ─── JavaScript Execution Handler ────────────────────────────────────

// ─── JavaScript execution ────────────────────────────────────────────
//
// The agent's code is compiled in the page's own world, so it sees the page's
// globals. A page whose Content Security Policy forbids evaluating strings
// refuses that compile, and then the code runs in the content scripts' isolated
// world instead, which shares the DOM.
//
// Where the code runs is decided before any of it runs, by a probe that only
// compiles, and never from how a run turned out. A run in the page's world goes
// through the page's own `Promise`, `Function` and error objects, so a page can
// make a finished run look like anything, including a refusal; deciding from
// that once ran the code a second time in the isolated world, repeating every
// click, submission or purchase it made. A page sets its own CSP, so it can
// still choose the isolated world by refusing; what it cannot do is get the
// code run twice.

/** The two forms the agent's code is tried in: a bare expression, then a function body. */
function userCodeSources(code) {
    const text = String(code);
    return {
        expression: `return (async () => (${text.trim().replace(/;+$/, "")}))()`,
        statements: `return (async () => { ${text} })()`,
    };
}

// Injected into a page's world, so it must not close over anything here. Compiles
// both forms and runs neither, and says which compiled: "expression",
// "statements", "refused" (this world will not compile strings), or "syntax"
// (neither form is valid code). The sources arrive ready-made and the answer is
// a string, so there is nothing of the page's in the result.
function probeUserCode(expressionSource, statementsSource) {
    "use strict";
    const refused = (e) => typeof EvalError !== "undefined" && e instanceof EvalError;
    try {
        new Function(expressionSource);
        return "expression";
    } catch (e) {
        if (refused(e)) return "refused";
    }
    try {
        new Function(statementsSource);
        return "statements";
    } catch (e) {
        return refused(e) ? "refused" : "syntax";
    }
}

// Injected into a page's world, so it must not close over anything here. Runs
// one form of the agent's code, once, and returns an envelope with the value or
// the error: `{ ok: true, value }` or `{ ok: false, error }`. The user's value
// only ever sits inside `value`, so nothing it holds can read as an outcome.
function runUserCode(source) {
    "use strict";
    const failure = (e) => ({ ok: false, error: e && e.message ? String(e.message) : String(e) });
    let fn;
    try {
        fn = new Function(source);
    } catch (e) {
        return failure(e);
    }
    try {
        return fn().then((value) => ({ ok: true, value }), failure);
    } catch (e) {
        return failure(e);
    }
}

const USER_CODE_FORMS = new Set(["expression", "statements", "refused", "syntax"]);

async function handleJavaScript(params) {
    const tabId = params.tabId;
    await ensureTabAccess(tabId);
    const sources = userCodeSources(params.code);
    const inWorld = async (world, func, args) => {
        const results = await browser.scripting.executeScript({ target: { tabId }, func, args, world });
        return results && results.length > 0 ? results[0].result : undefined;
    };
    const probe = async (world) => {
        const form = await inWorld(world, probeUserCode, [sources.expression, sources.statements]);
        // Anything else is a probe that did not run as written; the plain run
        // below then reports whatever the code does.
        return USER_CODE_FORMS.has(form) ? form : "statements";
    };

    let world = "MAIN";
    let form = await probe("MAIN");
    if (form === "refused") {
        // The isolated world does not inherit the page's CSP and still shares
        // the DOM, so DOM-based code survives a strict script-src. Page
        // JavaScript globals do not exist there, which the caller is told.
        world = "ISOLATED";
        form = await probe("ISOLATED");
        if (form === "refused") {
            throw new Error(
                "The page's Content Security Policy blocks evaluating code as a string, "
                + "in both the page world and the extension's isolated world. "
                + "Use snapshot, find, or read_page to inspect the page, and click or "
                + "type_text to drive it."
            );
        }
    }

    // Exactly one run, in the world the probe settled on. A form that will not
    // compile is run as a body, which reports the syntax error as it stands.
    const outcome = await inWorld(world, runUserCode, [form === "expression" ? sources.expression : sources.statements]);
    // No envelope at all is what a result that cannot be cloned out of the page
    // looks like, and has always read as a value of `undefined`.
    const result = outcome && typeof outcome.ok === "boolean" ? outcome : { ok: true, value: undefined };
    if (!result.ok) throw new Error(result.error);
    const value = result.value !== undefined ? JSON.stringify(result.value) : "undefined";
    return world === "ISOLATED"
        ? `${value}\n\n[Ran in the extension's isolated world: the page's CSP blocked evaluation in the page world. The DOM is shared, but page JavaScript globals such as window properties set by the site are not visible.]`
        : value;
}

// ─── Window Resize Handler ───────────────────────────────────────────

async function handleResizeWindow(params) {
    // Routed like every other handler. Reading `currentWindow` directly ignored
    // both `tabId` and the pin `select_tab` sets, so with the agent's tab in one
    // window and the user clicked into another, the resize landed on the user's
    // and a screenshot afterwards did not match the viewport that was asked for.
    const tabId = params.tabId;
    // The `tabs.get` below parks on Safari's dialog like every other call that
    // reads the tab, so an ungranted tab rode the bridge timeout here.
    await ensureTabAccess(tabId);
    const tab = await browser.tabs.get(tabId);
    await browser.windows.update(tab.windowId, {
        width: params.width,
        height: params.height,
    });
    return `Resized window to ${params.width}x${params.height}`;
}

