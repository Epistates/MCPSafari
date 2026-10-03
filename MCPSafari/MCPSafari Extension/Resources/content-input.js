/**
 * Clicking and entering values: clicks, React-compatible value setting,
 * typing, form fills and select options.
 */

(() => {
    const mcp = window.__mcpSafari;
    if (!mcp || mcp.loaded.has("input")) return;
    mcp.loaded.add("input");
    const { assertReachable, deepQueryFirst, firesKeypress, pointerEvent, resolveElement, scrollToTarget, toolError } = mcp;

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
            simulateClick(el, params.doubleClick, { x: params.x, y: params.y });
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

        const point = scrollToTarget(el);
        if (!params.force) assertReachable(el, point);
        simulateClick(el, params.doubleClick, point);
        const desc = el.tagName.toLowerCase();
        return `Clicked <${desc}>${el.textContent ? ': "' + el.textContent.trim().substring(0, 50) + '"' : ""}`;
    }

    function simulateClick(element, doubleClick, point) {
        const { x, y } = point;

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

        // Real pointer order: pointer family first. Cancelling pointerdown
        // suppresses the compatibility mouse events and the focus change, which
        // is how pointer-driven toggles (Radix, Headless UI) keep a click from
        // re-toggling what pointerdown just opened.
        const press = () => {
            const pressed = element.dispatchEvent(pointerEvent("pointerdown", { ...pointerOpts, buttons: 1 }));
            if (pressed && element.dispatchEvent(new MouseEvent("mousedown", { ...eventOpts, buttons: 1 }))) {
                element.focus();
            }
            element.dispatchEvent(pointerEvent("pointerup", pointerOpts));
            if (pressed) element.dispatchEvent(new MouseEvent("mouseup", eventOpts));
            element.dispatchEvent(new MouseEvent("click", eventOpts));
        };

        element.dispatchEvent(pointerEvent("pointerover", pointerOpts));
        element.dispatchEvent(new MouseEvent("mouseover", eventOpts));
        press();

        if (doubleClick) {
            press();
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
            if (firesKeypress(params.submitKey, keyOpts)) {
                el.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
            }
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
            const el = deepQueryFirst(selector);
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


    Object.assign(mcp, { clickElement, formInput, prepareNativeInput, selectOption, typeText });
})();
