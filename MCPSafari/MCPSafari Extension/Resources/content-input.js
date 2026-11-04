/**
 * Clicking and entering values: clicks, React-compatible value setting,
 * typing, form fills and select options.
 */

(() => {
    const mcp = window.__mcpSafari;
    if (!mcp || mcp.loaded.has("input")) return;
    mcp.loaded.add("input");
    const { assertPageFocused, assertReachable, clipText, deepQueryFirst, elementAtPoint, eventInit, firesKeypress, keyboardEvent, mouseEvent, pointerEvent, resolveElement, scrollToTarget, toolError } = mcp;

    // ─── Click ───────────────────────────────────────────────────────

    function clickElement(params) {
        // Click by coordinates
        if (params.x !== undefined && params.y !== undefined) {
            const el = elementAtPoint(params.x, params.y);
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
        return `Clicked <${desc}>${el.textContent ? ': "' + clipText(el.textContent.trim(), 50) + '"' : ""}`;
    }

    function simulateClick(element, doubleClick, point) {
        const { x, y } = point;

        const eventOpts = {
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
            if (pressed && element.dispatchEvent(mouseEvent("mousedown", { ...eventOpts, buttons: 1 }))) {
                element.focus();
            }
            element.dispatchEvent(pointerEvent("pointerup", pointerOpts));
            if (pressed) element.dispatchEvent(mouseEvent("mouseup", eventOpts));
            element.dispatchEvent(mouseEvent("click", eventOpts));
        };

        element.dispatchEvent(pointerEvent("pointerover", pointerOpts));
        element.dispatchEvent(mouseEvent("mouseover", eventOpts));
        press();

        if (doubleClick) {
            press();
            element.dispatchEvent(mouseEvent("dblclick", eventOpts));
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
        el.dispatchEvent(new Event("input", eventInit("input")));
        el.dispatchEvent(new Event("change", eventInit("change")));
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
            inputType: value === "" ? "deleteContentBackward" : "insertText",
            data: value || null,
        };
        const before = new InputEvent("beforeinput", eventInit("beforeinput", detail));
        if (el.dispatchEvent(before)) {
            el.textContent = append ? el.textContent + value : value;
        }
        el.dispatchEvent(new InputEvent("input", eventInit("input", detail)));
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
        // After the check above, which only says which element the page thinks
        // is active: with the address bar focused that stays true.
        assertPageFocused(`native typing into <${tag}>`);
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
            };
            // A page that handles the key cancels it, and the browser then does
            // nothing more with it. That includes the submission below.
            let handled = !el.dispatchEvent(keyboardEvent("keydown", keyOpts));
            if (!handled && firesKeypress(params.submitKey, keyOpts)) {
                handled = !el.dispatchEvent(keyboardEvent("keypress", keyOpts));
            }
            el.dispatchEvent(keyboardEvent("keyup", keyOpts));

            if (params.submitKey === "Enter" && !handled) submitImplicitly(el);
        }

        return `Typed "${text}" into <${el.tagName.toLowerCase()}>${params.submitKey ? ` then pressed ${params.submitKey}` : ""}`;
    }

    // Enter in a text field submits its form, by the HTML implicit submission
    // rules. A bare `requestSubmit()` is not that: it submitted from a textarea,
    // which takes Enter as a newline, and it skipped the form's default button,
    // so the click handlers and the submitter the page expected never ran.
    //
    // These are the types the spec calls fields that block implicit submission.
    const IMPLICIT_SUBMIT_TYPES = new Set([
        "text", "search", "url", "tel", "email", "password",
        "date", "month", "week", "time", "datetime-local", "number",
    ]);

    function submitImplicitly(field) {
        const form = field.form;
        if (!form || field.tagName.toLowerCase() !== "input" || !IMPLICIT_SUBMIT_TYPES.has(field.type)) return;

        const controls = Array.from(form.elements);
        const isSubmitButton = (control) => {
            const tag = control.tagName.toLowerCase();
            return (tag === "button" && control.type === "submit")
                || (tag === "input" && (control.type === "submit" || control.type === "image"));
        };

        // With a submit button, Enter clicks the first one, and a disabled one
        // means the form does not submit at all.
        const defaultButton = controls.find(isSubmitButton);
        if (defaultButton) {
            if (!defaultButton.disabled) defaultButton.click();
            return;
        }

        // Without one, Enter submits only when it cannot be ambiguous which
        // field it was meant for.
        const typed = controls.filter(
            (control) => control.tagName.toLowerCase() === "input" && IMPLICIT_SUBMIT_TYPES.has(control.type)
        );
        if (typed.length <= 1) form.requestSubmit();
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
        const failed = [];

        for (const [selector, value] of entries) {
            const el = deepQueryFirst(selector);
            if (!el) {
                missing.push(selector);
                results.push(`${selector}: not found`);
                continue;
            }
            // One field that cannot take its value is reported with the others,
            // not thrown: the fields before it are already filled, and an error
            // would hide that.
            try {
                el.focus();
                fillField(el, value);
                results.push(`${selector}: filled`);
            } catch (error) {
                failed.push(selector);
                results.push(`${selector}: ${error.message}`);
            }
        }

        // A partial fill still reports per-field results, but filling nothing is a
        // failure rather than a success whose body happens to say "not found".
        if (missing.length + failed.length === entries.length) {
            if (failed.length > 0) {
                throw toolError(
                    "invalid_input",
                    `No form field could be filled: ${results.join("; ")}`,
                    false,
                    "fix_input"
                );
            }
            throw toolError(
                "target_not_found",
                `No form fields matched: ${missing.join(", ")}`,
                false,
                "take_snapshot"
            );
        }

        return results.join("\n");
    }

    // A text control takes the value as typed; a select takes the option it
    // names, by value or else by label. Anything else has nowhere to put it,
    // and the native setters would throw an "Illegal invocation" for it.
    function fillField(el, value) {
        const tag = el.tagName.toLowerCase();
        if (tag === "select") {
            const byValue = Array.from(el.options).some((option) => option.value === String(value));
            chooseOption(el, byValue ? { value } : { label: String(value) });
        } else if (tag === "input" || tag === "textarea" || el.isContentEditable) {
            setInputValue(el, value, false);
        } else {
            throw toolError("invalid_input", `<${tag}> is not a fillable field`, false, "fix_input");
        }
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

        chooseOption(el, params.value !== undefined ? { value: params.value } : { label: params.label });
        const target = params.uid || params.selector || params.label || "select";
        return `Selected option in ${target}`;
    }

    const optionDisabled = (option) => option.disabled
        || (option.parentElement?.tagName === "OPTGROUP" && option.parentElement.disabled === true);

    // Selects the option itself rather than assigning the select's `value`,
    // which picks the first option carrying that value (the wrong one, where a
    // label is what told them apart) and cannot tell a disabled option from any
    // other. A user cannot choose a disabled option, so neither can this. The
    // events are the ones a real choice fires, in order.
    function chooseOption(select, { value, label }) {
        const byValue = value !== undefined;
        const matches = Array.from(select.options).filter(
            (option) => (byValue ? option.value === String(value) : option.textContent.trim() === label)
        );
        if (matches.length === 0) {
            throw toolError(
                "target_not_found",
                byValue ? `No option with value "${value}" in <select>` : `Option with label "${label}" not found`,
                false,
                "take_snapshot"
            );
        }
        const option = matches.find((candidate) => !optionDisabled(candidate));
        if (!option) {
            throw toolError(
                "invalid_input",
                `The option ${byValue ? `with value "${value}"` : `labelled "${label}"`} in <select> is disabled`,
                false,
                "fix_input"
            );
        }

        // A multiple select ends up with just this option, as assigning its
        // value always left it; a single one drops its old choice by itself.
        if (select.multiple) {
            for (const other of select.options) other.selected = other === option;
        } else {
            option.selected = true;
        }
        select.dispatchEvent(new Event("input", eventInit("input")));
        select.dispatchEvent(new Event("change", eventInit("change")));
    }


    Object.assign(mcp, { clickElement, formInput, prepareNativeInput, selectOption, typeText });
})();
