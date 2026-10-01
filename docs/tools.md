# Tools and usage

[Back to README](../README.md) · [Setup](setup.md)

This reference describes `main`, which may include tools and options not yet in a published release. See [Releases](https://github.com/Epistates/MCPSafari/releases) for the documentation at your installed version.

## Tools (27)

### Diagnostics

| Tool | Description |
|-|-|
| `status` | Report listener, authenticated bridge, version, token health, and connected Safari profiles without requiring a Safari connection |

### Tab management

| Tool | Description |
|-|-|
| `tabs_context` | List open tabs across every connected Safari profile, with handles, URLs, and titles |
| `tabs_create` | Open a new tab, optionally with a URL |
| `close_tab` | Close a tab by handle |
| `select_tab` | Pin a tab, and its Safari profile, as the default context for future calls |

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

Use `native: true` with `type_text`, `press_key`, `hover`, or `drag` when the page needs real macOS input. Safari must already be in front, and the app running the server needs Accessibility permission. Native input takes over your keyboard and mouse, so tool descriptions and errors tell agents to ask you before bringing Safari to the front. If you want agents to do that on their own, say so in your agent instructions. Native `type_text` types one character at a time and is not paste. Native hover and drag move your real pointer; screen coordinates assume 100% page zoom. `click` uses synthetic events and has no native mode. Running JavaScript does not make an event trusted.

### Dialogs

| Tool | Description |
|-|-|
| `handle_dialog` | Arm the next dialog (30-second expiry), or read its captured result |

### Screenshots

| Tool | Description |
|-|-|
| `screenshot` | Capture the visible tab area as a PNG image, with viewport, scale, page visibility, and window focus; `uid`/`selector` crop to one element plus `padding` CSS px, `scale` shrinks the PNG, and `filePath` saves it to disk and returns the path instead of inline image data |

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

### Tab handles

`tabId` is a handle such as `p0t5`, meaning tab 5 of profile 0. Read handles out of `tabs_context` rather than composing them.

Safari runs a separate, complete instance of the extension in every profile, and each instance numbers its own tabs, so tab 5 names a different page in each one. The handle carries the profile the way an element UID carries its frame. Omit `tabId` to act on the selected tab of the selected profile.

Naming a profile that is not connected fails with `profile_not_connected` rather than falling back to another one, because answering from a different browser window is worse than refusing.

### Element targeting

Targeting options vary by tool. `click` accepts all four:

| Strategy | Example | When to Use |
|-|-|-|
| **UID** | `uid: "f0e42"` | Most precise — from a `snapshot` |
| **CSS selector** | `selector: "#login-btn"` | When you know the DOM structure |
| **Text** | `text: "Sign In"` | Interactive elements are ranked higher |
| **Coordinates** | `x: 100, y: 200` | Last resort — click at exact position |

Text resolves to one element or fails. An exact match beats a longer label that contains the text, and a control beats plain text. When several elements still tie, the call fails with `ambiguous_target` and lists their UIDs.

A synthetic `click` or `hover` hit-tests the middle of the target's visible part first. It fails with `target_covered` when something else is there, such as a modal, a cookie banner, or the page behind a `pointer-events: none` control, and names that element. It fails with `target_not_visible` when no part of the target is inside the viewport after scrolling. `force: true` dispatches anyway. Coordinates target whatever is at the point, so they never fail this way. The check runs inside the target's own frame, so an overlay drawn by a parent page over an iframe is not detected.

### Shadow DOM

Every targeting strategy reaches into open shadow roots, so pages built on web components (Lit, Stencil, Salesforce Lightning, most design-system elements) are readable and clickable. `snapshot` follows the flattened tree the user actually sees, so content passed into a `<slot>` is reported once, where the slot places it.

Closed shadow roots are unreadable by any API. Rather than reporting such an element as empty, `snapshot` marks it `"shadowClosed": true` so a missing control is distinguishable from one the tools cannot see.

### Iframes

Iframe content is readable and clickable. `snapshot` returns the whole tab as one tree, hanging each frame's document on the `<iframe>` that hosts it, and `find` searches every frame.

No tool takes a frame argument. A UID names the frame that minted it (`f3e12` is element 12 in frame 3), so targeting by UID routes automatically; targeting by selector or text searches frames in order, top frame first. Frames are matched to their host `<iframe>` by resolved `src`, and a frame whose host cannot be identified is attached to the parent tree and counted in `unmatchedFrames` rather than dropped.

A frame that will not answer at all is named in `unreachableFrames` on the root of the snapshot, one entry per frame with its `frameId` and `origin` (`null` for `about:` and sandboxed frames, which have no origin to grant). The key is absent when every frame answered. The usual cause is website access: **Always Allow on This Website** covers the top-level page only, so a page with third-party frames reads as top-frame-only until the broad grant is given. Treat a non-empty list as a partial page, since the tree is otherwise indistinguishable from a complete one.

Three limits are worth knowing. Native input (`native: true`) reaches the top frame only, because a subframe measures elements in its own viewport and cannot read a cross-origin parent's offset; it fails with `invalid_input` rather than clicking the wrong point. `screenshot` refuses a `uid` or `selector` inside an iframe for the same reason. `read_console` and `read_network` report the top frame only.

### Website access

Safari grants extensions access one site at a time, and it asks the first time MCPSafari touches a site it has no answer for. That question is a modal dialog, and **it can open behind another window**. While it is unanswered, every extension call for that tab is blocked.

So a tool that needs a page it has not been granted fails with `permission_required` rather than waiting. There are two versions of it, and the difference matters:

- The dialog is open and waiting. The message says so and names the origin. Tell the user to look for the dialog, including behind other windows, and choose **Always Allow on This Website** or **Allow for One Day**.
- Access was refused, or was never asked for on this origin. Tell the user to grant it from the MCPSafari button in Safari's toolbar, or in Safari Settings > Extensions > MCPSafari Extension.

Both are `retryable`, because the same call works once access is granted. Granting every site at once is one click: **Always Allow on Every Website** in that same settings pane. That is also the only way to reach cross-origin iframes, since Safari's per-site grant covers the top-level page only.

### Results

Every successful tool result includes an object in `structuredContent`, alongside the existing `content` text or image blocks. The object envelope is required by the negotiated MCP 2025-11-25 protocol; its payload may contain arrays, objects, strings, numbers, booleans, or null.

| Tools | Structured fields |
|-|-|
| `status` | `status` with listener, authentication and profile details |
| `tabs_context` | `tabs` and `profileFailures`; an incomplete listing names the missing profiles |
| `tabs_create`, `select_tab`, `close_tab` | `tab`, with the profile-qualified handle; close returns `id` and `closed` |
| `read_page`, `snapshot`, `find` | `page`, `snapshot`, `matches` respectively |
| `read_console`, `read_network` | `messages`, `requests` respectively |
| `javascript_tool`, interaction and navigation tools | `result`; interactions can additionally return `wait`, `trace`, and `snapshot` when requested and supported |
| `wait`, `resize_window` | `wait`, `window` respectively |
| `screenshot` | `screenshot` metadata, including MIME type, byte count, scale, available capture context, and `filePath` when saved; PNG bytes remain in the image block or file |
| `run_steps` | `results`, `completedSteps`, `failedStep`, plus requested `trace` and `snapshot`; each completed step includes its own structured result |

`read_page` text and HTML always remain strings, including literal `42`, `null`, `{}`, or `[]`. Snapshot format returns data. `javascript_tool` decodes JSON primitives as their actual types; legacy replies carrying explanatory text (such as an isolated-world fallback note) remain strings so that context is preserved.

No `outputSchema` is declared yet. Result shapes are documented here and covered by protocol-level tests, but may evolve before 1.0. Clients should ignore unknown fields. A future declared schema will require every corresponding result to conform.

### Failures

Every tool failure carries a stable `code`, a human-readable `message`, a `retryable` flag, and a `recoveryAction` naming what to do next:

| `recoveryAction` | Meaning |
|-|-|
| `fix_input` | The arguments were wrong. Correct them and call again. |
| `retry` | Transient. The same call may work. |
| `ask_user` | Needs a person: grant website access, or allow Safari to come to the front. |
| `call_status` | Check `status` for the bridge, the connected profiles, and token health. |
| `list_tools` | The tool name is not one this server has. |
| `inspect_error` | Nothing automatic to do; read the message. |
| `inspect_batch_result` | A `run_steps` batch stopped partway; read the per-step results. |
| `grant_accessibility_to_mcp_client` | Native input needs Accessibility for the app running `mcp-safari`. |

A `bridge_timeout` means no reply arrived before the deadline; the browser operation may already have completed. It is not automatically retryable. Inspect the target state before repeating a click, submission, upload, or JavaScript call. Canceling a request stops the server waiting, but cannot retract work already sent to Safari.

### Safari profiles

Every enabled profile is driven from the same server. `tabs_context` asks all of them and returns one merged listing, and each tool call goes to the profile its handle names.

`status` lists the connected profiles: `handle` is the `p0` prefix their tabs carry, `id` is the opaque `SFExtensionProfileKey` UUID Safari assigns (`default` for the default profile), and one profile is marked `selected`, which is where a call naming no tab lands. Safari exposes no profile *name* to an extension and no way to ask which profile is frontmost, so the default is the default profile when it is connected, then the earliest to connect. `select_tab` moves it, and it falls through to the next profile if the pinned one goes away.

A profile that fails to answer `tabs_context` is named in the result rather than dropped, so a short listing is not mistaken for a closed tab.

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
  "tabId": "p0t42",
  "steps": [
    { "tool": "navigate", "arguments": { "url": "https://example.com" } },
    { "tool": "wait", "arguments": { "text": "Example Domain" } }
  ],
  "trace": true,
  "includeSnapshot": true
}
```

The batch stops at the first structured failure and reports `completedSteps`, `failedStep`, and ordered step results. Completed browser actions are not rolled back. Batch-level trace and snapshot options produce one trace and one final snapshot rather than one artifact per step.

### Dialog automation

Call `handle_dialog` before triggering an alert, confirm, or prompt. It arms one
dialog for up to 30 seconds; the next dialog consumes the policy and restores native
APIs. Call it again to read the captured result (this does not rearm). Already-open
native dialogs require user interaction. Navigation clears an armed policy; a
disconnect leaves it armed only until its existing deadline. Captured fields are
limited to 4,096 UTF-16 code units with `truncated: true` when shortened.

### Capture and filter limits

Console messages retain at most 8,192 UTF-16 code units; network string fields retain
at most 2,048. Shortened records have `truncated: true`. Console object serialization
also limits traversal and arguments; omitted values are marked. Existing count
limits (1,000 console messages, 500 network requests and 500 resource entries) apply.

`pattern` and `urlPattern` support a bounded regex subset: literals, dots, anchors,
character classes, escaped characters, and alternation, up to 200 characters.
Repetition (`*`, `+`, `?`, `{}`), groups, and backreferences are rejected, as are
invalid patterns. Filter rejection never silently returns unfiltered data. For
example, use `error|warning` or `^https://example\.com/` rather than `(error)+`.

The bridge accepts up to 128 in-flight requests and 32 MiB per WebSocket message.
File uploads retain their separate 10 MiB aggregate file limit. Large captures may
need narrower selectors, fewer results, or smaller screenshots.
