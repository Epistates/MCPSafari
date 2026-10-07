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

        case "back":
            const backComplete = waitForTabLoad(tabId, beforeTab);
            await browser.scripting.executeScript({
                target: { tabId },
                func: () => history.back(),
            });
            tab = await backComplete;
            message = "Navigated back to";
            break;

        case "forward":
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
    return `${message} ${redactUrlSecrets(tab.url)} (${tab.title || ""})`
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

