# Tools and usage

[Back to README](../README.md) · [Setup](setup.md)

This reference describes `main`, which may include tools and options not yet in a published release. See [Releases](https://github.com/Epistates/MCPSafari/releases) for the documentation at your installed version.

## Tools (27)

### Diagnostics

| Tool | Description |
|-|-|
| `status` | Report listener, authenticated bridge, version, and token health without requiring a Safari connection |

### Tab management

| Tool | Description |
|-|-|
| `tabs_context` | List all open tabs with IDs, URLs, and titles |
| `tabs_create` | Open a new tab, optionally with a URL |
| `close_tab` | Close a tab by ID |
| `select_tab` | Pin a tab as the default context for future calls |

### Navigation

| Tool | Description |
|-|-|
| `navigate` | Go to a URL, or use `back` / `forward` / `reload` actions |

### Page reading

| Tool | Description |
|-|-|
| `read_page` | Get page content as `text`, `html`, or `snapshot` |
| `snapshot` | Accessibility tree with element UIDs for interaction |
| `find` | Find elements by CSS selector, visible text or accessible name, or ARIA role (up to 50 matches) |

### Interaction

| Tool | Description |
|-|-|
| `click` | Click by UID, CSS selector, text, or coordinates |
| `type_text` | Type into an element with optional `clearFirst` and `submitKey`; `native: true` sends macOS key events |
| `form_input` | Batch fill form fields (CSS selector → value map) |
| `select_option` | Select a dropdown option by value or label |
| `scroll` | Scroll page or element in any direction |
| `press_key` | Press key combinations (e.g., `Enter`, `Meta+a`, `Control+c`); `native: true` sends a real macOS key event |
| `hover` | Hover to trigger tooltips, menus, or hover handlers (pointer + mouse events); `native: true` moves the real OS pointer for true `:hover` |
| `drag` | Drag and drop between elements along an interpolated pointer path; `native: true` performs a real macOS mouse drag |
| `upload_file` | Attach local files to an `<input type="file">` |
| `drop_file` | Drop local files onto an element |

### Synthetic and native input

By default, interaction tools send synthetic DOM events. These reach page event handlers, but they do not trigger browser shortcuts, clipboard actions, or CSS `:hover`. Text entry uses setters and editing events that update application state.

Use `native: true` with `type_text`, `press_key`, `hover`, or `drag` when the page needs real macOS input. Safari must already be in front, and the app running the server needs Accessibility permission. Native hover and drag move your real pointer; screen coordinates assume 100% page zoom. `click` uses synthetic events and has no native mode. Running JavaScript does not make an event trusted.

### Dialogs

| Tool | Description |
|-|-|
| `handle_dialog` | Accept or dismiss alerts, confirms, and prompts |

### Screenshots

| Tool | Description |
|-|-|
| `screenshot` | Capture the visible tab area as a PNG image, with viewport, scale, page visibility, and window focus; `filePath` saves it to disk and returns the path instead of inline image data |

### JavaScript

| Tool | Description |
|-|-|
| `javascript_tool` | Execute arbitrary JS in the page context and return expression results; multi-statement code must end in an explicit `return` to produce a value |

If a site's Content Security Policy blocks string evaluation, the tool retries in the extension's isolated world and reports that in the result. It can still access the DOM there, but cannot read the page's JavaScript globals, such as framework instances on `window`. The CSP rejection happens before the submitted code runs.

### Debugging

| Tool | Description |
|-|-|
| `read_console` | Read console messages with level and regex filtering |
| `read_network` | Read captured XHR/fetch requests or opt-in resource timings with type, URL-regex, and count filtering |

Console and network capture run in the page's JavaScript context. Pages can observe or change this data, so it is not an independent record of browser activity.

`read_network` with `type: "resource"` reports PerformanceObserver timings. Entries have no HTTP status or request/response headers. Capture does not include WebSocket traffic or redirect chains. For cross-origin resources without `Timing-Allow-Origin`, byte counts and connection timings are zeroed and marked `timingRestricted: true`; `startTime` and `duration` remain available.

### Window

| Tool | Description |
|-|-|
| `resize_window` | Resize the browser window to specific dimensions |

### Utility

| Tool | Description |
|-|-|
| `run_steps` | Run up to 10 interaction or wait steps sequentially, stopping on the first failure |
| `wait` | Wait for a duration, CSS selector, or text to appear |

## Usage

### Basic workflow

1. Call `tabs_context` to see open tabs, or `tabs_create` to open a URL in a new tab.
2. Call `snapshot` to get the accessibility tree and element UIDs.
3. Use those UIDs with `click`, `type_text`, or `hover`.
4. Check the result with `includeSnapshot: true` on the action, or take a `screenshot`.

### Element targeting

Targeting options vary by tool. `click` accepts all four:

| Strategy | Example | When to Use |
|-|-|-|
| **UID** | `uid: "e42"` | Most precise — from a `snapshot` |
| **CSS selector** | `selector: "#login-btn"` | When you know the DOM structure |
| **Text** | `text: "Sign In"` | Interactive elements are ranked higher |
| **Coordinates** | `x: 100, y: 200` | Last resort — click at exact position |

### Form filling

Use `form_input` to fill multiple fields at once:

```json
{
  "fields": {
    "#name": "Jane Doe",
    "#email": "jane@example.com",
    "textarea[name=message]": "Hello!"
  }
}
```

This uses React-compatible value setting (`nativeInputValueSetter`) so it works with controlled inputs in React, Next.js, and similar frameworks.

### File upload and drop

`upload_file` attaches local files to a file input, and `drop_file` delivers them to a drop zone:

```json
{ "selector": "input[type=file]", "filePath": "~/Pictures/reference.png" }
```

```json
{ "selector": "#dropzone", "filePaths": ["/tmp/a.pdf", "/tmp/b.pdf"] }
```

The server reads only the paths you name, infers each MIME type from the file extension (override with `mimeType`), and sends the bytes to the page. `upload_file` accepts the input itself, its `<label>`, or a wrapper containing it, then fires `input` and `change`; `drop_file` dispatches `dragenter`, `dragover`, and `drop` with a `DataTransfer` holding the files. Up to 10 files and 10 MB total per call.

### Smart text matching

When targeting by `text`, interactive elements (buttons, links, inputs) are ranked higher than generic containers. Clicking `text: "Submit"` will prefer a `<button>Submit</button>` over a `<div>Submit</div>`.

### Post-action snapshots

Most interaction tools support `includeSnapshot: true`, which returns the updated accessibility tree after the action — useful for verifying the result without a separate `snapshot` call.

### Post-action waits

`navigate` and interaction tools support `waitForSelector`, `waitForText`, and `waitTimeout` to wait after a successful action before returning. When combined with `includeSnapshot: true`, the snapshot is captured after the wait.

### Page traces

Interaction tools support `trace: true` and `traceDuration` to return a short page trace after the action. Use `eventTypes` for an exact-match allowlist such as `["dom.mutation", "network.fetch"]`; omit it to capture all URL/history, console, fetch/XHR, and DOM mutation events during the action window.

### Bounded action batches

Use `run_steps` for a fixed sequence of existing interactions and waits with a shared default tab:

```json
{
  "tabId": 42,
  "steps": [
    { "tool": "navigate", "arguments": { "url": "https://example.com" } },
    { "tool": "wait", "arguments": { "text": "Example Domain" } }
  ],
  "trace": true,
  "includeSnapshot": true
}
```

The batch stops at the first structured failure and reports `completedSteps`, `failedStep`, and ordered step results. Completed browser actions are not rolled back. Batch-level trace and snapshot options produce one trace and one final snapshot rather than one artifact per step.
