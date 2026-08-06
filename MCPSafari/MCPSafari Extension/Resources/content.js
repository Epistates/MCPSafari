/**
 * MCPSafari Content Script
 *
 * Injected into all pages. Handles DOM manipulation, element finding,
 * accessibility snapshots, and user interaction simulation.
 */

(() => {
    // Prevent double-injection
    if (window.__mcpSafariContentLoaded) return;
    window.__mcpSafariContentLoaded = true;

    // UID counter for element references
    let uidCounter = 0;
    const uidMap = new WeakMap();
    const reverseUidMap = new Map();
    let bridgeRequestCounter = 0;

    function toolError(code, message, retryable, recoveryAction) {
        const error = new Error(message);
        error.code = code;
        error.retryable = retryable;
        error.recoveryAction = recoveryAction;
        return error;
    }

    // Escapes a value for use inside a quoted CSS attribute selector.
    function escapeCssString(value) {
        if (window.CSS && typeof window.CSS.escape === "function") {
            return window.CSS.escape(value);
        }
        return String(value).replace(/["\\]/g, "\\$&");
    }

    function getUid(element) {
        if (uidMap.has(element)) return uidMap.get(element);
        const uid = `e${++uidCounter}`;
        uidMap.set(element, uid);
        reverseUidMap.set(uid, new WeakRef(element));
        return uid;
    }

    function getElementByUid(uid) {
        const ref = reverseUidMap.get(uid);
        return ref ? ref.deref() : null;
    }

    function requestMainWorld(type, params = {}, timeoutMs = 3000) {
        return new Promise((resolve, reject) => {
            const id = `mcp-${Date.now()}-${++bridgeRequestCounter}`;
            const timer = setTimeout(() => {
                window.removeEventListener("message", onMessage);
                reject(new Error(`${type} interceptor did not respond`));
            }, timeoutMs);

            function onMessage(event) {
                const message = event.data;
                if (event.source !== window || message?.source !== "MCPSafariPage") return;
                if (message.id !== id) return;
                clearTimeout(timer);
                window.removeEventListener("message", onMessage);
                if (message.error) {
                    reject(new Error(message.error));
                } else {
                    resolve(message.data);
                }
            }

            window.addEventListener("message", onMessage);
            window.postMessage({
                source: "MCPSafariContent",
                id,
                type,
                params,
            }, "*");
        });
    }

    // ─── Message Handler ─────────────────────────────────────────────

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // Only handle messages meant for content scripts
        if (!message || !message.action) return false;

        handleAction(message.action, message.params || {})
            .then((data) => sendResponse({ data, error: null }))
            .catch((err) => sendResponse({
                data: null,
                error: String(err.message || err),
                errorCode: typeof err.code === "string" ? err.code : "extension_error",
                retryable: err.retryable === true,
                recoveryAction: typeof err.recoveryAction === "string"
                    ? err.recoveryAction
                    : "inspect_error",
            }));

        return true; // async response
    });

    async function handleAction(action, params) {
        switch (action) {
            case "read_page":
                return readPage(params);
            case "get_page_text":
                return getPageText();
            case "snapshot":
                return takeSnapshot();
            case "find":
                return findElements(params);
            case "click":
                return clickElement(params);
            case "type_text":
                return typeText(params);
            case "prepare_native_input":
                return prepareNativeInput(params);
            case "form_input":
                return formInput(params);
            case "select_option":
                return selectOption(params);
            case "scroll":
                return scrollPage(params);
            case "press_key":
                return pressKey(params);
            case "hover":
                return hoverElement(params);
            case "drag":
                return dragElement(params);
            case "native_pointer_points":
                return nativePointerPoints(params);
            case "prepare_native_key":
                return prepareNativeKey(params);
            case "upload_file":
                return uploadFile(params);
            case "drop_file":
                return dropFile(params);
            case "wait":
                return waitFor(params);
            case "start_trace":
                return startTrace(params);
            case "stop_trace":
                return stopTrace(params);
            case "handle_dialog":
                return handleDialog(params);
            case "get_console_messages":
                return getConsoleMessages(params);
            case "get_network_requests":
                return getNetworkRequests(params);
            default:
                throw new Error(`Unknown content action: ${action}`);
        }
    }

    // ─── Page Reading ────────────────────────────────────────────────

    function readPage(params) {
        const format = params.format || "text";
        switch (format) {
            case "html":
                return document.documentElement.outerHTML;
            case "text":
                return document.body ? document.body.innerText : "";
            case "snapshot":
                return takeSnapshot();
            default:
                throw new Error(`Unknown format: ${format}. Use 'text', 'html', or 'snapshot'.`);
        }
    }

    function getPageText() {
        return document.body ? document.body.innerText : "";
    }

    // ─── Accessibility Snapshot ──────────────────────────────────────

    const MAX_TREE_DEPTH = 30;

    function takeSnapshot() {
        const root = document.body || document.documentElement;
        return buildTree(root, 0);
    }

    function buildTree(element, depth) {
        if (depth > MAX_TREE_DEPTH) return null;
        if (!isVisible(element)) return null;

        const role = getRole(element);
        const name = getAccessibleName(element);
        const uid = getUid(element);
        const tag = element.tagName ? element.tagName.toLowerCase() : "";

        const node = { uid, tag, role };

        if (name) node.name = name;

        // Value for inputs. Secrets report their presence, not their contents,
        // so a snapshot of a filled login or payment form is safe to hand to a model.
        if (element.value !== undefined && element.value !== "") {
            node.value = isSensitiveInput(element) ? REDACTED : String(element.value);
        }

        // States
        if (element.checked) node.checked = true;
        if (element.disabled) node.disabled = true;
        if (element.selected) node.selected = true;
        if (element.getAttribute("aria-expanded") !== null) {
            node.expanded = element.getAttribute("aria-expanded") === "true";
        }

        // Href for links
        if (tag === "a" && element.href) {
            node.href = element.href;
        }

        // Children
        const children = [];
        for (const child of element.children) {
            const childNode = buildTree(child, depth + 1);
            if (childNode) children.push(childNode);
        }

        // Leaf nodes report their whole text content. Nodes that also have
        // element children report their own direct text nodes, so mixed
        // content such as <button><span>9</span>All</button> keeps "All".
        const rawText = children.length === 0
            ? element.textContent
            : ownTextContent(element);
        if (rawText) {
            const text = rawText.trim();
            if (text && text.length <= 500) {
                node.text = text;
            } else if (text) {
                node.text = text.substring(0, 497) + "...";
            }
        }

        if (children.length > 0) node.children = children;

        return node;
    }

    // Text of an element's direct text-node children only, in document order.
    function ownTextContent(element) {
        let text = "";
        for (const child of element.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) text += child.textContent;
        }
        return text;
    }

    function isVisible(element) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return false;
        if (element.getAttribute("aria-hidden") === "true") return false;
        if (element.hidden) return false;

        const style = window.getComputedStyle(element);
        if (style.display === "none") return false;
        if (style.visibility === "hidden") return false;
        if (parseFloat(style.opacity) === 0) return false;

        return true;
    }

    function getRole(element) {
        // Explicit ARIA role
        const ariaRole = element.getAttribute("role");
        if (ariaRole) return ariaRole;

        // Implicit roles by tag
        const tag = element.tagName ? element.tagName.toLowerCase() : "";
        if (tag === "input") return getInputRole(element);

        const implicitRoles = {
            a: "link",
            button: "button",
            select: "combobox",
            textarea: "textbox",
            img: "img",
            h1: "heading",
            h2: "heading",
            h3: "heading",
            h4: "heading",
            h5: "heading",
            h6: "heading",
            nav: "navigation",
            main: "main",
            aside: "complementary",
            footer: "contentinfo",
            header: "banner",
            form: "form",
            table: "table",
            ul: "list",
            ol: "list",
            li: "listitem",
            dialog: "dialog",
            details: "group",
            summary: "button",
        };

        return implicitRoles[tag] || null;
    }

    // Inputs whose contents must never reach a snapshot. Covers the explicit
    // password type plus the autocomplete tokens browsers use for secrets.
    const REDACTED = "[redacted]";
    const SENSITIVE_AUTOCOMPLETE = new Set([
        "current-password",
        "new-password",
        "one-time-code",
        "cc-number",
        "cc-csc",
        "cc-exp",
        "cc-exp-month",
        "cc-exp-year",
    ]);

    function isSensitiveInput(element) {
        const tag = element.tagName ? element.tagName.toLowerCase() : "";
        if (tag !== "input") return false;
        if ((element.type || "").toLowerCase() === "password") return true;

        const autocomplete = element.getAttribute("autocomplete");
        if (!autocomplete) return false;
        return autocomplete
            .toLowerCase()
            .split(/\s+/)
            .some((token) => SENSITIVE_AUTOCOMPLETE.has(token));
    }

    function getInputRole(element) {
        const type = (element.type || "text").toLowerCase();
        const inputRoles = {
            text: "textbox",
            email: "textbox",
            password: "textbox",
            search: "searchbox",
            tel: "textbox",
            url: "textbox",
            number: "spinbutton",
            range: "slider",
            checkbox: "checkbox",
            radio: "radio",
            button: "button",
            submit: "button",
            reset: "button",
        };
        return inputRoles[type] || "textbox";
    }

    function getAccessibleName(element) {
        // aria-label
        const ariaLabel = element.getAttribute("aria-label");
        if (ariaLabel) return ariaLabel;

        // aria-labelledby takes a space-separated list of ids, joined in order.
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
            const labelText = labelledBy
                .split(/\s+/)
                .filter(Boolean)
                .map((id) => document.getElementById(id))
                .filter(Boolean)
                .map((labelEl) => labelEl.textContent.trim())
                .filter(Boolean)
                .join(" ");
            if (labelText) return labelText;
        }

        // Label element for inputs. `labels` covers labelable controls directly;
        // the selector fallback must escape the id, because a raw id containing
        // a quote builds a malformed selector that throws and fails the snapshot.
        if (element.labels && element.labels.length > 0) {
            const labelText = element.labels[0].textContent.trim();
            if (labelText) return labelText;
        }
        if (element.id) {
            const label = document.querySelector(`label[for="${escapeCssString(element.id)}"]`);
            if (label) return label.textContent.trim();
        }

        // Alt text for images
        if (element.alt) return element.alt;

        // Title attribute
        if (element.title) return element.title;

        // Placeholder for inputs
        if (element.placeholder) return element.placeholder;

        return null;
    }

    // ─── Element Finding ─────────────────────────────────────────────

    // One cap for every match strategy, so a broad selector cannot return an
    // unbounded result set and swamp the caller's context.
    const MAX_FIND_RESULTS = 50;

    function findElements(params) {
        if (!params.selector && !params.text && !params.role) {
            throw toolError(
                "invalid_input",
                "find requires selector, text, or role",
                false,
                "fix_input"
            );
        }

        const results = [];

        if (params.selector) {
            const elements = document.querySelectorAll(params.selector);
            for (const el of elements) {
                if (results.length >= MAX_FIND_RESULTS) break;
                results.push(describeElement(el));
            }
        }

        if (params.text) {
            const needle = params.text.toLowerCase();
            // Also match the accessible name, so an icon button labelled only
            // by aria-label is reachable by the name snapshots report for it.
            const matches = (node) =>
                node.textContent?.toLowerCase().includes(needle) ||
                getAccessibleName(node)?.toLowerCase().includes(needle);
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_ELEMENT,
                {
                    acceptNode: (node) =>
                        matches(node) && isVisible(node)
                            ? NodeFilter.FILTER_ACCEPT
                            : NodeFilter.FILTER_SKIP,
                }
            );
            let node;
            while ((node = walker.nextNode()) && results.length < MAX_FIND_RESULTS) {
                // Only include leaf-ish elements (avoid returning <body> etc.)
                if (
                    node.children.length === 0 ||
                    node.textContent.trim().length < 200
                ) {
                    results.push(describeElement(node));
                }
            }
        }

        if (params.role) {
            const allElements = document.querySelectorAll("*");
            for (const el of allElements) {
                if (results.length >= MAX_FIND_RESULTS) break;
                if (getRole(el) === params.role && isVisible(el)) {
                    results.push(describeElement(el));
                }
            }
        }

        return results;
    }

    function describeElement(element) {
        const uid = getUid(element);
        const tag = element.tagName ? element.tagName.toLowerCase() : "";
        const role = getRole(element);
        const name = getAccessibleName(element);
        const text = element.textContent
            ? element.textContent.trim().substring(0, 100)
            : "";

        const desc = { uid, tag };
        if (role) desc.role = role;
        if (name) desc.name = name;
        if (text && text !== name) desc.text = text;
        if (element.id) desc.id = element.id;
        if (element.className && typeof element.className === "string") {
            desc.className = element.className.substring(0, 100);
        }

        const rect = element.getBoundingClientRect();
        desc.bounds = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
        };

        return desc;
    }

    // ─── Element Resolution ──────────────────────────────────────────

    function resolveElement(params) {
        // By UID (preferred — most precise, from snapshot)
        if (params.uid) {
            const el = getElementByUid(params.uid);
            if (!el) {
                throw toolError(
                    "stale_uid",
                    `No element found for uid: ${params.uid}. Take a new snapshot; UIDs may have changed.`,
                    false,
                    "take_snapshot"
                );
            }
            return el;
        }

        // By CSS selector
        if (params.selector) {
            const el = document.querySelector(params.selector);
            if (!el)
                throw toolError(
                    "target_not_found",
                    `No element found for selector: ${params.selector}`,
                    false,
                    "take_snapshot"
                );
            return el;
        }

        // By text content — collect candidates and rank by interactivity
        if (params.text) {
            const searchText = params.text.toLowerCase();
            const candidates = [];
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_ELEMENT,
                {
                    acceptNode: (node) =>
                        node.textContent &&
                        node.textContent.trim().toLowerCase().includes(searchText) &&
                        isVisible(node) &&
                        (node.children.length === 0 ||
                            node.textContent.trim().length < 500)
                            ? NodeFilter.FILTER_ACCEPT
                            : NodeFilter.FILTER_SKIP,
                }
            );
            let node;
            while ((node = walker.nextNode()) && candidates.length < 30) {
                candidates.push(node);
            }
            if (candidates.length === 0)
                throw toolError(
                    "target_not_found",
                    `No element found with text: "${params.text}"`,
                    false,
                    "take_snapshot"
                );

            // Rank: interactive elements first, then by text length (shorter = more specific)
            const interactiveTags = new Set(["button", "a", "input", "select", "textarea", "summary"]);
            candidates.sort((a, b) => {
                const aTag = a.tagName.toLowerCase();
                const bTag = b.tagName.toLowerCase();
                const aInteractive = interactiveTags.has(aTag) || a.getAttribute("role") === "button" || a.getAttribute("role") === "link" || a.getAttribute("tabindex") !== null;
                const bInteractive = interactiveTags.has(bTag) || b.getAttribute("role") === "button" || b.getAttribute("role") === "link" || b.getAttribute("tabindex") !== null;
                if (aInteractive !== bInteractive) return aInteractive ? -1 : 1;
                // Prefer shorter text content (more specific match)
                return (a.textContent?.trim().length || 0) - (b.textContent?.trim().length || 0);
            });
            return candidates[0];
        }

        return null;
    }

    // ─── Click ───────────────────────────────────────────────────────

    function clickElement(params) {
        // Click by coordinates
        if (params.x !== undefined && params.y !== undefined) {
            const el = document.elementFromPoint(params.x, params.y);
            if (!el)
                throw toolError(
                    "target_not_found",
                    `No element at coordinates (${params.x}, ${params.y})`,
                    false,
                    "take_snapshot"
                );
            simulateClick(el, params.doubleClick);
            return `Clicked element at (${params.x}, ${params.y}): <${el.tagName.toLowerCase()}>`;
        }

        // Click by selector or text
        const el = resolveElement(params);
        if (!el) {
            throw toolError(
                "invalid_input",
                "click requires uid, selector, text, or x and y",
                false,
                "fix_input"
            );
        }

        simulateClick(el, params.doubleClick);
        const desc = el.tagName.toLowerCase();
        return `Clicked <${desc}>${el.textContent ? ': "' + el.textContent.trim().substring(0, 50) + '"' : ""}`;
    }

    function simulateClick(element, doubleClick) {
        element.scrollIntoView({ behavior: "instant", block: "center" });

        const rect = element.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;

        const eventOpts = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y,
        };

        element.dispatchEvent(new MouseEvent("mouseover", eventOpts));
        element.dispatchEvent(new MouseEvent("mousedown", eventOpts));
        element.focus();
        element.dispatchEvent(new MouseEvent("mouseup", eventOpts));
        element.dispatchEvent(new MouseEvent("click", eventOpts));

        if (doubleClick) {
            element.dispatchEvent(new MouseEvent("mousedown", eventOpts));
            element.dispatchEvent(new MouseEvent("mouseup", eventOpts));
            element.dispatchEvent(new MouseEvent("click", eventOpts));
            element.dispatchEvent(new MouseEvent("dblclick", eventOpts));
        }
    }

    // ─── React-Compatible Value Setting ─────────────────────────────

    function setInputValue(el, value, append = false) {
        if (el.isContentEditable) {
            setEditableText(el, value, append);
            return;
        }

        // Use the native setter to bypass React's synthetic event system.
        // React overrides the `value` property on inputs; setting it directly
        // doesn't trigger React's onChange. The native setter does.
        const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
        const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;

        const newValue = append ? el.value + value : value;

        if (nativeSetter) {
            nativeSetter.call(el, newValue);
        } else {
            el.value = newValue;
        }

        // Dispatch events that React and other frameworks listen for
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Model-backed editors (ProseMirror, Lexical, Slate) apply edits from the
    // inputType/data on beforeinput/input and re-render from their own
    // document, discarding direct DOM mutation. execCommand("insertText")
    // produces those events, so the edit survives; a bare `input` carrying
    // neither field does not.
    function setEditableText(el, value, append) {
        if (append && value === "") return;

        const selection = window.getSelection();
        const caretInside = selection.rangeCount > 0
            && el.contains(selection.getRangeAt(0).startContainer);
        if (!append || !caretInside) {
            const range = document.createRange();
            range.selectNodeContents(el);
            if (append) range.collapse(false);
            selection.removeAllRanges();
            selection.addRange(range);
        }

        const applied = value === ""
            ? document.execCommand("delete", false)
            : document.execCommand("insertText", false, value);
        if (applied) return;

        // execCommand returns false when the edit is refused (e.g. a canceled
        // beforeinput); synthesize the same edit shape ourselves.
        const detail = {
            bubbles: true,
            inputType: value === "" ? "deleteContentBackward" : "insertText",
            data: value || null,
        };
        const before = new InputEvent("beforeinput", { ...detail, cancelable: true });
        if (el.dispatchEvent(before)) {
            el.textContent = append ? el.textContent + value : value;
        }
        el.dispatchEvent(new InputEvent("input", detail));
    }

    // ─── Type Text ───────────────────────────────────────────────────

    function prepareNativeInput(params) {
        const el = (params.uid || params.selector)
            ? resolveElement(params)
            : document.activeElement;
        if (!el) {
            throw toolError(
                "target_not_found",
                "No element to type into",
                false,
                "take_snapshot"
            );
        }

        const tag = el.tagName.toLowerCase();
        const textInputTypes = new Set([
            "text", "search", "url", "tel", "email", "password", "number",
        ]);
        const isTextInput = tag === "textarea"
            || (tag === "input" && textInputTypes.has(el.type));
        if ((!isTextInput && !el.isContentEditable) || el.disabled || el.readOnly) {
            throw toolError(
                "unsupported_native_target",
                `Native typing requires an editable text control; received <${tag}>`,
                false,
                "use_synthetic_input"
            );
        }

        el.scrollIntoView({ block: "center", inline: "center" });
        el.focus({ preventScroll: true });
        if (document.activeElement !== el && !el.contains(document.activeElement)) {
            throw toolError(
                "native_input_focus_failed",
                `Could not focus <${tag}> for native typing`,
                true,
                "retry"
            );
        }
        return `Focused <${tag}> for native typing`;
    }

    function typeText(params) {
        const el = (params.uid || params.selector)
            ? resolveElement(params)
            : document.activeElement;
        if (!el) {
            throw toolError(
                "target_not_found",
                "No element to type into",
                false,
                "take_snapshot"
            );
        }

        el.focus();

        const readBack = () => (el.isContentEditable ? el.textContent : el.value);
        const before = readBack();

        if (params.clearFirst) {
            setInputValue(el, "", false);
        }

        const text = params.text || "";
        setInputValue(el, text, !params.clearFirst);

        // An editor that re-renders from its own model can discard the edit
        // after reporting nothing; success must mean the content changed.
        // A detached element cannot be re-read meaningfully, and clearFirst
        // with identical text legitimately produces no difference.
        const unchanged = text !== ""
            && el.isConnected !== false
            && readBack() === before
            && !(params.clearFirst && text === before);
        if (unchanged) {
            throw toolError(
                "input_not_applied",
                `Typing did not change <${el.tagName.toLowerCase()}>; the page discarded or blocked the input`,
                false,
                "use_native_input"
            );
        }

        // Press a key after typing (e.g., Enter, Tab)
        if (params.submitKey) {
            const keyOpts = {
                key: params.submitKey,
                code: params.submitKey,
                bubbles: true,
                cancelable: true,
            };
            el.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
            el.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
            el.dispatchEvent(new KeyboardEvent("keyup", keyOpts));

            // For Enter, also submit the form if present
            if (params.submitKey === "Enter" && el.form) {
                el.form.requestSubmit();
            }
        }

        return `Typed "${text}" into <${el.tagName.toLowerCase()}>${params.submitKey ? ` then pressed ${params.submitKey}` : ""}`;
    }

    // ─── Form Input ──────────────────────────────────────────────────

    function formInput(params) {
        const entries = Object.entries(params.fields || {});
        if (entries.length === 0) {
            throw toolError(
                "invalid_input",
                "form_input requires at least one CSS selector and value",
                false,
                "fix_input"
            );
        }

        const results = [];
        const missing = [];

        for (const [selector, value] of entries) {
            const el = document.querySelector(selector);
            if (!el) {
                missing.push(selector);
                results.push(`${selector}: not found`);
                continue;
            }
            el.focus();
            setInputValue(el, value, false);
            results.push(`${selector}: filled`);
        }

        // A partial fill still reports per-field results, but filling nothing is a
        // failure rather than a success whose body happens to say "not found".
        if (missing.length === entries.length) {
            throw toolError(
                "target_not_found",
                `No form fields matched: ${missing.join(", ")}`,
                false,
                "take_snapshot"
            );
        }

        return results.join("\n");
    }

    // ─── Select Option ───────────────────────────────────────────────

    function selectOption(params) {
        const el = resolveElement(params);
        if (!el) {
            throw toolError(
                "invalid_input",
                "select_option requires uid or selector",
                false,
                "fix_input"
            );
        }
        if (el.tagName.toLowerCase() !== "select") {
            throw toolError(
                "target_not_found",
                `Element is not a <select>: <${el.tagName.toLowerCase()}>`,
                false,
                "take_snapshot"
            );
        }
        if (params.value === undefined && !params.label) {
            throw toolError(
                "invalid_input",
                "select_option requires value or label",
                false,
                "fix_input"
            );
        }

        if (params.value !== undefined) {
            // Assigning an unmatched value clears the selection instead of
            // throwing, so verify it took rather than reporting a silent no-op.
            const previous = el.value;
            el.value = params.value;
            if (el.value !== String(params.value)) {
                el.value = previous;
                throw toolError(
                    "target_not_found",
                    `No option with value "${params.value}" in <select>`,
                    false,
                    "take_snapshot"
                );
            }
        } else {
            const option = Array.from(el.options).find(
                (o) => o.textContent.trim() === params.label
            );
            if (!option) {
                throw toolError(
                    "target_not_found",
                    `Option with label "${params.label}" not found`,
                    false,
                    "take_snapshot"
                );
            }
            el.value = option.value;
        }

        el.dispatchEvent(new Event("change", { bubbles: true }));
        const target = params.uid || params.selector || params.label || "select";
        return `Selected option in ${target}`;
    }

    // ─── Scroll ──────────────────────────────────────────────────────

    function scrollPage(params) {
        let target = window;
        if (params.uid || params.selector) {
            target = resolveElement(params);
            if (!target) throw new Error("Scroll target not found");
        }

        // Explicit null check: `amount: 0` is a caller-meant no-op, not "unset".
        const amount = params.amount == null ? window.innerHeight * 0.8 : params.amount;
        const directionMap = {
            up: { top: -amount, left: 0 },
            down: { top: amount, left: 0 },
            left: { top: 0, left: -amount },
            right: { top: 0, left: amount },
        };

        const scroll = directionMap[params.direction];
        if (!scroll) {
            throw toolError(
                "invalid_input",
                `scroll requires direction up, down, left, or right; received ${params.direction}`,
                false,
                "fix_input"
            );
        }

        if (target === window) {
            window.scrollBy({ ...scroll, behavior: "smooth" });
        } else {
            target.scrollBy({ ...scroll, behavior: "smooth" });
        }

        return `Scrolled ${params.direction} by ${amount}px`;
    }

    // ─── Press Key ───────────────────────────────────────────────────

    // KeyboardEvent.code is physical-key based: letters are KeyX, digits Digit0-9.
    function keyCode(key) {
        if (key.length !== 1) return key;
        if (key >= "0" && key <= "9") return `Digit${key}`;
        if (/[a-z]/i.test(key)) return `Key${key.toUpperCase()}`;
        return key;
    }

    function pressKey(params) {
        const keyString = params.key;
        if (typeof keyString !== "string" || keyString === "") {
            throw toolError(
                "invalid_input",
                "press_key requires a non-empty key such as Enter, Tab, or Meta+a",
                false,
                "fix_input"
            );
        }
        const parts = keyString.split("+");
        const key = parts.pop();
        const modifiers = parts.map((m) => m.toLowerCase());

        const eventOpts = {
            key,
            code: keyCode(key),
            bubbles: true,
            cancelable: true,
            ctrlKey: modifiers.includes("control") || modifiers.includes("ctrl"),
            shiftKey: modifiers.includes("shift"),
            altKey: modifiers.includes("alt") || modifiers.includes("option"),
            metaKey: modifiers.includes("meta") || modifiers.includes("command") || modifiers.includes("cmd"),
        };

        const target = document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent("keydown", eventOpts));
        target.dispatchEvent(new KeyboardEvent("keypress", eventOpts));
        target.dispatchEvent(new KeyboardEvent("keyup", eventOpts));

        return `Pressed ${keyString}`;
    }

    // ─── Hover ───────────────────────────────────────────────────────

    function hoverElement(params) {
        const el = resolveElement(params);
        if (!el) {
            throw toolError(
                "invalid_input",
                "hover requires uid, selector, or text",
                false,
                "fix_input"
            );
        }

        el.scrollIntoView({ behavior: "instant", block: "center" });

        const rect = el.getBoundingClientRect();
        const eventOpts = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
        };

        el.dispatchEvent(new MouseEvent("mouseenter", eventOpts));
        el.dispatchEvent(new MouseEvent("mouseover", eventOpts));
        el.dispatchEvent(new MouseEvent("mousemove", eventOpts));

        return `Hovered over <${el.tagName.toLowerCase()}>`;
    }

    // ─── Drag ────────────────────────────────────────────────────────

    function dragElement(params) {
        const fromEl = resolveElement({
            uid: params.fromUid,
            selector: params.fromSelector,
        });
        const toEl = resolveElement({
            uid: params.toUid,
            selector: params.toSelector,
        });

        if (!fromEl || !toEl) {
            throw toolError(
                "invalid_input",
                "drag requires fromUid or fromSelector, and toUid or toSelector",
                false,
                "fix_input"
            );
        }

        fromEl.scrollIntoView({ behavior: "instant", block: "center" });
        const fromRect = fromEl.getBoundingClientRect();
        const toRect = toEl.getBoundingClientRect();

        const fromX = fromRect.left + fromRect.width / 2;
        const fromY = fromRect.top + fromRect.height / 2;
        const toX = toRect.left + toRect.width / 2;
        const toY = toRect.top + toRect.height / 2;

        const baseOpts = { bubbles: true, cancelable: true, view: window };

        // Start drag
        fromEl.dispatchEvent(new MouseEvent("mousedown", { ...baseOpts, clientX: fromX, clientY: fromY }));
        fromEl.dispatchEvent(new MouseEvent("mousemove", { ...baseOpts, clientX: fromX, clientY: fromY }));

        // Create and dispatch dragstart
        const dataTransfer = new DataTransfer();
        fromEl.dispatchEvent(new DragEvent("dragstart", { ...baseOpts, clientX: fromX, clientY: fromY, dataTransfer }));

        // Move to target
        toEl.dispatchEvent(new DragEvent("dragenter", { ...baseOpts, clientX: toX, clientY: toY, dataTransfer }));
        toEl.dispatchEvent(new DragEvent("dragover", { ...baseOpts, clientX: toX, clientY: toY, dataTransfer }));

        // Drop
        toEl.dispatchEvent(new DragEvent("drop", { ...baseOpts, clientX: toX, clientY: toY, dataTransfer }));
        fromEl.dispatchEvent(new DragEvent("dragend", { ...baseOpts, clientX: toX, clientY: toY, dataTransfer }));

        fromEl.dispatchEvent(new MouseEvent("mouseup", { ...baseOpts, clientX: toX, clientY: toY }));

        return `Dragged <${fromEl.tagName.toLowerCase()}> to <${toEl.tagName.toLowerCase()}>`;
    }

    // ─── Native Pointer ──────────────────────────────────────────────

    // CGEvent posts in global screen points. window.screenX/screenY use the
    // same origin (top-left of the primary display, menu bar included).
    // Safari's only side chrome is the left sidebar, so the full
    // outerWidth-innerWidth difference sits on the left of the content area.
    // Assumes 100% page zoom.
    function nativePointerPoints(params) {
        const toScreen = (cssX, cssY) => ({
            x: window.screenX + (window.outerWidth - window.innerWidth) + cssX,
            y: window.screenY + (window.outerHeight - window.innerHeight) + cssY,
        });
        const checked = (css) => {
            if (!Number.isFinite(css.x) || !Number.isFinite(css.y)
                || css.x < 0 || css.x >= window.innerWidth
                || css.y < 0 || css.y >= window.innerHeight) {
                throw toolError(
                    "invalid_input",
                    `Point (${Math.round(css.x)}, ${Math.round(css.y)}) is outside the viewport; native events at screen coordinates could hit another application`,
                    false,
                    "fix_input"
                );
            }
            return toScreen(css.x, css.y);
        };
        const centerOf = (element) => {
            const rect = element.getBoundingClientRect();
            return checked({
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
            });
        };

        const fromEl = params.fromUid || params.fromSelector
            ? resolveElement({ uid: params.fromUid, selector: params.fromSelector })
            : (params.uid || params.selector || params.text)
                ? resolveElement(params)
                : null;
        const toEl = params.toUid || params.toSelector
            ? resolveElement({ uid: params.toUid, selector: params.toSelector })
            : null;

        // Scroll only when an endpoint is off-viewport, before any
        // measurement: scrolling shifts every rect, so measuring between two
        // scrolls returns a stale point. A drag whose endpoints cannot share
        // one scroll position fails the bounds check instead of dragging
        // whatever happens to sit at the stale point.
        const ensureVisible = (element) => {
            const r = element.getBoundingClientRect();
            const visible = r.top >= 0 && r.bottom <= window.innerHeight
                && r.left >= 0 && r.right <= window.innerWidth;
            if (!visible) element.scrollIntoView({ behavior: "instant", block: "center" });
        };
        if (fromEl) ensureVisible(fromEl);
        if (toEl) ensureVisible(toEl);

        let from;
        if (fromEl) {
            from = centerOf(fromEl);
        } else if (params.x !== undefined && params.y !== undefined) {
            from = checked({ x: Number(params.x), y: Number(params.y) });
        } else {
            throw toolError(
                "invalid_input",
                "native pointer requires uid, selector, text, or x/y",
                false,
                "fix_input"
            );
        }

        const to = toEl ? centerOf(toEl) : undefined;
        return to ? { from, to } : { from };
    }

    // A native key reaches whatever Safari has focused; when the chrome (e.g.
    // the address bar) holds focus the page never sees it. Pull focus into
    // the document unless the page already has it.
    function prepareNativeKey() {
        if (!document.hasFocus() && document.body) {
            document.body.setAttribute("tabindex", "-1");
            document.body.focus({ preventScroll: true });
        }
        return "Page ready for native key";
    }

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

    function dropFile(params) {
        const target = resolveElement({ uid: params.uid, selector: params.selector });
        const files = buildFiles(params);
        const dataTransfer = transferFor(files);

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

        return `Dropped ${describeFiles(files)} on <${target.tagName.toLowerCase()}>`;
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
                if (document.querySelector(params.selector)) {
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
        const request = { ...params, id: `trace-${Date.now()}-${++bridgeRequestCounter}` };
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
})();
