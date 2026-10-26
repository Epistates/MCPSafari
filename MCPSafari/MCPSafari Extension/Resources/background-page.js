"use strict";

// Screenshots, page JavaScript execution and window resizing.

// ─── Screenshot Handler ─────────────────────────────────────────────

async function handleScreenshot(params) {
    requireTopFrameTarget(params, SCREENSHOT_TOP_FRAME_ONLY);
    const tabId = params.tabId || (await getActiveTabId());
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

// Injected into the target world, so it must not close over anything here.
//
// Returns an envelope, `{ ok: true, value }` or `{ ok: false, error, cspBlocked }`,
// and the user's value only ever sits inside `value`. It used to be returned
// bare, with failures marked by `__error` and `__cspBlocked` keys on it, so a
// page value like `window.cartState = { __cspBlocked: true }` read as a CSP
// refusal and the code, already run once, was run again in the isolated world.
function evaluateUserCode(code) {
    // A page whose script-src omits 'unsafe-eval' refuses to compile a string in
    // its own realm, which is what new Function does here. Only compiling is
    // classified: the refusal comes before anything has run, which is what makes
    // the fallback safe, so an error thrown by the code itself, whatever its
    // message says, is never taken for one.
    const failure = (e, compiling) => {
        const message = e && e.message ? e.message : String(e);
        const cspBlocked = compiling
            && ((typeof EvalError !== "undefined" && e instanceof EvalError)
                || /unsafe-eval|trusted-types-eval|Content Security Policy/i.test(message));
        return { ok: false, error: message, cspBlocked };
    };

    let fn;
    try {
        const expressionCode = String(code).trim().replace(/;+$/, "");
        try {
            fn = new Function(`return (async () => (${expressionCode}))()`);
        } catch (e) {
            // A syntax error means it is not a bare expression; a CSP refusal
            // means neither form will compile, so do not retry it as one.
            if (typeof EvalError !== "undefined" && e instanceof EvalError) return failure(e, true);
            fn = new Function(`return (async () => { ${code} })()`);
        }
    } catch (e) {
        return failure(e, true);
    }

    try {
        return fn().then((value) => ({ ok: true, value }), (e) => failure(e, false));
    } catch (e) {
        return failure(e, false);
    }
}

async function handleJavaScript(params) {
    const tabId = params.tabId || (await getActiveTabId());
    await ensureTabAccess(tabId);
    const runIn = async (world) => {
        const results = await browser.scripting.executeScript({
            target: { tabId },
            func: evaluateUserCode,
            args: [params.code],
            world,
        });
        const outcome = results && results.length > 0 ? results[0].result : undefined;
        // No envelope at all is what a result that cannot be cloned out of the
        // page looks like, and has always read as a value of `undefined`.
        return outcome && typeof outcome.ok === "boolean" ? outcome : { ok: true, value: undefined };
    };

    let outcome = await runIn("MAIN");
    let isolated = false;

    if (!outcome.ok && outcome.cspBlocked === true) {
        // The isolated world does not inherit the page's CSP and still shares
        // the DOM, so DOM-based code survives a strict script-src. Page
        // JavaScript globals do not exist there, which the caller is told.
        // Retrying is safe because a CSP refusal happens at compile time, so
        // nothing in the submitted code has run yet and side effects cannot double.
        const fallback = await runIn("ISOLATED");
        if (!fallback.ok && fallback.cspBlocked === true) {
            throw new Error(
                "The page's Content Security Policy blocks evaluating code as a string, "
                + "in both the page world and the extension's isolated world. "
                + "Use snapshot, find, or read_page to inspect the page, and click or "
                + "type_text to drive it."
            );
        }
        outcome = fallback;
        isolated = true;
    }

    if (!outcome.ok) throw new Error(outcome.error);
    const value = outcome.value !== undefined ? JSON.stringify(outcome.value) : "undefined";
    return isolated
        ? `${value}\n\n[Ran in the extension's isolated world: the page's CSP blocked evaluation in the page world. The DOM is shared, but page JavaScript globals such as window properties set by the site are not visible.]`
        : value;
}

// ─── Window Resize Handler ───────────────────────────────────────────

async function handleResizeWindow(params) {
    // Routed like every other handler. Reading `currentWindow` directly ignored
    // both `tabId` and the pin `select_tab` sets, so with the agent's tab in one
    // window and the user clicked into another, the resize landed on the user's
    // and a screenshot afterwards did not match the viewport that was asked for.
    const tabId = params.tabId || (await getActiveTabId());
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

