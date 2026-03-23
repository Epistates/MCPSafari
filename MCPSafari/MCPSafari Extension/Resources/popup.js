function updateStatus(state, wsUrl) {
    const statusEl = document.getElementById("status");
    const textEl = document.getElementById("status-text");
    const urlEl = document.getElementById("ws-url");

    statusEl.className = `status ${state}`;

    const labels = {
        connected: "Connected",
        connecting: "Connecting...",
        disconnected: "Disconnected",
    };
    textEl.textContent = labels[state] || state;
    urlEl.textContent = wsUrl || "";
}

document.addEventListener("DOMContentLoaded", async () => {
    // Query background script for status
    try {
        const response = await browser.runtime.sendMessage({ type: "getStatus" });
        if (response) {
            updateStatus(response.connectionState, response.wsUrl);
        }
    } catch (_) { /* extension may not be ready */ }

    // Reconnect button
    document.getElementById("reconnect-btn").addEventListener("click", async () => {
        updateStatus("connecting", "");
        try {
            await browser.runtime.sendMessage({ type: "reconnect" });
            await new Promise((r) => setTimeout(r, 1000));
            const response = await browser.runtime.sendMessage({ type: "getStatus" });
            if (response) {
                updateStatus(response.connectionState, response.wsUrl);
            }
        } catch (_) { /* ignore */ }
    });
});
