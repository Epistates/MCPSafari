/**
 * Gestures and keys: scrolling, key presses, hover, drag, and the
 * measurements the native pointer path needs.
 */

(() => {
    const mcp = window.__mcpSafari;
    if (!mcp || mcp.loaded.has("gesture")) return;
    mcp.loaded.add("gesture");
    const { aimPoint, assertReachable, firesKeypress, keyCode, pointerEvent, resolveElement, scrollToTarget, toolError } = mcp;

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
        if (firesKeypress(key, eventOpts)) {
            target.dispatchEvent(new KeyboardEvent("keypress", eventOpts));
        }
        target.dispatchEvent(new KeyboardEvent("keyup", eventOpts));

        return `Pressed ${keyString}`;
    }

    // ─── Hover ───────────────────────────────────────────────────────

    function hoverElement(params) {
        let el = null;
        let x, y;
        if (params.x !== undefined && params.y !== undefined) {
            el = document.elementFromPoint(params.x, params.y);
            if (!el) {
                throw toolError(
                    "target_not_found",
                    `No element at coordinates (${params.x}, ${params.y})`,
                    false,
                    "take_snapshot"
                );
            }
            // elementFromPoint already proved the point is visible; scrolling
            // would move the element out from under the requested coordinates.
            x = params.x;
            y = params.y;
        } else {
            el = resolveElement(params);
            if (!el) {
                throw toolError(
                    "invalid_input",
                    "hover requires uid, selector, text, or x and y",
                    false,
                    "fix_input"
                );
            }
            const point = scrollToTarget(el);
            if (!params.force) assertReachable(el, point);
            ({ x, y } = point);
        }

        const eventOpts = {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: 0,
        };
        const pointerOpts = { ...eventOpts, pointerId: 1, pointerType: "mouse", isPrimary: true };

        // Real pointer order: pointer family first, over before enter.
        el.dispatchEvent(pointerEvent("pointerover", pointerOpts));
        el.dispatchEvent(pointerEvent("pointerenter", pointerOpts));
        el.dispatchEvent(new MouseEvent("mouseover", eventOpts));
        el.dispatchEvent(new MouseEvent("mouseenter", eventOpts));
        el.dispatchEvent(pointerEvent("pointermove", pointerOpts));
        el.dispatchEvent(new MouseEvent("mousemove", eventOpts));

        return `Hovered over <${el.tagName.toLowerCase()}> (synthetic events; CSS :hover is not applied)`;
    }

    // ─── Drag ────────────────────────────────────────────────────────

    async function dragElement(params) {
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

        // One gesture has to reach both ends, so both are scrolled to before
        // either is measured. The destination uses "nearest" so that a target
        // already on screen does not move the source back off it.
        fromEl.scrollIntoView({ behavior: "instant", block: "center" });
        toEl.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
        const from = aimPoint(fromEl);
        const to = aimPoint(toEl);
        if (!params.force) {
            assertReachable(fromEl, from);
            assertReachable(toEl, to);
        }

        const { x: fromX, y: fromY } = from;
        const { x: toX, y: toY } = to;

        const baseOpts = { bubbles: true, cancelable: true, view: window };
        const pointerBase = { ...baseOpts, pointerId: 1, pointerType: "mouse", isPrimary: true };

        let mutated = false;
        const observer = new MutationObserver((records) => {
            if (records.length > 0) mutated = true;
        });
        observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
        });

        // The observer watches the whole document, so it has to come back off
        // again on every exit path, not just the expected one.
        let pending = [];
        try {
            fromEl.dispatchEvent(pointerEvent("pointerdown", { ...pointerBase, clientX: fromX, clientY: fromY, button: 0, buttons: 1 }));
            fromEl.dispatchEvent(new MouseEvent("mousedown", { ...baseOpts, clientX: fromX, clientY: fromY, button: 0, buttons: 1 }));

            // Distance-threshold drag libraries (dnd-kit PointerSensor) only start
            // a drag after real movement; a single jump at the source never begins one.
            const dataTransfer = new DataTransfer();
            const steps = 8;
            for (let i = 1; i <= steps; i++) {
                const x = fromX + ((toX - fromX) * i) / steps;
                const y = fromY + ((toY - fromY) * i) / steps;
                fromEl.dispatchEvent(pointerEvent("pointermove", { ...pointerBase, clientX: x, clientY: y, button: 0, buttons: 1 }));
                fromEl.dispatchEvent(new MouseEvent("mousemove", { ...baseOpts, clientX: x, clientY: y, button: 0, buttons: 1 }));
                if (i === 1) {
                    fromEl.dispatchEvent(new DragEvent("dragstart", { ...baseOpts, clientX: fromX, clientY: fromY, dataTransfer }));
                }
                await new Promise((resolve) => setTimeout(resolve, 25));
            }

            toEl.dispatchEvent(new DragEvent("dragenter", { ...baseOpts, clientX: toX, clientY: toY, dataTransfer }));
            toEl.dispatchEvent(new DragEvent("dragover", { ...baseOpts, clientX: toX, clientY: toY, dataTransfer }));
            toEl.dispatchEvent(new DragEvent("drop", { ...baseOpts, clientX: toX, clientY: toY, dataTransfer }));
            toEl.dispatchEvent(pointerEvent("pointerup", { ...pointerBase, clientX: toX, clientY: toY, button: 0, buttons: 0 }));
            toEl.dispatchEvent(new MouseEvent("mouseup", { ...baseOpts, clientX: toX, clientY: toY, button: 0, buttons: 0 }));
            fromEl.dispatchEvent(new DragEvent("dragend", { ...baseOpts, clientX: toX, clientY: toY, dataTransfer }));

            // A gesture nothing reacted to is a silent no-op: give the page a
            // frame to respond, then fail rather than claim a drag that never started.
            await new Promise((resolve) => setTimeout(resolve, 50));
            pending = observer.takeRecords();
        } finally {
            observer.disconnect();
        }

        if (!mutated && pending.length === 0) {
            throw toolError(
                "input_not_applied",
                `Drag from <${fromEl.tagName.toLowerCase()}> to <${toEl.tagName.toLowerCase()}> produced no DOM change; the page may not have recognized the synthetic gesture`,
                false,
                "use_native_input"
            );
        }

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

        // x/y wins over uid/selector/text here exactly as it does for the
        // synthetic path, so native and synthetic hover land on the same point.
        const pointRequested = params.x !== undefined && params.y !== undefined;
        const fromEl = params.fromUid || params.fromSelector
            ? resolveElement({ uid: params.fromUid, selector: params.fromSelector })
            : (!pointRequested && (params.uid || params.selector || params.text))
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
        } else if (pointRequested) {
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


    Object.assign(mcp, { dragElement, hoverElement, nativePointerPoints, prepareNativeKey, pressKey, scrollPage });
})();
