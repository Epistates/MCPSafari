function renderConnections(ports) {
    const container = document.getElementById("connections");
    container.innerHTML = "";

    if (!ports || ports.length === 0) {
        container.innerHTML = '<div class="empty">Scanning for servers…</div>';
        return;
    }

    ports.sort((a, b) => a.port - b.port);

    for (const { port, state, manual } of ports) {
        const row = document.createElement("div");
        row.className = `conn-row ${state}`;

        const label = manual ? "" : '<span class="auto-badge">auto</span>';

        row.innerHTML = `
            <span class="dot"></span>
            <span class="conn-port">${port}</span>
            ${label}
            <span class="conn-state">${state}</span>
            <button class="btn-icon btn-reconnect" data-port="${port}" title="Reconnect">&#x21bb;</button>
            <button class="btn-icon btn-remove" data-port="${port}" title="Remove">&times;</button>
        `;
        container.appendChild(row);
    }

    container.querySelectorAll(".btn-reconnect").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const port = parseInt(btn.dataset.port, 10);
            await browser.runtime.sendMessage({ type: "reconnect", port });
            await new Promise((r) => setTimeout(r, 1000));
            refresh();
        });
    });

    container.querySelectorAll(".btn-remove").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const port = parseInt(btn.dataset.port, 10);
            await browser.runtime.sendMessage({ type: "removePort", port });
            refresh();
        });
    });
}

// Safari grants website access per site, and says so nowhere the user is
// looking. Saying it here means someone can tell "the agent cannot reach this
// page" from "the server is not connected", which are the two failures that
// otherwise look identical from the outside.
function siteAccessMarkup(access) {
    if (!access || !access.origin) return "";

    const host = access.origin.replace(/^https?:\/\//, "");
    const state = access.allowed
        ? '<span class="site-state allowed">Allowed</span>'
        : access.pending
            ? '<span class="site-state">Asking…</span>'
            : '<span class="site-state blocked">No access</span>';

    const hint = access.allowed
        ? ""
        : access.pending
            ? '<p class="site-hint">Safari is asking whether to allow this site. Its dialog can '
              + "open behind another window.</p>"
            : '<p class="site-hint">Allow this site from Safari Settings &gt; Extensions to let '
              + "MCPSafari read it. Everything runs on this Mac.</p>";

    return `<div class="site-row"><span class="site-host">${escapeHtml(host)}</span>${state}</div>${hint}`;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
}

async function refreshSite() {
    try {
        const access = await browser.runtime.sendMessage({ type: "tabAccess" });
        document.getElementById("site").innerHTML = siteAccessMarkup(access);
    } catch (_) { /* extension may not be ready */ }
}

async function refresh() {
    try {
        const response = await browser.runtime.sendMessage({ type: "getStatus" });
        if (response) {
            renderConnections(response.ports);
        }
    } catch (_) { /* extension may not be ready */ }
}

async function refreshConnections() {
    try {
        const response = await browser.runtime.sendMessage({ type: "refreshConnections" });
        if (response) renderConnections(response.ports);
    } catch (_) { /* extension may not be ready */ }
}

document.addEventListener("DOMContentLoaded", async () => {
    document.getElementById("version").textContent = `v${browser.runtime.getManifest().version}`;
    // Not awaited alongside the connection refresh: this one can sit for a
    // couple of seconds behind Safari's dialog, and the ports should paint
    // straight away rather than waiting on it.
    refreshSite();
    await refreshConnections();

    const refreshTimer = setInterval(refresh, 1000);
    window.addEventListener("unload", () => clearInterval(refreshTimer));

    document.getElementById("add-btn").addEventListener("click", async () => {
        const input = document.getElementById("port-input");
        const port = parseInt(input.value, 10);
        if (port >= 1024 && port <= 65535) {
            await browser.runtime.sendMessage({ type: "addPort", port });
            input.value = "";
            await new Promise((r) => setTimeout(r, 500));
            refresh();
        }
    });
});
