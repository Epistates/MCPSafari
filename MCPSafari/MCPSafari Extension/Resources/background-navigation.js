"use strict";

// navigate, and waiting for the load it starts.

// ─── Navigation Handler ─────────────────────────────────────────────

async function handleNavigate(params) {
    const tabId = params.tabId || (await getActiveTabId());
    const action = params.action || "goto";
    // Best effort, and deliberately not gated on access to the page being left.
    // This only tells a real navigation from a same-document one, and
    // `waitForTabLoad` already reads it as `beforeTab?.url || ""`. Requiring a
    // grant here would take away the one move that gets a caller off a page
    // they cannot use, and leaving it unbounded spent the bridge timeout on it.
    const beforeTab = await withDeadline(browser.tabs.get(tabId), PERMISSION_DEADLINE_MS)
        .catch(() => null);

    let message;
    let tab;
    switch (action) {
        case "goto":
            if (!params.url) throw new Error("URL required for 'goto' action");
            const gotoComplete = waitForTabLoad(tabId, beforeTab);
            await browser.tabs.update(tabId, { url: params.url });
            tab = await gotoComplete;
            message = "Navigated to";
            break;

        // `goto` and `reload` go through the tabs API and need no access to the
        // page. Going back or forward is a script run inside it, so it parks on
        // Safari's dialog like any other page-touching call and is gated like
        // one. Before the load wait is armed, so a refusal leaves no listener.
        case "back":
            await ensureTabAccess(tabId);
            const backComplete = waitForTabLoad(tabId, beforeTab);
            await browser.scripting.executeScript({
                target: { tabId },
                func: () => history.back(),
            });
            tab = await backComplete;
            message = "Navigated back to";
            break;

        case "forward":
            await ensureTabAccess(tabId);
            const forwardComplete = waitForTabLoad(tabId, beforeTab);
            await browser.scripting.executeScript({
                target: { tabId },
                func: () => history.forward(),
            });
            tab = await forwardComplete;
            message = "Navigated forward to";
            break;

        case "reload":
            const reloadComplete = waitForTabLoad(tabId, beforeTab);
            await browser.tabs.reload(tabId);
            tab = await reloadComplete;
            message = "Reloaded";
            break;

        default:
            throw new Error(`Unknown navigation action: ${action}`);
    }

    // Return tab info so the caller knows where they landed
    tab = tab || (await browser.tabs.get(tabId));
    return `${message} ${describeLanding(tab)}`;
}

// Where a tab ended up, as the tools say it: the URL with its secrets redacted,
// and the title unless the site has not been granted, because the page's own
// title is not for a site that has not been granted.
function describeLanding(tab) {
    const title = siteIsGranted(tab.url)
        ? `(${tab.title || ""})`
        : "(title withheld: MCPSafari has not been granted access to this site)";
    return `${redactUrlSecrets(tab.url)} ${title}`;
}

// How long a page load is given to finish, for `navigate` and for the load an
// interaction starts. Well under the server's 30-second bridge timeout, which
// the dispatch before it and the settling after it also have to fit inside.
const LOAD_TIMEOUT_MS = 15_000;

// How long after an interaction is dispatched we watch for it to start a page
// load before concluding it did not. A click on a link or a form submit begins
// its navigation in the same task as the event, and Safari reports the load to
// the extension within a few tens of milliseconds, so this is a generous
// margin for that report rather than a guess at page speed. It is also the
// latency every click, key press and form change pays when it navigates
// nowhere, which is why it is not longer. A navigation the page starts later
// than this, from a timer or after a fetch, is not waited for here; a `wait`
// that is pending when it begins survives it instead (`waitAcrossNavigations`).
const NAVIGATION_START_WINDOW_MS = 400;

// ─── Interactions that start a load ─────────────────────────────────

