"use strict";

// `clear_cookies`: removing a site's cookies in the profile this instance runs in.

// ─── Cookies ─────────────────────────────────────────────────────────

// Page JavaScript cannot delete an HttpOnly cookie, so an identity provider that
// remembers the last account in one keeps offering it after the app's own
// logout. The cookies API reaches HttpOnly and Secure cookies alike, and each
// Safari profile runs its own instance of this extension with that profile's
// cookie store. Only a count is returned, never a cookie's name or value.
//
// The cookies API shows only the cookies whose own domain the extension has host
// access to, so cookies it cannot see are left in place, and the result says so
// whenever that may have happened.

// The server checks the domain's shape before it is sent; this is the same rule,
// so a request that bypassed it cannot widen the match to every site. One label
// alone is refused, except `localhost`, so `com` cannot clear everything under it.
const COOKIE_DOMAIN =
    /^(?=.{1,253}$)(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/;

const COOKIES_NOT_GRANTED_HINT =
    "MCPSafari has not reached a page on this domain in this Safari profile, so cookies set for "
    + "it may have been out of sight and left in place: Safari shows the extension only the cookies "
    + "of sites it can access. If the user has not allowed the site, they can do so from the "
    + "MCPSafari button in Safari's toolbar on a page of that site, then retry.";

// A public suffix is shared by unrelated sites: `co.uk` covers every British
// company's site and `github.io` every GitHub Pages site, so clearing one would
// sign the user out of all of them. The list's private section counts too, the
// suffixes companies such as GitHub and Amazon give their customers.
// `localhost` is the one name allowed, though the list's default rule makes it a
// suffix. The list is tldts, loaded before this file; the server doesn't keep a
// copy, so this is the only place it's checked.
function isPublicSuffix(domain) {
    return domain !== "localhost"
        && tldts.getPublicSuffix(domain, { allowPrivateDomains: true, extractHostname: false }) === domain;
}

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

// Safari grants a site together with its subdomains, so a site reached at
// `idp.example.com` covers `login.idp.example.com`. The reverse does not hold: a
// reached `login.idp.example.com` says nothing about cookies set for
// `.idp.example.com`, which the cookies API shows only with that domain granted.
function domainIsGranted(domain) {
    for (const origin of grantedOrigins) {
        let host;
        try {
            host = new URL(origin).hostname;
        } catch {
            continue;
        }
        if (domain === host || domain.endsWith(`.${host}`)) return true;
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
    if (isPublicSuffix(domain)) {
        const error = new Error(
            `${domain} is a public suffix that unrelated sites share, so clearing it would remove all of their `
            + `cookies. Name the site itself, such as example.${domain}.`
        );
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
        throw cookiesNotRespondingError(domain);
    }

    // `getAll({domain})` already means "this domain or a subdomain of it", but a
    // cookie set for a parent (`.example.com` when asked for `idp.example.com`)
    // is not the caller's to remove, so the match is held to that here too.
    const matching = (Array.isArray(cookies) ? cookies : []).filter((cookie) => cookieInDomain(cookie, domain));
    // Each removal stands alone, so one Safari refuses doesn't lose the count of
    // the ones that went.
    const outcomes = await Promise.allSettled(matching.map((cookie) => browser.cookies.remove(cookieRemoval(cookie))));
    // `remove` resolves to null when there was nothing to remove.
    const removed = outcomes.filter((outcome) => outcome.status === "fulfilled" && outcome.value !== null).length;
    const failures = outcomes.filter((outcome) => outcome.status === "rejected");
    // When none went, Safari's own reason is the answer.
    if (failures.length > 0 && removed === 0) throw failures[0].reason;

    const result = { removed, ...(failures.length > 0 ? { failed: failures.length } : {}) };
    // Said even when some were removed: those may be a reached subdomain's, with
    // the domain's own cookies still in place.
    if (!domainIsGranted(domain)) {
        return { ...result, access: "not_granted", accessHint: COOKIES_NOT_GRANTED_HINT };
    }
    return result;
}

// The lookup has no tab and no page, so a slow answer is Safari's, not a
// permission question about a tab. Nothing has been removed at this point.
function cookiesNotRespondingError(domain) {
    const error = new Error(
        `Safari didn't answer the cookie lookup for ${domain} within ${PERMISSION_DEADLINE_MS / 1000} seconds, `
        + "so nothing was removed. Retry the call."
    );
    error.code = "cookies_not_responding";
    error.retryable = true;
    error.recoveryAction = "retry";
    return error;
}
