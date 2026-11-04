/**
 * Turning a uid, selector or text into one element, and deciding whether a
 * real pointer could reach it.
 */

(() => {
    const mcp = window.__mcpSafari;
    if (!mcp || mcp.loaded.has("target")) return;
    mcp.loaded.add("target");
    const { clipText, deepQueryAll, deepQueryFirst, getAccessibleName, getElementByUid, getRole, getUid, renderedElements, toolError, truncateText } = mcp;

    // ─── Element Finding ─────────────────────────────────────────────

    // One cap for every match strategy, so a broad selector cannot return an
    // unbounded result set and swamp the caller's context.
    const MAX_FIND_RESULTS = 50;

    // What the rendered text of an element is compared with: the same
    // whitespace collapsing and lower case that renderedElements applies to it.
    const collapseText = (text) => text.trim().replace(/\s+/g, " ").toLowerCase();

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
            for (const el of deepQueryAll(params.selector, MAX_FIND_RESULTS)) {
                results.push(describeElement(el));
            }
        }

        if (params.text) {
            const needle = collapseText(params.text);
            // Also match the accessible name, so an icon button labelled only
            // by aria-label is reachable by the name snapshots report for it.
            const matches = renderedElements((node, text) =>
                text.includes(needle) ||
                getAccessibleName(node)?.toLowerCase().includes(needle)
            );
            for (const { element, text } of matches) {
                if (results.length >= MAX_FIND_RESULTS) break;
                // Only include leaf-ish elements (avoid returning <body> etc.)
                if (element.children.length === 0 || text.length < 200) {
                    results.push(describeElement(element));
                }
            }
        }

        if (params.role) {
            for (const { element } of renderedElements((node) => getRole(node) === params.role)) {
                if (results.length >= MAX_FIND_RESULTS) break;
                results.push(describeElement(element));
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
            ? clipText(element.textContent.trim(), 100)
            : "";

        const desc = { uid, tag };
        if (role) desc.role = role;
        if (name) desc.name = name;
        if (text && text !== name) desc.text = text;
        if (element.id) desc.id = truncateText(element.id);
        if (element.className && typeof element.className === "string") {
            desc.className = clipText(element.className, 100);
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
            const el = deepQueryFirst(params.selector);
            if (!el)
                throw toolError(
                    "target_not_found",
                    `No element found for selector: ${params.selector}`,
                    false,
                    "take_snapshot"
                );
            return el;
        }

        if (params.text) return resolveByText(params.text);

        return null;
    }

    // Elements a click anywhere inside activates. A focusable [tabindex]
    // container is not one: a click on one child does not reach another.
    const INTERACTIVE_SELECTOR =
        'button, a, input, select, textarea, summary, [role="button"], [role="link"]';
    const MAX_LISTED_CANDIDATES = 5;

    // Every ancestor of a matching element matches too, so only the innermost
    // match on each branch is a candidate. Several equally good candidates are
    // refused: picking one would act on an element the caller may not mean.
    function resolveByText(text) {
        // Both sides have their whitespace collapsed, because source markup
        // wraps lines and indents between inline pieces while the name a
        // snapshot reports, which is what a caller copies from, does not.
        const needle = collapseText(text);
        // The text is what a user sees: a hidden child, a script or a style
        // inside a control does not make the control match.
        const matches = renderedElements((node, rendered) =>
            rendered.includes(needle) && node.getClientRects().length > 0
        );
        const enclosing = new Set();
        for (const { parent } of matches) {
            for (let up = parent; up && !enclosing.has(up.element); up = up.parent) {
                enclosing.add(up.element);
            }
        }
        const innermost = matches.filter((match) => !enclosing.has(match.element));
        if (innermost.length === 0)
            throw toolError(
                "target_not_found",
                `No element found with text: "${text}"`,
                false,
                "take_snapshot"
            );

        // Exact text beats a substring ("Save" over "Save as draft"), then a
        // control beats plain text (a "Delete" button over a "Delete" heading).
        // Scored in one pass: Math.max(...scores) passes one argument per match,
        // which overflows the call stack on a page with enough of them, and
        // scoring twice walked every candidate's ancestors twice over.
        let best = 0;
        const scored = innermost.map(({ element: node, text: rendered }) => {
            // Act on the control that holds the text, as a real click would focus it.
            const control = node.closest(INTERACTIVE_SELECTOR);
            const exact = rendered === needle;
            const value = (exact ? 2 : 0) + (control ? 1 : 0);
            if (value > best) best = value;
            return { target: control || node, value };
        });
        const top = [...new Set(
            scored.filter((entry) => entry.value === best).map((entry) => entry.target)
        )];
        if (top.length === 1) return top[0];

        const listed = top.slice(0, MAX_LISTED_CANDIDATES).map((node) => {
            const desc = describeElement(node);
            return `${desc.uid} <${desc.tag}> "${clipText(desc.name || desc.text || "", 40)}"`;
        });
        const more = top.length > listed.length ? `, and ${top.length - listed.length} more` : "";
        throw toolError(
            "ambiguous_target",
            `Text "${text}" matches ${top.length} elements equally: ${listed.join("; ")}${more}. Target one by uid.`,
            false,
            "fix_input"
        );
    }

    // `document.elementFromPoint` stops at a shadow host: it answers with the
    // host and never the button inside, so a coordinate click on a web
    // component landed on the component rather than on what the user sees. Each
    // open root is asked in turn, as a pointer would descend into it.
    function elementAtPoint(x, y) {
        let hit = document.elementFromPoint(x, y);
        while (hit && hit.shadowRoot) {
            const inner = hit.shadowRoot.elementFromPoint(x, y);
            if (!inner || inner === hit) break;
            hit = inner;
        }
        return hit;
    }

    // A synthetic event reaches its target even under a modal or a banner, so
    // without this a click no user could make would still report success.
    function assertReachable(element, point) {
        const tag = element.tagName.toLowerCase();
        if (!point.visible)
            throw toolError(
                "target_not_visible",
                `<${tag}> has no area inside the viewport, so a real pointer could not reach it.`,
                false,
                "take_snapshot"
            );
        const hit = element.getRootNode().elementFromPoint(point.x, point.y);
        // The hit may be decoration inside the control, not only inside the target.
        const control = element.closest(INTERACTIVE_SELECTOR) || element;
        if (hit && control.contains(hit)) return;
        // Styled checkboxes and radios hide the input under its label's content.
        if (hit?.closest("label")?.control === element) return;
        const desc = hit ? describeElement(hit) : null;
        throw toolError(
            "target_covered",
            `<${tag}> is covered at (${Math.round(point.x)}, ${Math.round(point.y)}) by ${desc ? `${desc.uid} <${desc.tag}>${desc.id ? `#${desc.id}` : ""}` : "nothing hit-testable"}. A real pointer would land there. Dismiss it first, or pass force: true to dispatch anyway.`,
            false,
            "take_snapshot"
        );
    }

    function scrollToTarget(element) {
        element.scrollIntoView({ behavior: "instant", block: "center" });
        return aimPoint(element);
    }

    // Aims at the middle of the element's part inside the viewport, so an
    // element wider or taller than the viewport is not aimed off-screen.
    // Separate from the scrolling because `drag` has two ends to scroll and
    // has to measure both of them once the page has stopped moving.
    function aimPoint(element) {
        const rect = element.getBoundingClientRect();
        const left = Math.max(rect.left, 0);
        const top = Math.max(rect.top, 0);
        const right = Math.min(rect.left + rect.width, window.innerWidth);
        const bottom = Math.min(rect.top + rect.height, window.innerHeight);
        const visible = right > left && bottom > top;
        return visible
            ? { x: (left + right) / 2, y: (top + bottom) / 2, visible }
            : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, visible };
    }

    // A caller-supplied point is not scrolled to: elementFromPoint already
    // proved it visible, and scrolling would move the element out from under it.

    Object.assign(mcp, { aimPoint, assertReachable, elementAtPoint, findElements, resolveElement, scrollToTarget });
})();
