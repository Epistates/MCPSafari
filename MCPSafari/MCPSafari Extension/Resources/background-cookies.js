"use strict";

// `clear_cookies`: removing a site's cookies in the profile this instance runs in.

// ─── Cookies ─────────────────────────────────────────────────────────

// Page JavaScript cannot delete an HttpOnly cookie, so an identity provider that
// remembers the last account in one keeps offering it after the app's own
// logout. The cookies API reaches HttpOnly and Secure cookies alike, and each
// Safari profile runs its own instance of this extension with that profile's
// cookie store. Only a count is returned, never a cookie's name or value.
//
// The cookies API sees only sites the extension has host access to, so a site
// without it reads as having no cookies, and the result says so rather than
// reporting a clean `removed: 0`.

// The server checks the domain before it is sent; this is the same rule, so a
// request that bypassed it cannot widen the match to every site. One label alone
// is refused, except `localhost`, so `com` cannot clear everything under it.
const COOKIE_DOMAIN =
    /^(?=.{1,253}$)(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;

const COOKIES_NOT_GRANTED_HINT =
    "No cookies were found, and MCPSafari has not reached a page on this domain in this "
    + "Safari profile. The extension cannot see the cookies of a site it has no access to, "
    + "so if the user has not granted it, they can do so from the MCPSafari button in Safari's "
    + "toolbar on a page of that site, then retry.";

// A cookie's domain may carry a leading dot, which marks it as sent to subdomains
// too and is not part of the host.
function cookieHost(cookie) {
    return String(cookie.domain).replace(/^\./, "").toLowerCase();
}

function cookieInDomain(cookie, domain) {
    const host = cookieHost(cookie);
    return host === domain || host.endsWith(`.${domain}`);
}

// `cookies.remove` names a cookie by a URL it would be sent to, plus its name.
// A Secure cookie is only sent over https, and the path must be the cookie's own.
function cookieRemoval(cookie) {
    const removal = {
        url: `http${cookie.secure ? "s" : ""}://${cookieHost(cookie)}${cookie.path || "/"}`,
        name: cookie.name,
    };
    if (cookie.storeId) removal.storeId = cookie.storeId;
    if (cookie.partitionKey) removal.partitionKey = cookie.partitionKey;
    return removal;
}

function domainIsGranted(domain) {
    for (const origin of grantedOrigins) {
        let host;
        try {
            host = new URL(origin).hostname;
        } catch {
            continue;
        }
        if (host === domain || host.endsWith(`.${domain}`)) return true;
    }
    return false;
}

// Safari's default cookie store is not the profile's. Measured on Safari 26 in a
// second profile, `getAll` without a `storeId` read an empty store that held no
// tab, while the profile's cookies sat in another. The profile's store is the one
// holding its tabs, which are the only tabs this instance can see.
async function profileCookieStoreId() {
    const [stores, tabs] = await Promise.all([browser.cookies.getAllCookieStores(), browser.tabs.query({})]);
    const ours = new Set(tabs.map((tab) => tab.id));
    const store = stores.find((candidate) => !candidate.incognito
        && (candidate.tabIds || []).some((tabId) => ours.has(tabId)));
    if (!store) {
        const error = new Error(
            "No cookie store holds a tab of this Safari profile, so there is nothing to clear it in. "
            + "Open a tab in the profile with tabs_create, then retry."
        );
        error.code = "no_cookie_store";
        error.recoveryAction = "inspect_error";
        throw error;
    }
    return store.id;
}

async function handleClearCookies(params) {
    const domain = typeof params.domain === "string" ? params.domain.toLowerCase() : "";
    if (!COOKIE_DOMAIN.test(domain)) {
        const error = new Error("domain must be a bare hostname such as idp.example.com");
        error.code = "invalid_input";
        error.recoveryAction = "fix_input";
        throw error;
    }

    let cookies;
    try {
        cookies = await withDeadline(
            profileCookieStoreId().then((storeId) => browser.cookies.getAll({ domain, storeId })),
            PERMISSION_DEADLINE_MS
        );
    } catch (err) {
        if (!(err instanceof DeadlineExceeded)) throw err;
        throw permissionRequiredError(`https://${domain}`, true);
    }

    // `getAll({domain})` already means "this domain or a subdomain of it", but a
    // cookie set for a parent (`.example.com` when asked for `idp.example.com`)
    // is not the caller's to remove, so the match is held to that here too.
    const matching = (Array.isArray(cookies) ? cookies : []).filter((cookie) => cookieInDomain(cookie, domain));
    const results = await Promise.all(matching.map((cookie) => browser.cookies.remove(cookieRemoval(cookie))));
    // Resolves to null when there was nothing to remove.
    const removed = results.filter((result) => result !== null).length;

    if (removed === 0 && !domainIsGranted(domain)) {
        return { removed, access: "not_granted", accessHint: COOKIES_NOT_GRANTED_HINT };
    }
    return { removed };
}
