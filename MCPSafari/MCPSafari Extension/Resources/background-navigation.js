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
    // The page's own title is not for a site that has not been granted.
    const title = siteIsGranted(tab.url)
        ? `(${tab.title || ""})`
        : "(title withheld: MCPSafari has not been granted access to this site)";
    return `${message} ${redactUrlSecrets(tab.url)} ${title}`;
}

async function waitForTabLoad(tabId, beforeTab, timeoutMs = 15000, noNavigationTimeoutMs = 1500) {
    const beforeUrl = beforeTab?.url || "";
    let sawNavigation = false;
    let loadStarted = false;
    let sameDocumentTimer = null;

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
        const noNavigationTimer = setTimeout(() => {
            if (!sawNavigation) {
                settle();
            }
        }, noNavigationTimeoutMs);
        browser.tabs.onUpdated.addListener(onUpdated);
    });
}

