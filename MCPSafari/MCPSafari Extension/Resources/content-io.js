/**
 * Files, measurement and waiting, plus the thin delegates to the
 * MAIN-world interceptors for dialogs, console and network.
 */

(() => {
    const mcp = window.__mcpSafari;
    if (!mcp || mcp.loaded.has("io")) return;
    mcp.loaded.add("io");
    const { currentFrameId, deepQueryFirst, dragEvent, eventInit, nextRequestId, requestMainWorld, resolveElement, toolError } = mcp;

    // ─── File Attachment ─────────────────────────────────────────────

    // Files arrive a chunk per message and wait here for the action that hands
    // them to the page. A whole file in one message capped a call at 10 MB, and
    // Safari refuses an extension message over 64 MB. They wait in this isolated
    // world, where the page cannot read or change them. Each chunk becomes a Blob
    // as it arrives, and WebKit keeps Blob bytes outside the page's process, so a
    // large file does not build up in the page's memory, and the finished File
    // only refers to the pieces.
    const stagedTransfers = new Map();
    // A transfer that nothing has added to for this long is let go. The server
    // discards one it gives up on, but a server that has gone cannot.
    const STAGED_IDLE_MS = 60_000;

    // Native from Safari 18.2. The fallback is for Safari 17.
    const decodeBase64 = typeof Uint8Array.fromBase64 === "function"
        ? (text) => Uint8Array.fromBase64(text)
        : (text) => {
            const binary = atob(text);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            return bytes;
        };

    // The target is checked here, before any of the file is sent, so a call aimed
    // at the wrong element fails at once instead of after a long upload. The
    // action checks it again, since the page can change in the meantime.
    function stageFiles(params) {
        const specs = Array.isArray(params.files) ? params.files : [];
        if (specs.length === 0) throw new Error("No files provided");
        const target = resolveElement({ uid: params.uid, selector: params.selector });
        if (params.intent === "upload_file") checkFileInput(resolveFileInput(target), specs.length);

        const files = specs.map((spec) => {
            const size = Number(spec.size);
            if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid size for ${spec.name}`);
            return { name: String(spec.name), type: String(spec.type || ""), size, parts: [], received: 0 };
        });
        const transferId = nextRequestId("mcp-transfer");
        stagedTransfers.set(transferId, { files, timer: null });
        keepStaged(transferId);
        return { transferId, frameId: currentFrameId() };
    }

    function keepStaged(transferId) {
        const staged = stagedTransfers.get(transferId);
        clearTimeout(staged.timer);
        staged.timer = setTimeout(() => stagedTransfers.delete(transferId), STAGED_IDLE_MS);
    }

    function stagedTransfer(transfer) {
        const staged = transfer && stagedTransfers.get(transfer.id);
        if (staged) return staged;
        throw toolError(
            "file_transfer_lost",
            "The files being sent to this page are gone: the page reloaded or navigated while they were "
            + "being sent, or nothing arrived for a minute. Retry the call.",
            true,
            "retry"
        );
    }

    function addFileChunk(params) {
        const staged = stagedTransfer(params.transfer);
        const file = staged.files[params.file];
        if (!file) throw new Error(`No file ${params.file} in this transfer`);
        const bytes = decodeBase64(String(params.data));
        // A chunk asked for again after its reply was lost is already here.
        if (params.offset + bytes.length <= file.received) {
            keepStaged(params.transfer.id);
            return { received: file.received };
        }
        if (params.offset !== file.received) {
            throw new Error(`A chunk of ${file.name} arrived at byte ${params.offset}, after ${file.received} bytes`);
        }
        if (file.received + bytes.length > file.size) {
            throw new Error(`${file.name} is larger than the ${file.size} bytes it was announced as`);
        }
        file.parts.push(new Blob([bytes]));
        file.received += bytes.length;
        keepStaged(params.transfer.id);
        return { received: file.received };
    }

    function discardFiles(params) {
        const transferId = params.transfer && params.transfer.id;
        const staged = stagedTransfers.get(transferId);
        if (staged) {
            clearTimeout(staged.timer);
            stagedTransfers.delete(transferId);
        }
        return { discarded: Boolean(staged) };
    }

    // The action takes the files whether it succeeds or not, so a failed one
    // leaves nothing behind.
    function takeStagedFiles(params) {
        const staged = stagedTransfer(params.transfer);
        discardFiles(params);
        for (const file of staged.files) {
            if (file.received !== file.size) {
                throw new Error(`${file.name} arrived incomplete: ${file.received} of ${file.size} bytes`);
            }
        }
        return staged.files.map((file) => new File(file.parts, file.name, { type: file.type }));
    }

    function checkFileInput(input, count) {
        if (count > 1 && !input.multiple) {
            throw new Error(`Input accepts one file but ${count} were provided`);
        }
        if (input.disabled) throw new Error("File input is disabled");
    }

    function transferFor(files) {
        const dataTransfer = new DataTransfer();
        for (const file of files) dataTransfer.items.add(file);
        return dataTransfer;
    }

    function describeFiles(files) {
        return files.map((file) => file.name).join(", ");
    }

    // Accepts the input itself, a wrapper element around it, or its <label>.
    function resolveFileInput(element) {
        if (element.tagName && element.tagName.toLowerCase() === "input" && element.type === "file") {
            return element;
        }
        if (element.control && element.control.type === "file") {
            return element.control;
        }
        const nested = element.querySelector && element.querySelector('input[type="file"]');
        if (nested) return nested;

        throw new Error(
            `<${element.tagName ? element.tagName.toLowerCase() : "element"}> is not a file input and contains none. Target the <input type="file"> directly, or use drop_file for a drop zone.`
        );
    }

    function uploadFile(params) {
        const files = takeStagedFiles(params);
        const target = resolveElement({ uid: params.uid, selector: params.selector });
        const input = resolveFileInput(target);
        checkFileInput(input, files.length);

        input.files = transferFor(files).files;
        input.dispatchEvent(new Event("input", eventInit("input")));
        input.dispatchEvent(new Event("change", eventInit("change")));

        return `Attached ${describeFiles(files)} to file input`;
    }

    let dropQueue = Promise.resolve();

    // Drops share one target marker, so they run one at a time. The files are
    // taken at once rather than when the drop's turn comes, so one waiting
    // behind another drop is not let go as idle.
    function dropFile(params) {
        let files;
        try {
            files = takeStagedFiles(params);
        } catch (err) {
            return Promise.reject(err);
        }
        const run = dropQueue.then(() => dropFileNow(params, files));
        dropQueue = run.catch(() => {});
        return run;
    }

    async function dropFileNow(params, files) {
        const target = resolveElement({ uid: params.uid, selector: params.selector });
        const dropped = `Dropped ${describeFiles(files)} on <${target.tagName.toLowerCase()}>`;

        // Page listeners only see item overrides made in their own world, so
        // file-drop.js dispatches; without it the entry API stays broken.
        const marker = nextRequestId("mcp-drop");
        target.setAttribute("data-mcp-drop-target", marker);
        try {
            await requestMainWorld("drop_files", { marker, files });
            return dropped;
        } catch (err) {
            if (!String(err.message || err).endsWith("interceptor did not respond")) throw err;
            dispatchDrop(target, transferFor(files));
            return `${dropped} (page bridge unavailable; entry API not patched)`;
        } finally {
            target.removeAttribute("data-mcp-drop-target");
        }
    }

    function dispatchDrop(target, dataTransfer) {
        target.scrollIntoView({ behavior: "instant", block: "center" });
        const rect = target.getBoundingClientRect();
        const baseOpts = {
            view: window,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            dataTransfer,
        };

        for (const type of ["dragenter", "dragover", "drop"]) {
            target.dispatchEvent(dragEvent(type, baseOpts));
        }
    }

    // ─── Element rect (screenshot region) ────────────────────────────

    // captureVisibleTab only sees the viewport, so the target is scrolled
    // into view first. Scroll handlers (collapsing headers, virtualized
    // lists) run at the next rendering opportunity, so the rect is measured
    // after one frame; the timeout covers a hidden page, which never paints.
    async function elementRect(params) {
        const el = resolveElement({ uid: params.uid, selector: params.selector });
        el.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
        await new Promise((resolve) => {
            const fallback = setTimeout(resolve, 100);
            requestAnimationFrame(() => { clearTimeout(fallback); resolve(); });
        });
        const rect = el.getBoundingClientRect();
        if (!(rect.width > 0) || !(rect.height > 0)) {
            throw toolError(
                "target_not_found",
                `<${el.tagName.toLowerCase()}> has no rendered size, so there is nothing to capture`,
                false,
                "take_snapshot"
            );
        }
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    }

    // ─── Wait ────────────────────────────────────────────────────────

    async function waitFor(params) {
        const timeout = (params.timeout || 10) * 1000;
        const start = Date.now();

        if (params.seconds) {
            await new Promise((r) => setTimeout(r, params.seconds * 1000));
            return `Waited ${params.seconds} seconds`;
        }

        if (params.selector) {
            while (Date.now() - start < timeout) {
                if (deepQueryFirst(params.selector)) {
                    return `Element found: ${params.selector}`;
                }
                await new Promise((r) => setTimeout(r, 200));
            }
            throw toolError(
                "wait_timeout",
                `Timeout waiting for selector: ${params.selector}`,
                true,
                "retry"
            );
        }

        if (params.text) {
            while (Date.now() - start < timeout) {
                if (
                    document.body &&
                    document.body.innerText.includes(params.text)
                ) {
                    return `Text found: "${params.text}"`;
                }
                await new Promise((r) => setTimeout(r, 200));
            }
            throw toolError(
                "wait_timeout",
                `Timeout waiting for text: "${params.text}"`,
                true,
                "retry"
            );
        }

        return "Nothing to wait for";
    }

    // ─── Dialog Handling (delegate to interceptor) ────────────────────

    async function handleDialog(params) {
        const result = await requestMainWorld("handle_dialog", params);
        if (result.handled) {
            const action = params.action === "accept" ? "Accepted" : "Dismissed";
            const suffix = result.alreadyHandled ? " (dialog was already auto-handled)" : "";
            return `${action} ${result.type} dialog: "${result.message}"${suffix}`;
        }
        return "No pending dialog found";
    }

    // --- Page Trace (delegate to interceptor) ------------------------

    async function startTrace(params) {
        // Fixed trace id across attempts: if the interceptor processes the
        // first request late, the retry overwrites the same trace instead of
        // double-starting one.
        const request = { ...params, id: nextRequestId("trace") };
        try {
            const trace = await requestMainWorld("start_trace", request);
            return trace.id;
        } catch (err) {
            // The MAIN-world interceptor can miss a request sent right after
            // navigation, before its listener is ready. Retry once so a
            // transient startup timeout does not abort the traced action.
            if (!String(err.message || err).endsWith("interceptor did not respond")) throw err;
            await new Promise((resolve) => setTimeout(resolve, 250));
            const trace = await requestMainWorld("start_trace", request);
            return trace.id;
        }
    }

    async function stopTrace(params) {
        return await requestMainWorld("stop_trace", params, 5000);
    }

    // ─── Console Messages (delegate to interceptor) ──────────────────

    async function getConsoleMessages(params) {
        return await requestMainWorld("get_console_messages", params);
    }

    // ─── Network Requests (delegate to interceptor) ──────────────────

    async function getNetworkRequests(params) {
        return await requestMainWorld("get_network_requests", params);
    }

    Object.assign(mcp, { addFileChunk, discardFiles, dropFile, elementRect, getConsoleMessages, getNetworkRequests, handleDialog, stageFiles, startTrace, stopTrace, uploadFile, waitFor });
})();
