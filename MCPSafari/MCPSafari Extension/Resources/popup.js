function renderConnections(ports) {
    const container = document.getElementById("connections");
    container.innerHTML = "";

    if (!ports || ports.length === 0) {
        container.innerHTML = '<div class="empty">Scanning for servers…</div>';
        return;
    }

    // Sort: connected first, then by port number
    ports.sort((a, b) => {
        if (a.state === "connected" && b.state !== "connected") return -1;
        if (b.state === "connected" && a.state !== "connected") return 1;
        return a.port - b.port;
    });

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

async function refresh() {
    try {
        const response = await browser.runtime.sendMessage({ type: "getStatus" });
        if (response) {
            renderConnections(response.ports);
        }
    } catch (_) { /* extension may not be ready */ }
}

document.addEventListener("DOMContentLoaded", async () => {
    await refresh();

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
