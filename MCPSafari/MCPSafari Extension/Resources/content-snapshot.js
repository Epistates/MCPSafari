/**
 * Reading the page: text extraction, shadow-DOM traversal, and the
 * accessibility snapshot with its roles, names and redaction.
 */

(() => {
    const mcp = window.__mcpSafari;
    if (!mcp || mcp.loaded.has("snapshot")) return;
    mcp.loaded.add("snapshot");
    const { escapeCssString, getUid } = mcp;

    // ─── Page Reading ────────────────────────────────────────────────

    // A big application page runs to hundreds of kilobytes, which either
    // overruns the client's output limit or spends the model's context on one
    // call. Cut it and say so, rather than returning a clipped page that reads
    // like the whole thing.
    const MAX_PAGE_CHARS = 100000;

    function clampText(value, limit) {
        const max = limit > 0 ? limit : MAX_PAGE_CHARS;
        if (value.length <= max) return value;
        return `${value.slice(0, max)}\n\n[truncated: ${value.length} characters total, `
            + `${max} returned. Raise maxChars, or use find or snapshot to target a region.]`;
    }

    function readPage(params) {
        const format = params.format || "text";
        const maxChars = Number(params.maxChars) > 0 ? Number(params.maxChars) : 0;
        switch (format) {
            case "html":
                return clampText(document.documentElement.outerHTML, maxChars);
            case "text":
                return clampText(document.body ? document.body.innerText : "", maxChars);
            case "snapshot":
                return takeSnapshot(params);
            default:
                throw new Error(`Unknown format: ${format}. Use 'text', 'html', or 'snapshot'.`);
        }
    }

    function getPageText() {
        return document.body ? document.body.innerText : "";
    }

    // ─── Shadow DOM Traversal ────────────────────────────────────────

    // querySelector and TreeWalker each see a single tree, so anything inside
    // a shadow root is invisible to them and a page built on web components
    // returns results that look complete and are not. Every lookup below
    // repeats itself against each open root instead. Closed roots stay
    // unreachable: the page chose that, and no API reaches in.
    function* allRoots(root = document) {
        yield root;
        for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot) yield* allRoots(element.shadowRoot);
        }
    }

    function deepQueryFirst(selector) {
        for (const root of allRoots()) {
            const found = root.querySelector(selector);
            if (found) return found;
        }
        return null;
    }

    function deepQueryAll(selector, limit = Infinity) {
        const found = [];
        for (const root of allRoots()) {
            for (const element of root.querySelectorAll(selector)) {
                found.push(element);
                if (found.length >= limit) return found;
            }
        }
        return found;
    }

    // A walker rooted at the document would offer <html> and <body> themselves
    // as matches, which the leaf-ish filters downstream exist to exclude. A
    // shadow root has no such wrapper, so it is walked as-is.
    function walkRootFor(root) {
        return root === document ? document.body : root;
    }

    // A shadow host renders its shadow root, and the host's own children only
    // appear where a <slot> puts them, so walking both would report slotted
    // content twice. This follows the flattened tree the user actually sees.
    function renderedChildren(element) {
        if (element.shadowRoot) return Array.from(element.shadowRoot.children);
        if (typeof element.assignedElements === "function") {
            // flatten resolves nested slots and falls back to the slot's own
            // children when nothing is assigned.
            return element.assignedElements({ flatten: true });
        }
        return Array.from(element.children);
    }

    // Text belongs to whichever tree renders it, so a shadow host reports its
    // shadow content instead of light children a slot placed somewhere else.
    function renderedTextRoot(element) {
        return element.shadowRoot || element;
    }

    // `shadowRoot` is null both for "no shadow root" and for a closed one, so a
    // closed root can only be inferred: a custom element that occupies space
    // while reporting no content of its own is rendering something we cannot
    // see. Marking it beats reporting an empty element that looks absent.
    function hasClosedShadowRoot(element) {
        if (element.shadowRoot) return false;
        if (!element.tagName || !element.tagName.includes("-")) return false;
        if (element.children.length > 0) return false;
        if (element.textContent && element.textContent.trim()) return false;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    // ─── Accessibility Snapshot ──────────────────────────────────────

    const MAX_TREE_DEPTH = 30;
    const MAX_SNAPSHOT_NODES = 2000;

    function takeSnapshot(params = {}) {
        const root = document.body || document.documentElement;
        const requested = Number(params.maxNodes);
        const budget = { remaining: requested > 0 ? requested : MAX_SNAPSHOT_NODES, cut: false };
        const tree = buildTree(root, 0, budget);
        // Marked on the root as well, so a caller reading the top of a large
        // tree can tell a cut snapshot from a complete one without scanning it.
        if (tree && budget.cut) tree.truncated = true;
        return tree;
    }

    function buildTree(element, depth, budget) {
        if (depth > MAX_TREE_DEPTH) return null;
        if (!isVisible(element)) return null;
        if (budget.remaining <= 0) {
            budget.cut = true;
            return null;
        }
        budget.remaining -= 1;

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

        // A frame's document belongs to a different content script, so the
        // background splices it in here. It matches on the resolved src and
        // drops this marker afterwards.
        if (tag === "iframe" || tag === "frame") {
            node.frameSrc = element.src || "";
        }

        // Children
        const children = [];
        let droppedChildren = false;
        for (const child of renderedChildren(element)) {
            const childNode = buildTree(child, depth + 1, budget);
            if (childNode) children.push(childNode);
            else if (budget.remaining <= 0) droppedChildren = true;
        }
        if (droppedChildren) node.childrenTruncated = true;
        if (children.length === 0 && hasClosedShadowRoot(element)) node.shadowClosed = true;

        // Leaf nodes report their whole text content. Nodes that also have
        // element children report their own direct text nodes, so mixed
        // content such as <button><span>9</span>All</button> keeps "All".
        const rawText = children.length === 0
            ? renderedTextRoot(element).textContent
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
        for (const child of renderedTextRoot(element).childNodes) {
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
            // `for` resolves within the element's own tree, so a control inside
            // a shadow root is labelled from that root and not from the document.
            const scope = element.getRootNode ? element.getRootNode() : document;
            const label = scope.querySelector(`label[for="${escapeCssString(element.id)}"]`);
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


    Object.assign(mcp, { allRoots, deepQueryAll, deepQueryFirst, getAccessibleName, getPageText, getRole, isVisible, readPage, takeSnapshot, walkRootFor });
})();
