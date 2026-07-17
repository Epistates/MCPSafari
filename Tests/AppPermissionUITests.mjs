import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const scriptSource = readFileSync(
  new URL("../MCPSafari/MCPSafari/Resources/Script.js", import.meta.url),
  "utf8",
);

function appHarness() {
  const classes = new Set();
  const messages = [];
  const listeners = new Map();
  const context = vm.createContext({
    document: {
      body: {
        classList: {
          remove: (...names) => names.forEach((name) => classes.delete(name)),
          toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
        },
      },
      getElementsByClassName: () => [{ innerText: "" }],
      querySelector: (selector) => ({
        addEventListener: (event, listener) => listeners.set(`${selector}:${event}`, listener),
      }),
    },
    webkit: {
      messageHandlers: {
        controller: {
          postMessage: (message) => messages.push(message),
        },
      },
    },
  });

  vm.runInContext(scriptSource, context);
  return { classes, context, listeners, messages };
}

test("Accessibility button opens settings guidance", () => {
  const { listeners, messages } = appHarness();

  listeners.get("button.enable-native-input:click")();

  assert.deepEqual(messages, ["enable-native-input"]);
});
