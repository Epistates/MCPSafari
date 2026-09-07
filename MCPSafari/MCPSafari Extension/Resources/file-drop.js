/**
 * MCPSafari File Drop
 *
 * Dispatches drop_file drag events from the page's world. Page listeners see
 * their own wrappers for a DataTransfer built in the content script's
 * isolated world, so item fixes made there never reach them. Safari mints a
 * FileSystemFileEntry for an in-memory File whose file() rejects with
 * NotFoundError, so each item's webkitGetAsEntry is replaced with an entry
 * that resolves the File from getAsFile().
 *
 * Injected at document_start before page scripts run.
 */
(() => {
    if (window.__mcpFileDropLoaded) return;
    window.__mcpFileDropLoaded = true;

    function readableEntry(item) {
        if (typeof item.webkitGetAsEntry !== "function") return null;
        const entry = item.webkitGetAsEntry();
        if (!entry || !entry.isFile) return entry;
        const file = item.getAsFile();
        return {
            isFile: true,
            isDirectory: false,
            name: entry.name,
            fullPath: entry.fullPath,
            filesystem: entry.filesystem,
            file(onSuccess) {
                onSuccess(file);
            },
            getParent(onSuccess) {
                onSuccess(entry.filesystem.root);
            },
        };
    }

    function dropFiles(params) {
        const target = document.querySelector(`[data-mcp-drop-target="${params.marker}"]`);
        if (!target) throw new Error("Drop target not found in page");

        const dataTransfer = new DataTransfer();
        for (const file of params.files) dataTransfer.items.add(file);
        for (const item of dataTransfer.items) {
            try {
                const entry = readableEntry(item);
                Object.defineProperty(item, "webkitGetAsEntry", { configurable: true, value: () => entry });
            } catch {
                // Leave the native entry in place; the drop still carries the files.
            }
        }

        target.scrollIntoView({ behavior: "instant", block: "center" });
        const rect = target.getBoundingClientRect();
        const baseOpts = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            dataTransfer,
        };
        for (const type of ["dragenter", "dragover", "drop"]) {
            target.dispatchEvent(new DragEvent(type, baseOpts));
        }
        return { dropped: params.files.length };
    }

    window.addEventListener("message", (event) => {
        const message = event.data;
        if (event.source !== window || message?.source !== "MCPSafariContent") return;
        if (message.type !== "drop_files") return;

        let reply;
        try {
            reply = { data: dropFiles(message.params || {}) };
        } catch (error) {
            reply = { error: error.message };
        }
        window.postMessage({ source: "MCPSafariPage", id: message.id, ...reply }, "*");
    });
})();
