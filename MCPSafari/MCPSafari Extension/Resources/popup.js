function renderConnections(ports) {
    const container = document.getElementById("connections");
    container.innerHTML = "";

    if (!ports || ports.length === 0) {
        container.innerHTML = '<div class="empty">No connections</div>';
        return;
    }

    for (const { port, state } of ports) {
        const row = document.createElement("div");
        row.className = `conn-row ${state}`;

        row.innerHTML = `
            <span class="dot"></span>
            <span class="conn-port">${port}</span>
            <span class="conn-state">${state}</span>
            <button class="btn-remove" data-port="${port}">&times;</button>
        `;
        container.appendChild(row);
    }

    // Bind remove buttons
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

    // Add port
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

    // Reconnect all
    document.getElementById("reconnect-all-btn").addEventListener("click", async () => {
        await browser.runtime.sendMessage({ type: "reconnect" });
        await new Promise((r) => setTimeout(r, 1000));
        refresh();
    });
});
