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

    // ─── Message Handler ─────────────────────────────────────────────

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // Only handle messages meant for content scripts
        if (!message || !message.action) return false;

        handleAction(message.action, message.params || {})
            .then((data) => sendResponse({ data, error: null }))
            .catch((err) => sendResponse({ data: null, error: String(err.message || err) }));

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
            case "wait":
                return waitFor(params);
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

        // Value for inputs
        if (element.value !== undefined && element.value !== "") {
            node.value = String(element.value);
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

        // For text-only leaf nodes, include text content
        if (children.length === 0 && element.textContent) {
            const text = element.textContent.trim();
            if (text && text.length <= 500) {
                node.text = text;
            } else if (text) {
                node.text = text.substring(0, 497) + "...";
            }
        }

        if (children.length > 0) node.children = children;

        return node;
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
        const implicitRoles = {
            a: "link",
            button: "button",
            input: getInputRole(element),
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

        // aria-labelledby
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
            const labelEl = document.getElementById(labelledBy);
            if (labelEl) return labelEl.textContent.trim();
        }

        // Label element for inputs
        if (element.id) {
            const label = document.querySelector(`label[for="${element.id}"]`);
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

    function findElements(params) {
        const results = [];

        if (params.selector) {
            const elements = document.querySelectorAll(params.selector);
            for (const el of elements) {
                results.push(describeElement(el));
            }
        }

        if (params.text) {
            const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_ELEMENT,
                {
                    acceptNode: (node) =>
                        node.textContent &&
                        node.textContent
                            .toLowerCase()
                            .includes(params.text.toLowerCase()) &&
                        isVisible(node)
                            ? NodeFilter.FILTER_ACCEPT
                            : NodeFilter.FILTER_SKIP,
                }
            );
            let node;
            while ((node = walker.nextNode()) && results.length < 20) {
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
                if (results.length >= 50) break;
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
            if (!el) throw new Error(`No element found for uid: ${params.uid}. Take a new snapshot — UIDs may have changed.`);
            return el;
        }

        // By CSS selector
        if (params.selector) {
            const el = document.querySelector(params.selector);
            if (!el)
                throw new Error(`No element found for selector: ${params.selector}`);
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
                throw new Error(`No element found with text: "${params.text}"`);

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
                throw new Error(
                    `No element at coordinates (${params.x}, ${params.y})`
                );
            simulateClick(el, params.doubleClick);
            return `Clicked element at (${params.x}, ${params.y}): <${el.tagName.toLowerCase()}>`;
        }

        // Click by selector or text
        const el = resolveElement(params);
        if (!el) throw new Error("No element specified to click");

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
            el.textContent = append ? el.textContent + value : value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
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

    // ─── Type Text ───────────────────────────────────────────────────

    function typeText(params) {
        const el = (params.uid || params.selector)
            ? resolveElement(params)
            : document.activeElement;
        if (!el) throw new Error("No element to type into");

        el.focus();

        if (params.clearFirst) {
            setInputValue(el, "", false);
        }

        const text = params.text || "";
        setInputValue(el, text, !params.clearFirst);

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
        const fields = params.fields || {};
        const results = [];

        for (const [selector, value] of Object.entries(fields)) {
            const el = document.querySelector(selector);
            if (!el) {
                results.push(`${selector}: not found`);
                continue;
            }
            el.focus();
            setInputValue(el, value, false);
            results.push(`${selector}: filled`);
        }

        return results.join("\n");
    }

    // ─── Select Option ───────────────────────────────────────────────

    function selectOption(params) {
        const el = resolveElement(params);
        if (!el) throw new Error(`Select element not found`);
        if (el.tagName.toLowerCase() !== "select") {
            throw new Error(`Element is not a <select>: ${el.tagName}`);
        }

        if (params.value !== undefined) {
            el.value = params.value;
        } else if (params.label) {
            const option = Array.from(el.options).find(
                (o) => o.textContent.trim() === params.label
            );
            if (!option)
                throw new Error(`Option with label "${params.label}" not found`);
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

        const amount = params.amount || window.innerHeight * 0.8;
        const directionMap = {
            up: { top: -amount, left: 0 },
            down: { top: amount, left: 0 },
            left: { top: 0, left: -amount },
            right: { top: 0, left: amount },
        };

        const scroll = directionMap[params.direction];
        if (!scroll) throw new Error(`Invalid direction: ${params.direction}`);

        if (target === window) {
            window.scrollBy({ ...scroll, behavior: "smooth" });
        } else {
            target.scrollBy({ ...scroll, behavior: "smooth" });
        }

        return `Scrolled ${params.direction} by ${amount}px`;
    }

    // ─── Press Key ───────────────────────────────────────────────────

    function pressKey(params) {
        const keyString = params.key;
        const parts = keyString.split("+");
        const key = parts.pop();
        const modifiers = parts.map((m) => m.toLowerCase());

        const eventOpts = {
            key,
            code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
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
        if (!el) throw new Error("No element specified to hover");

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

        if (!fromEl) throw new Error("No source element specified for drag");
        if (!toEl) throw new Error("No target element specified for drag");

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
            throw new Error(
                `Timeout waiting for selector: ${params.selector}`
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
            throw new Error(`Timeout waiting for text: "${params.text}"`);
        }

        return "Nothing to wait for";
    }

    // ─── Dialog Handling (delegate to interceptor) ────────────────────

    function handleDialog(params) {
        if (typeof window.__mcpHandleDialog === "function") {
            const result = window.__mcpHandleDialog(params);
            if (result.handled) {
                return `${params.action === "accept" ? "Accepted" : "Dismissed"} ${result.type} dialog: "${result.message}"`;
            }
            return "No pending dialog found";
        }
        return "Dialog interceptor not loaded";
    }

    // ─── Console Messages (delegate to interceptor) ──────────────────

    function getConsoleMessages(params) {
        if (typeof window.__mcpGetConsoleMessages === "function") {
            return window.__mcpGetConsoleMessages(params);
        }
        return [];
    }

    // ─── Network Requests (delegate to interceptor) ──────────────────

    function getNetworkRequests(params) {
        if (typeof window.__mcpGetNetworkRequests === "function") {
            return window.__mcpGetNetworkRequests(params);
        }
        return [];
    }
})();