// Runs an interaction and, if it starts a navigation in this tab, answers only
// once that navigation has finished. Without this the interaction answered the
// moment its event was dispatched: the next read saw the page being left, and a
// `wait` sent straight after was torn down with that page and could only end by
// riding out the server's 30-second bridge timeout.
//
// The load watcher is armed before the action runs, because a link can start
// loading before the content script has finished replying and a missed event is
// not replayed. Its no-navigation countdown starts when the action returns
// instead, so a slow dispatch (a frame search, a permission probe) does not use
// up the window.
async function dispatchAndSettle(action, params) {
    const tabId = params.tabId;
    // Before the tab is read, so a tab that has not been granted is refused as
    // `permission_required` here instead of spending the read's deadline first.
    await ensureTabAccess(tabId);
    // Best effort, as in `handleNavigate`: it only tells a navigation from none.
    const beforeTab = await withDeadline(browser.tabs.get(tabId), PERMISSION_DEADLINE_MS)
        .catch(() => null);

    let actionReturned;
    const returned = new Promise((resolve) => { actionReturned = resolve; });
    const settled = waitForTabLoad(tabId, beforeTab, LOAD_TIMEOUT_MS, NAVIGATION_START_WINDOW_MS, returned);

    let result;
    try {
        result = await dispatchToContent(action, params);
    } catch (err) {
        // The action's own failure is the answer. The watcher still has to be
        // let go, and nothing is left to read what it settles with.
        settled.catch(() => {});
        throw err;
    } finally {
        actionReturned();
    }

    // The click has happened by now, so nothing about waiting for its load may
    // turn it into a failure: a tab that closed itself, or a final read that
    // never returned, only costs the report of where the page went.
    const afterTab = await withDeadline(settled, LOAD_TIMEOUT_MS + PERMISSION_PROBE_TIMEOUT_MS)
        .catch(() => null);
    return withNavigationNote(result, beforeTab, afterTab);
}

// A string result gets a trailing line, which is how the tools already add
// asides, and reaches the client as text. An object result gets a field.
function withNavigationNote(result, beforeTab, afterTab) {
    if (!beforeTab || !afterTab || !afterTab.url || afterTab.url === beforeTab.url) return result;

    if (typeof result === "string") {
        const unfinished = afterTab.status === "loading" ? "; it was still loading" : "";
        return `${result}\nPage navigated to ${describeLanding(afterTab)}${unfinished}`;
    }
    if (result && typeof result === "object" && !Array.isArray(result)) {
        return { ...result, navigatedTo: redactUrlSecrets(afterTab.url) };
    }
    return result;
}

// ─── Waiting through a navigation ───────────────────────────────────

// The content script's `wait` polls inside one document. When that document is
// replaced, the poll and the reply to the request go with it, so nothing ever
// answers and the call ends at the bridge timeout, reported as a bridge
// failure for a page that loaded fine. This races the content script against
// the tab starting a load. If the load wins, the abandoned poll is dropped, the
// load is awaited, and the wait is sent again to whatever document it produced
// with the time that is left, so a navigation started by the page's own script
// is covered as well as one the agent started.
//
// `send` takes the params to use, which differ only in their remaining time.
async function waitAcrossNavigations(params, send) {
    const tabId = params.tabId;
    // The same budget the content script reads: `seconds` is a sleep, anything
    // else a poll with a timeout.
    const budgetMs = (params.seconds ? params.seconds : (params.timeout || 10)) * 1000;
    const deadline = Date.now() + budgetMs;
    let current = params;

    for (;;) {
        const watcher = watchForLoadStart(tabId);
        let outcome;
        try {
            outcome = await Promise.race([
                send(current).then((value) => ({ value }), (error) => ({ error })),
                watcher.started,
            ]);
        } finally {
            watcher.stop();
        }

        if (outcome.error) {
            // A tool error is the content script's own answer, `wait_timeout`
            // included. What is left is the transport failing, and that only
            // means the document went away if a load explains it.
            if (typeof outcome.error.code === "string") throw outcome.error;
            if (!watcher.sawLoad() && !(await tabIsLoading(tabId))) throw outcome.error;
        } else if ("value" in outcome) {
            return outcome.value;
        }

        await waitForLoadComplete(tabId, deadline - Date.now());
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw waitInterruptedError(params);
        current = params.seconds
            ? { ...params, seconds: remainingMs / 1000, timeout: remainingMs / 1000 }
            : { ...params, timeout: remainingMs / 1000 };
    }
}

