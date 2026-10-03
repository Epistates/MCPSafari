/**
 * Turning a uid, selector or text into one element, and deciding whether a
 * real pointer could reach it.
 */

(() => {
    const mcp = window.__mcpSafari;
    if (!mcp || mcp.loaded.has("target")) return;
    mcp.loaded.add("target");
    const { allRoots, deepQueryAll, deepQueryFirst, getAccessibleName, getElementByUid, getRole, getUid, isVisible, toolError, walkRootFor } = mcp;

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
            for (const el of deepQueryAll(params.selector, MAX_FIND_RESULTS)) {
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
            for (const root of allRoots()) {
                if (results.length >= MAX_FIND_RESULTS) break;
                const walkRoot = walkRootFor(root);
                if (!walkRoot) continue;
                const walker = document.createTreeWalker(
                    walkRoot,
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
        }

        if (params.role) {
            for (const el of deepQueryAll("*")) {
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
        const needle = text.trim().toLowerCase();
        const matches = [];
        for (const root of allRoots()) {
            const walkRoot = walkRootFor(root);
            if (!walkRoot) continue;
            const walker = document.createTreeWalker(
                walkRoot,
                NodeFilter.SHOW_ELEMENT,
                {
                    acceptNode: (node) =>
                        node.textContent &&
                        node.textContent.toLowerCase().includes(needle) &&
                        isVisible(node) &&
                        node.getClientRects().length > 0
                            ? NodeFilter.FILTER_ACCEPT
                            : NodeFilter.FILTER_SKIP,
                }
            );
            let node;
            while ((node = walker.nextNode())) matches.push(node);
        }
        const enclosing = new Set();
        for (const node of matches) {
            for (let up = node.parentElement; up && !enclosing.has(up); up = up.parentElement) {
                enclosing.add(up);
            }
        }
        const innermost = matches.filter((node) => !enclosing.has(node));
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
        const scored = innermost.map((node) => {
            // Act on the control that holds the text, as a real click would focus it.
            const control = node.closest(INTERACTIVE_SELECTOR);
            const exact = node.textContent.trim().replace(/\s+/g, " ").toLowerCase() === needle;
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
            return `${desc.uid} <${desc.tag}> "${(desc.name || desc.text || "").substring(0, 40)}"`;
        });
        const more = top.length > listed.length ? `, and ${top.length - listed.length} more` : "";
        throw toolError(
            "ambiguous_target",
            `Text "${text}" matches ${top.length} elements equally: ${listed.join("; ")}${more}. Target one by uid.`,
            false,
            "fix_input"
        );
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

    Object.assign(mcp, { aimPoint, assertReachable, findElements, resolveElement, scrollToTarget });
})();
