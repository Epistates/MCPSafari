/**
 * Reading the page: text extraction, shadow-DOM traversal, and the
 * accessibility snapshot with its roles, names and redaction.
 */

(() => {
    const mcp = window.__mcpSafari;
    if (!mcp || mcp.loaded.has("snapshot")) return;
    mcp.loaded.add("snapshot");
    const { clipText, escapeCssString, getUid } = mcp;

    // ─── Page Reading ────────────────────────────────────────────────

    // A big application page runs to hundreds of kilobytes, which either
    // overruns the client's output limit or spends the model's context on one
    // call. Cut it and say so, rather than returning a clipped page that reads
    // like the whole thing.
    const MAX_PAGE_CHARS = 100000;

    function clampText(value, limit) {
        const max = limit > 0 ? limit : MAX_PAGE_CHARS;
        if (value.length <= max) return value;
        const kept = clipText(value, max);
        return `${kept}\n\n[truncated: ${value.length} characters total, `
            + `${kept.length} returned. Raise maxChars, or use find or snapshot to target a region.]`;
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
    // One cap for the strings a node carries: its text, its name and its value.
    // Every string in a node comes from the page, so each has one. A single
    // `aria-label` of a megabyte, referenced by every node that names it, would
    // otherwise be copied into the tree once per node.
    const MAX_TEXT_CHARS = 500;
    // URLs get more room, since cutting one makes it useless as a link. A
    // frame's `src` is what the background matches the frame on, so a URL cut
    // here leaves that frame attached to its parent and counted as unmatched.
    const MAX_URL_CHARS = 2048;
    // The caps above hold each string, and the node limit holds the count, but
    // together they allow a tree of many megabytes: 10,000 nodes asked for with
    // five strings each. This is the ceiling for the whole tree, well above
    // anything a real page produces at the default node limit, and a snapshot
    // that reaches it stops there and says so, as it does for the node limit.
    const MAX_SNAPSHOT_CHARS = 2000000;

    function truncateText(text, max = MAX_TEXT_CHARS) {
        return text.length <= max ? text : `${clipText(text, max - 3)}...`;
    }

    function takeSnapshot(params = {}) {
        const root = document.body || document.documentElement;
        for (const shadowRoot of allRoots()) watchForPasswordFields(shadowRoot);
        const requested = Number(params.maxNodes);
        const budget = { remaining: requested > 0 ? requested : MAX_SNAPSHOT_NODES, chars: 0, cut: false };
        const tree = buildTree(root, 0, budget);
        // Marked on the root as well, so a caller reading the top of a large
        // tree can tell a cut snapshot from a complete one without scanning it.
        if (tree && budget.cut) tree.truncated = true;
        return tree;
    }

    const budgetSpent = (budget) => budget.remaining <= 0 || budget.chars >= MAX_SNAPSHOT_CHARS;

    // Counts a string against the budget as it goes into the tree, and returns
    // it. The check is on entering a node, so the tree can run over by what one
    // node carries, which the per-string caps bound.
    function charge(budget, text) {
        budget.chars += text.length;
        return text;
    }

    function buildTree(element, depth, budget) {
        if (depth > MAX_TREE_DEPTH) return null;
        if (!isVisible(element)) return null;
        if (budgetSpent(budget)) {
            budget.cut = true;
            return null;
        }
        budget.remaining -= 1;

        const role = getRole(element);
        const name = getAccessibleName(element);
        const uid = getUid(element);
        const tag = element.tagName ? element.tagName.toLowerCase() : "";

        const node = { uid, tag, role };

        // Value for inputs. Secrets report their presence, not their contents,
        // so a snapshot of a filled login or payment form is safe to hand to a model.
        if (element.value !== undefined && element.value !== "") {
            node.value = isSensitiveInput(element)
                ? REDACTED
                : charge(budget, truncateText(String(element.value)));
        }

        // States
        if (element.checked) node.checked = true;
        if (element.disabled) node.disabled = true;
        if (element.selected) node.selected = true;
        if (element.getAttribute("aria-expanded") !== null) {
            node.expanded = element.getAttribute("aria-expanded") === "true";
        }

        // Href for links
        // (An SVG anchor's `href` is an object, not a string, and is left out.)
        if (tag === "a" && element.href && typeof element.href === "string") {
            node.href = charge(budget, truncateText(element.href, MAX_URL_CHARS));
        }

        // A frame's document belongs to a different content script, so the
        // background splices it in here. It matches on the resolved src and
        // drops this marker afterwards.
        if (tag === "iframe" || tag === "frame") {
            node.frameSrc = charge(budget, truncateText(element.src || "", MAX_URL_CHARS));
        }

        // Children
        const children = [];
        let droppedChildren = false;
        for (const child of renderedChildren(element)) {
            const childNode = buildTree(child, depth + 1, budget);
            if (childNode) children.push(childNode);
            else if (budgetSpent(budget)) droppedChildren = true;
        }
        if (droppedChildren) node.childrenTruncated = true;
        if (children.length === 0 && hasClosedShadowRoot(element)) node.shadowClosed = true;

        // Leaf nodes report their whole text content. Nodes that also have
        // element children report their own direct text nodes, so mixed
        // content such as <button><span>9</span>All</button> keeps "All". That
        // is only the element's own words: the children carry the rest, and for
        // a link, button or heading the whole label in reading order is `name`.
        const rawText = children.length === 0
            ? renderedTextRoot(element).textContent
            : ownTextContent(element);
        // A textarea's text content is its default value, so a sensitive one
        // would otherwise leak here what the `value` redaction above withheld.
        let text = "";
        if (rawText && !(tag === "textarea" && isSensitiveInput(element))) {
            text = rawText.trim();
            if (text) node.text = charge(budget, truncateText(text));
        }

        // A name that only repeats the node's text adds nothing, and content
        // fallback gives one to every link, button and heading. Keep it when it
        // says something the text does not: inline markup, an aria-label, an
        // alt, a label from elsewhere. find and click read the name from the
        // page, not from the tree, so omitting it here loses no way to match.
        if (name && name !== truncateText(text.replace(/\s+/g, " "))) node.name = charge(budget, name);

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

    // Fields whose contents must never reach a snapshot. The rule below is a
    // pure function of a field's attributes, and trace-interceptor.js keeps a
    // copy of it because that file runs in the page's world and cannot read
    // this one. Tests/sensitive-field-rule.test.mjs fails if the two drift
    // apart, so change both together.
    //
    // BEGIN sensitive-field-rule
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
    // A name or label is only a hint, so short words must match whole (`pin`
    // is a secret, `shipping` is not) and long ones may sit inside a longer
    // run (`newpassword`, `confirmPassword`).
    const SECRET_HINT_WORDS = new Set([
        "pass", "pwd", "pin", "otp", "cvv", "cvc", "cvn", "cvv2", "cvc2", "ssn", "secret", "token", "2fa",
        "iban", "cardno", "ccnum",
    ]);
    // Matched inside the words run together, so `api_key`, `apiKey` and
    // `x-api-key` all read as `apikey`.
    const SECRET_HINT_FRAGMENTS = [
        "password", "passwd", "passcode", "passphrase", "pincode", "secret", "token", "onetime",
        "cardnum", "creditcard", "debitcard", "apikey", "privatekey", "accesskey", "socialsecurity", "routingnumber",
    ];
    // A hint is read from its start only. A label or placeholder can be as long
    // as the page likes, and what names a field is not found deep inside one.
    const MAX_HINT_CHARS = 256;
    // Types that carry a label or a fixed value rather than something typed.
    const NON_SECRET_TYPES = new Set(["button", "submit", "reset", "image", "checkbox", "radio", "file", "range", "color"]);

    function hintLooksSecret(hint) {
        const words = String(hint).slice(0, MAX_HINT_CHARS)
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean);
        const joined = words.join("");
        return words.some((word) => SECRET_HINT_WORDS.has(word))
            || SECRET_HINT_FRAGMENTS.some((fragment) => joined.includes(fragment));
    }

    function isSensitiveField({ tag, type, autocomplete, hints }) {
        if (tag !== "input" && tag !== "textarea") return false;
        const kind = String(type || "").toLowerCase();
        if (kind === "password") return true;
        if (String(autocomplete || "").toLowerCase().split(/\s+/).some((token) => SENSITIVE_AUTOCOMPLETE.has(token))) {
            return true;
        }
        if (tag === "input" && NON_SECRET_TYPES.has(kind)) return false;
        return hints.some((hint) => hint && hintLooksSecret(hint));
    }
    // END sensitive-field-rule

    const REDACTED = "[redacted]";

    // A show-password toggle flips the field to type=text, after which the type
    // alone no longer says it was a password. The page's own scripts do the
    // flipping, so the only way to know is to have been watching: every field
    // seen as a password stays in this set for the life of the page.
    //
    // Limits, both on purpose. A toggle that happened inside a shadow root
    // before the first snapshot was not watched, and the name and autocomplete
    // hints are what catch that field. And the set is per content script, so a
    // re-injection starts it empty.
    const everPassword = new WeakSet();
    const watchedRoots = new WeakSet();
    const isPasswordType = (element) => String(element.type || "").toLowerCase() === "password";

    const typeObserver = typeof MutationObserver === "function"
        ? new MutationObserver((records) => {
            for (const record of records) {
                const target = record.target;
                if (String(record.oldValue || "").toLowerCase() === "password" || isPasswordType(target)) {
                    everPassword.add(target);
                }
            }
        })
        : null;

    // Covers the document from the first snapshot's point of view, and each
    // open shadow root as the snapshot reaches it, since an observer on the
    // document does not see into those.
    function watchForPasswordFields(root) {
        if (!typeObserver || watchedRoots.has(root)) return;
        watchedRoots.add(root);
        typeObserver.observe(root, { subtree: true, attributes: true, attributeFilter: ["type"], attributeOldValue: true });
        for (const field of root.querySelectorAll("input")) {
            if (isPasswordType(field)) everPassword.add(field);
        }
    }

    watchForPasswordFields(document);

    function isSensitiveInput(element) {
        const tag = element.tagName ? element.tagName.toLowerCase() : "";
        if (tag !== "input" && tag !== "textarea") return false;
        if (everPassword.has(element)) return true;
        return isSensitiveField({
            tag,
            type: element.type,
            autocomplete: element.getAttribute("autocomplete"),
            // What the page calls the field in words as well as in markup: a
            // generic `name="field7"` is often labelled "Card number".
            hints: [
                element.getAttribute("name"),
                element.id,
                element.getAttribute("aria-label"),
                element.getAttribute("inputmode"),
                element.getAttribute("autocomplete"),
                element.getAttribute("placeholder"),
                element.getAttribute("title"),
                ...Array.from(element.labels || [], (label) => label.textContent),
            ],
        });
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

    // Capped here, at the one place a name leaves, so that no source of one
    // (an attribute, a label, a referenced element) can hand back more than a
    // node is allowed to carry.
    function getAccessibleName(element) {
        const name = accessibleNameFrom(element);
        return name ? truncateText(name) : name;
    }

    // Page text as a name: whitespace collapsed, so that source markup wrapping
    // a label across lines reads as one, and empty when nothing but whitespace
    // is there. A name that is only whitespace must fall through to the next
    // source rather than win with a blank, and callers test for emptiness. Only
    // the start is read: a name is cut to a few hundred characters anyway, and
    // normalizing a megabyte once for every node that refers to it adds up.
    function nameText(raw) {
        return raw ? clipText(String(raw), MAX_TEXT_CHARS * 4).replace(/\s+/g, " ").trim() : "";
    }

    // Joins the text of several elements in order, and stops reading once there
    // is more than a name can hold: a page can list thousands of ids, or point
    // at an element holding a megabyte.
    function joinedText(elements) {
        const parts = [];
        let length = 0;
        for (const labelEl of elements) {
            const text = nameText(labelEl.textContent);
            if (!text) continue;
            parts.push(text);
            length += text.length;
            if (length > MAX_TEXT_CHARS) break;
        }
        return parts.join(" ");
    }

    // `aria-labelledby` ids resolve within the element's own tree, so a control
    // inside a shadow root finds its label there. The document is tried too, so
    // a reference that used to resolve from a shadow root still does.
    function elementsById(element, ids) {
        const scope = element.getRootNode ? element.getRootNode() : document;
        const found = [];
        for (const id of ids) {
            const target = (typeof scope.getElementById === "function" && scope.getElementById(id))
                || document.getElementById(id);
            if (target) found.push(target);
        }
        return found;
    }

    function accessibleNameFrom(element) {
        // aria-label
        const ariaLabel = nameText(element.getAttribute("aria-label"));
        if (ariaLabel) return ariaLabel;

        // aria-labelledby takes a space-separated list of ids, joined in order.
        const labelledBy = element.getAttribute("aria-labelledby");
        if (labelledBy) {
            const ids = labelledBy.split(/\s+/).filter(Boolean);
            const labelText = joinedText(elementsById(element, ids));
            if (labelText) return labelText;
        }

        // Label elements for inputs, all of them joined in order, as a control
        // may have several. `labels` covers labelable controls directly; the
        // selector fallback must escape the id, because a raw id containing a
        // quote builds a malformed selector that throws and fails the snapshot.
        if (element.labels && element.labels.length > 0) {
            const labelText = joinedText(element.labels);
            if (labelText) return labelText;
        }
        if (element.id) {
            // `for` resolves within the element's own tree, so a control inside
            // a shadow root is labelled from that root and not from the document.
            const scope = element.getRootNode ? element.getRootNode() : document;
            const label = scope.querySelector(`label[for="${escapeCssString(element.id)}"]`);
            const labelText = label ? nameText(label.textContent) : "";
            if (labelText) return labelText;
        }

        // Alt text for images
        const alt = nameText(element.alt);
        if (alt) return alt;

        // Title attribute. A role named by its content only falls back to it
        // below: title is a tooltip, so `<a title="Read the full story">Read
        // more</a>` is "Read more" and the title is what is left when the
        // content says nothing.
        const fromContent = NAME_FROM_CONTENT_ROLES.has(getRole(element));
        const title = nameText(element.title);
        if (title && !fromContent) return title;

        // Placeholder for inputs
        const placeholder = nameText(element.placeholder);
        if (placeholder) return placeholder;

        // Name from content (WAI-ARIA). Without it a link such as
        // `Human <b>Brain</b> Organoids` has no name, and the tree shows only
        // its own text nodes ("Human  Organoids") with "Brain" as a separate
        // child, so the label reads out of order or, when every word sits in a
        // child, not at all.
        if (fromContent) {
            const text = contentName(element);
            if (text) return text;
            if (title) return title;
        }

        return null;
    }

    // Roles whose name is the text they contain, per the ARIA name-from-content
    // list, limited to the ones a page uses as controls and landmarks of text.
    // Rows and cells are left out on purpose: a table row named by its whole
    // row would repeat every cell's text on every row of the tree.
    const NAME_FROM_CONTENT_ROLES = new Set([
        "link", "button", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
        "option", "treeitem", "heading", "switch", "checkbox", "radio", "tooltip",
    ]);

    // ARIA lets an embedded control contribute its value to the name around it.
    // Here it contributes nothing: the snapshot withholds the value of a
    // password or card field, and a name is the one other place it could leak.
    const NAME_SKIPPED_TAGS = new Set(["input", "textarea", "select"]);

    // Their text is code or markup the browser never shows. The default
    // stylesheet hides all four, but a page can restyle them to display, and
    // `textContent` reads their contents either way.
    const NEVER_RENDERED_TAGS = new Set(["script", "style", "noscript", "template"]);

    // Block-level children are separate runs of text, so `<div>A</div><div>B</div>`
    // reads "A B" and not "AB". Inline ones stay joined.
    function startsNewRun(element) {
        const display = window.getComputedStyle(element).display;
        return display !== "inline" && display !== "contents";
    }

    // The children a user sees under an element: its open shadow root in place
    // of its light children, and a slot's assigned nodes (text included) in
    // place of the slot's own.
    function renderedChildNodes(element) {
        if (element.shadowRoot) return Array.from(element.shadowRoot.childNodes);
        if (typeof element.assignedNodes === "function") {
            return element.assignedNodes({ flatten: true });
        }
        return Array.from(element.childNodes);
    }

    // The ARIA text alternative of an element's content, in document order.
    // This walks the nodes rather than reading innerText so that it follows
    // the same rules as the rest of the snapshot: whatever isVisible drops
    // (aria-hidden, display:none) contributes nothing, and form controls are
    // skipped by tag. An icon `<svg aria-hidden>` beside a label therefore
    // does not pollute the name. It stays cheap because it stops once it has
    // more than a name can hold.
    function contentName(element) {
        const parts = [];
        let length = 0;
        const add = (part) => {
            parts.push(part);
            length += part.length;
        };
        const walk = (node, depth) => {
            // Padding spaces collapse when the parts are joined, so allow
            // headroom before declaring the name long enough.
            if (length > MAX_TEXT_CHARS * 2 || depth > MAX_TREE_DEPTH) return;
            if (node.nodeType === Node.TEXT_NODE) {
                add(node.textContent);
                return;
            }
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            if (!isVisible(node)) return;
            const tag = node.tagName.toLowerCase();
            if (NAME_SKIPPED_TAGS.has(tag) || NEVER_RENDERED_TAGS.has(tag)) return;
            // A nested element that names itself (an icon with aria-label, an
            // image with alt) is read by that name rather than by its insides.
            const label = nameText(node.getAttribute("aria-label") || node.alt);
            const separate = startsNewRun(node);
            if (separate) add(" ");
            if (label) add(label);
            else for (const child of renderedChildNodes(node)) walk(child, depth + 1);
            if (separate) add(" ");
        };
        for (const child of renderedChildNodes(element)) walk(child, 0);
        return truncateText(parts.join("").replace(/\s+/g, " ").trim());
    }

    // ─── Rendered Text ───────────────────────────────────────────────

    // Past this the walk below gives up on a subtree rather than risk the call
    // stack on a pathologically deep page. Well beyond MAX_TREE_DEPTH, because
    // text targeting worked on deep pages before the snapshot's own limit
    // existed for it.
    const MAX_RENDERED_DEPTH = 500;

    // Every element the snapshot would show, with the text a user sees in it,
    // for which `test(element, text)` holds, in document order. `text` has its
    // whitespace collapsed and is lower case, so that source indentation and
    // capitals do not decide a match. Each result also names its `parent`
    // entry, which lets a caller tell which matches enclose which, across
    // shadow and slot boundaries that `parentElement` stops at.
    //
    // `textContent` is the wrong thing to match on. It includes the text of
    // hidden children, script and style, so `<button>Cancel<span hidden>Delete
    // account</span></button>` was found by "Delete account" and clicked. This
    // follows the same rules as the tree: whatever `isVisible` drops is pruned
    // with everything under it, the children are the flattened ones, and a
    // form control contributes no text of its own.
    function renderedElements(test) {
        const root = document.body || document.documentElement;
        const matched = [];
        let order = 0;
        const walk = (element, depth, parent) => {
            if (depth > MAX_RENDERED_DEPTH || !isVisible(element)) return "";
            const tag = element.tagName.toLowerCase();
            if (NEVER_RENDERED_TAGS.has(tag)) return "";

            const entry = { element, parent, order: order++ };
            let text = "";
            if (!NAME_SKIPPED_TAGS.has(tag)) {
                for (const child of renderedChildNodes(element)) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        text += child.textContent;
                    } else if (child.nodeType === Node.ELEMENT_NODE) {
                        const run = walk(child, depth + 1, entry);
                        text += run && startsNewRun(child) ? ` ${run} ` : run;
                    }
                }
            }
            entry.text = text.replace(/\s+/g, " ").trim().toLowerCase();
            // The body itself is never offered: it holds everything, and so
            // matches whatever any element does.
            if (parent && test(element, entry.text)) matched.push(entry);
            return text;
        };
        if (root) walk(root, 0, null);
        return matched.sort((a, b) => a.order - b.order);
    }


    Object.assign(mcp, { deepQueryAll, deepQueryFirst, getAccessibleName, getPageText, getRole, readPage, renderedElements, takeSnapshot, truncateText });
})();
