/**
 * Files, measurement and waiting, plus the thin delegates to the
 * MAIN-world interceptors for dialogs, console and network.
 */

(() => {
    const mcp = window.__mcpSafari;
    if (!mcp || mcp.loaded.has("io")) return;
    mcp.loaded.add("io");
    const { deepQueryFirst, nextRequestId, requestMainWorld, resolveElement, toolError } = mcp;

    // ─── File Attachment ─────────────────────────────────────────────

    function buildFiles(params) {
        const specs = params.files || [];
        if (specs.length === 0) throw new Error("No files provided");

        return specs.map((spec) => {
            const binary = atob(spec.data);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) {
                bytes[i] = binary.charCodeAt(i);
            }
            return new File([bytes], spec.name, { type: spec.type });
        });
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
        const target = resolveElement({ uid: params.uid, selector: params.selector });
        const input = resolveFileInput(target);
        const files = buildFiles(params);

        if (files.length > 1 && !input.multiple) {
            throw new Error(`Input accepts one file but ${files.length} were provided`);
        }
        if (input.disabled) throw new Error("File input is disabled");

        input.files = transferFor(files).files;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));

        return `Attached ${describeFiles(files)} to file input`;
    }

    let dropQueue = Promise.resolve();

    // Drops share one target marker, so they run one at a time.
    function dropFile(params) {
        const run = dropQueue.then(() => dropFileNow(params));
        dropQueue = run.catch(() => {});
        return run;
    }

    async function dropFileNow(params) {
        const target = resolveElement({ uid: params.uid, selector: params.selector });
        const files = buildFiles(params);
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

    Object.assign(mcp, { dropFile, elementRect, getConsoleMessages, getNetworkRequests, handleDialog, startTrace, stopTrace, uploadFile, waitFor });
})();
