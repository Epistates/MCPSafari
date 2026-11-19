function renderConnections(ports) {
    const container = document.getElementById("connections");
    container.innerHTML = "";

    if (!ports || ports.length === 0) {
        container.innerHTML = '<div class="empty">Scanning for servers…</div>';
        return;
    }

    ports.sort((a, b) => a.port - b.port);

    for (const status of ports) {
        const row = document.createElement("div");
        row.className = `conn-row ${status.state}`;
        // A property, not markup, so a server's strings are text here as is.
        row.title = connectionTooltip(status);
        row.innerHTML = connectionRowMarkup(status);
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

// Several sessions can each run a server, and a port number says nothing about
// which is which. A server that has said who it is shows its name where the
// state was, and under it the folder it was started in; the state moves to the
// tooltip, with the MCP client behind it. An older server, or a port that is not
// connected, shows its state as before. The name and folder come from the
// server, so they are escaped like any other text that did not start in this
// file.
function connectionRowMarkup({ port, state, manual, label, folder }) {
    const auto = manual ? "" : '<span class="auto-badge">auto</span>';
    const named = isNamed(port, label);
    const described = named
        ? `<span class="conn-name">${escapeHtml(label)}</span>`
        : `<span class="conn-state">${state}</span>`;
    // Last, so that it wraps onto a line of its own (see popup.css).
    const where = named && folder ? `<span class="conn-folder">${escapeHtml(shortFolder(folder))}</span>` : "";

    return `
        <span class="dot"></span>
        <span class="conn-port">${port}</span>
        ${auto}
        ${described}
        <button class="btn-icon btn-reconnect" data-port="${port}" title="Reconnect">&#x21bb;</button>
        <button class="btn-icon btn-remove" data-port="${port}" title="Remove">&times;</button>
        ${where}
    `;
}

/**
 * The row's tooltip, as plain text: everything the row may have cut short, then
 * the state and the MCP client behind the server, such as "claude-code 2.1.0".
 */
function connectionTooltip({ port, state, label, folder, client }) {
    const named = isNamed(port, label);
    const who = client && client.name ? [client.name, client.version].filter(Boolean).join(" ") : null;
    return [
        named ? label : null,
        named && folder ? shortFolder(folder) : null,
        [state, who].filter(Boolean).join(" · "),
    ].filter(Boolean).join("\n");
}

// The background names a connection that has said nothing by its port, which
// the row already shows.
function isNamed(port, label) {
    return Boolean(label) && label !== `port ${port}`;
}

// A home folder as "~". /Users/Shared is everyone's, so it is left as it is.
function shortFolder(folder) {
    return String(folder).replace(/^\/Users\/(?!Shared(?:\/|$))[^/]+(?=\/|$)/, "~");
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
              + "MCPSafari read it. Results are shared with your MCP client.</p>";

    return `<div class="site-row"><span class="site-host">${escapeHtml(host)}</span>${state}</div>${hint}`;
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
}

let siteRefreshPending = false;

async function refreshSite() {
    if (siteRefreshPending) return;
    siteRefreshPending = true;
    try {
        const access = await browser.runtime.sendMessage({ type: "tabAccess" });
        document.getElementById("site").innerHTML = siteAccessMarkup(access);
    } catch (_) {
        document.getElementById("site").textContent = "Could not check website access. Reopen the popup to try again.";
    } finally {
        siteRefreshPending = false;
    }
}

let connectionRefreshPending = false;
async function refresh() {
    if (connectionRefreshPending) return;
    connectionRefreshPending = true;
    try {
        const response = await browser.runtime.sendMessage({ type: "getStatus" });
        if (response) {
            renderConnections(response.ports);
        }
    } catch (_) {
        document.getElementById("connections").textContent = "Could not reach the extension. Reopen the popup to try again.";
    } finally {
        connectionRefreshPending = false;
    }
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

    const refreshTimer = setInterval(() => { refresh(); refreshSite(); }, 1000);
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