// What the content script would have said for the same wait that ran out,
// with the reason it ran out added, since the page it started on is gone.
function waitInterruptedError(params) {
    const target = params.selector
        ? `selector: ${params.selector}`
        : params.text ? `text: "${params.text}"` : `${params.seconds} seconds`;
    const error = new Error(
        `Timeout waiting for ${target} (the page navigated while waiting and the time ran out on the new page)`
    );
    error.code = "wait_timeout";
    error.retryable = true;
    error.recoveryAction = "retry";
    return error;
}

// Resolves `started` when the tab begins loading, which is the first thing a
// navigation does and happens before the old document is torn down. Top frame
// only: `tabs.onUpdated` reports the tab, and a subframe's load is not a
// replacement of the document a `wait` is polling.
function watchForLoadStart(tabId) {
    let seen = false;
    let notify;
    const started = new Promise((resolve) => { notify = resolve; });
    const onUpdated = (updatedTabId, changeInfo) => {
        if (updatedTabId !== tabId || changeInfo.status !== "loading") return;
        seen = true;
        notify({ navigated: true });
    };
    browser.tabs.onUpdated.addListener(onUpdated);
    return {
        started,
        sawLoad: () => seen,
        stop: () => browser.tabs.onUpdated.removeListener(onUpdated),
    };
}

async function tabIsLoading(tabId) {
    try {
        return (await browser.tabs.get(tabId)).status === "loading";
    } catch (err) {
        return false;
    }
}

// Resolves once the tab's load is over, or at the timeout. The tab is read as
// well as listened to, because the load can finish between the event that sent
// us here and the listener going up.
function waitForLoadComplete(tabId, timeoutMs) {
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            browser.tabs.onUpdated.removeListener(onUpdated);
            resolve();
        };
        const onUpdated = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === "complete") finish();
        };
        const timer = setTimeout(finish, Math.max(0, timeoutMs));
        browser.tabs.onUpdated.addListener(onUpdated);
        browser.tabs.get(tabId).then((tab) => { if (tab.status !== "loading") finish(); }, finish);
    });
}

// `noNavigationClock`, when given, is a promise that starts the no-navigation
// countdown by resolving; without it the countdown starts now. `navigate`
// acts right after arming the watcher and wants the latter.
async function waitForTabLoad(
    tabId,
    beforeTab,
    timeoutMs = LOAD_TIMEOUT_MS,
    noNavigationTimeoutMs = 1500,
    noNavigationClock = null
) {
    const beforeUrl = beforeTab?.url || "";
    let sawNavigation = false;
    let loadStarted = false;
    let sameDocumentTimer = null;
    let noNavigationTimer = null;

    return new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            browser.tabs.onUpdated.removeListener(onUpdated);
            clearTimeout(timer);
            clearTimeout(noNavigationTimer);
            clearTimeout(sameDocumentTimer);
        };

        const settle = async () => {
            if (settled) return;
            settled = true;
            cleanup();
            try {
                resolve(await browser.tabs.get(tabId));
            } catch (err) {
                reject(err);
            }
        };

        const settleIfSameDocument = () => {
            clearTimeout(sameDocumentTimer);
            sameDocumentTimer = setTimeout(settle, 500);
        };

        const onUpdated = (updatedTabId, changeInfo, tab) => {
            if (updatedTabId !== tabId) return;

            if (changeInfo.status === "loading") {
                sawNavigation = true;
                loadStarted = true;
                clearTimeout(sameDocumentTimer);
            }

            if (changeInfo.url && changeInfo.url !== beforeUrl) {
                sawNavigation = true;
                if (!loadStarted) {
                    settleIfSameDocument();
                }
            }

            if (changeInfo.status === "complete" && (sawNavigation || (tab.url || "") !== beforeUrl)) {
                settle();
            }
        };

        const timer = setTimeout(settle, timeoutMs);
        const startNoNavigationCountdown = () => {
            if (settled) return;
            noNavigationTimer = setTimeout(() => {
                if (!sawNavigation) {
                    settle();
                }
            }, noNavigationTimeoutMs);
        };
        if (noNavigationClock) noNavigationClock.then(startNoNavigationCountdown);
        else startNoNavigationCountdown();
        browser.tabs.onUpdated.addListener(onUpdated);
    });
}

