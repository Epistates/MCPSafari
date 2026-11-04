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

    // The content script marks the target wherever it found it, which includes
    // inside an open shadow root, and `document.querySelector` does not look
    // there. Each open root is searched in turn, so a drop zone in a web
    // component is found like any other.
    function findMarked(selector, root) {
        const found = root.querySelector(selector);
        if (found) return found;
        for (const element of root.querySelectorAll("*")) {
            if (!element.shadowRoot) continue;
            const inner = findMarked(selector, element.shadowRoot);
            if (inner) return inner;
        }
        return null;
    }

    function dropFiles(params) {
        const target = findMarked(`[data-mcp-drop-target="${params.marker}"]`, document);
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
        // Composed, as a real drop is: without it the events stop at the edge
        // of a shadow root, and a listener on its host never sees the drop.
        // This file cannot read the content scripts' event helper; all three
        // events bubble and can be cancelled, so the flags are written out.
        const baseOpts = {
            bubbles: true,
            cancelable: true,
            composed: true,
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
