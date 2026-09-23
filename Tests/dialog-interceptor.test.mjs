import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
const source = readFileSync(new URL("../MCPSafari/MCPSafari Extension/Resources/dialog-interceptor.js", import.meta.url), "utf8");
function harness() {
    const native = { alert: () => undefined, confirm: () => "native", prompt: () => "native" };
    const window = { ...native, addEventListener() {}, postMessage() {} };
    let expire;
    vm.runInNewContext(source, { window, Date, setTimeout: (fn) => { expire = fn; }, clearTimeout() {} });
    return { window, native, expire: () => expire() };
}
test("ordinary browsing keeps native dialogs and one armed dialog restores them", () => {
    const { window, native } = harness();
    assert.equal(window.confirm, native.confirm);
    assert.equal(window.confirm("normal"), "native");
    assert.equal(window.__mcpHandleDialog({ action: "accept" }).armed, true);
    assert.equal(window.confirm("automated"), true);
    assert.equal(window.confirm, native.confirm);
    const result = window.__mcpHandleDialog({ action: "dismiss" });
    assert.equal(result.handled, true);
    assert.equal(result.message, "automated");
    assert.equal(window.confirm, native.confirm, "reading a result must not arm another policy");
});
test("expiry restores native APIs without overwriting subsequent page patches", () => {
    const h = harness();
    h.window.__mcpHandleDialog({ action: "dismiss" });
    const pagePatch = () => "page";
    h.window.confirm = pagePatch;
    h.expire();
    assert.equal(h.window.confirm, pagePatch);
    assert.equal(h.window.prompt, h.native.prompt);
});
test("captured dialog text is bounded and reports truncation", () => {
    const { window } = harness();
    window.__mcpHandleDialog({ action: "accept", promptText: "answer" });
    assert.equal(window.prompt("x".repeat(100_000), "y".repeat(100_000)), "answer");
    const result = window.__mcpHandleDialog({ action: "dismiss" });
    assert.equal(result.message.length, 4096);
    assert.equal(result.defaultValue.length, 4096);
    assert.equal(result.truncated, true);
});
