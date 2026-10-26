import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { extensionSource } from "./helpers/extension-sources.mjs";

// The rule for which form fields hold secrets is written twice. The snapshot
// applies it in the extension's isolated world and the trace interceptor in the
// page's own world, and neither can read the other's scope. These tests are the
// reason that is tolerable: the two copies must be the same text, and both must
// behave the same way.

const BEGIN = "// BEGIN sensitive-field-rule";
const END = "// END sensitive-field-rule";

function ruleBlock(file) {
    const text = extensionSource(file);
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    assert.ok(start !== -1 && end > start, `${file} should mark the sensitive field rule`);
    return text.slice(start + BEGIN.length, end).trim();
}

const COPIES = ["content-snapshot.js", "trace-interceptor.js"];

function loadRule(file) {
    const context = vm.createContext({});
    vm.runInContext(`${ruleBlock(file)}\nthis.isSensitiveField = isSensitiveField;`, context);
    return context.isSensitiveField;
}

test("the snapshot and trace copies of the rule are the same text", () => {
    assert.equal(ruleBlock("content-snapshot.js"), ruleBlock("trace-interceptor.js"));
});

const CASES = [
    // [descriptor, sensitive]
    [{ tag: "input", type: "password", autocomplete: null, hints: [] }, true],
    [{ tag: "input", type: "PASSWORD", autocomplete: null, hints: [] }, true],
    [{ tag: "input", type: "text", autocomplete: "section-x cc-csc", hints: [] }, true],
    [{ tag: "input", type: "text", autocomplete: "one-time-code", hints: [] }, true],
    [{ tag: "textarea", type: undefined, autocomplete: null, hints: ["recovery_secret"] }, true],
    [{ tag: "input", type: "text", autocomplete: null, hints: ["confirmPassword"] }, true],
    [{ tag: "input", type: "tel", autocomplete: null, hints: [null, "", "Enter your PIN"] }, true],
    [{ tag: "input", type: "text", autocomplete: null, hints: ["OTPCode"] }, true],
    [{ tag: "input", type: "text", autocomplete: null, hints: ["shipping"] }, false],
    [{ tag: "input", type: "text", autocomplete: null, hints: ["passenger", "compass", "bypass"] }, false],
    [{ tag: "input", type: "checkbox", autocomplete: null, hints: ["remember_token"] }, false],
    [{ tag: "input", type: "submit", autocomplete: null, hints: ["token"] }, false],
    [{ tag: "div", type: "password", autocomplete: null, hints: ["token"] }, false],
    [{ tag: "select", type: "text", autocomplete: "cc-number", hints: [] }, false],
];

for (const file of COPIES) {
    test(`${file} classifies fields the same way`, () => {
        const isSensitiveField = loadRule(file);
        for (const [descriptor, expected] of CASES) {
            assert.equal(
                isSensitiveField(descriptor),
                expected,
                `${JSON.stringify(descriptor)} should be ${expected ? "sensitive" : "readable"}`
            );
        }
    });
}
