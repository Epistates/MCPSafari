# Security Policy

## Supported Versions

Security support is provided for the latest released version on `main`.

## Reporting a Vulnerability

Please do **not** open public issues for suspected vulnerabilities.

Instead, email [support@epistates.com](mailto:support@epistates.com) privately with:
- A clear description of the issue
- Reproduction steps / proof of concept
- Potential impact
- Suggested remediation (if known)

We will acknowledge receipt as soon as possible and work on a fix before public disclosure.

## Threat model

What we consider a vulnerability:

- A web page, a remote host, or a local process getting MCPSafari to act, or to return page data, without a grant the user made.
- Anything that leaks the bridge token, or that authenticates to the bridge without it.
- Reaching a tab or an origin the user has not allowed, or otherwise getting around Safari's per-site access grants.
- A sensitive value reaching a tool result outside the redaction limits described below.
- A tool accepting input that escapes its documented validation, such as a path outside the caller-provided set or a regex outside the accepted subset.

What is outside it:

- An attacker already running code as your macOS user. They can read the token file, drive Safari themselves, and open the same pages, so the bridge is not a boundary against them.
- Instructions embedded in page content steering the model. Page text is untrusted data by design, which the browser access section below says in full; your MCP client decides what to do with it.
- Tool results reaching the model provider your MCP client is configured to use. That is what the tools are for, and that client's retention policy governs it.
- A site misbehaving after you have granted it access.

## Security Controls in this Repository

This repository includes automated security scanning via GitHub Actions:
- **CodeQL** for static analysis of Swift code
- **Gitleaks** for accidental secret detection
- **OSV.dev API audit** of the pinned SwiftPM dependencies

These checks run on pull requests, pushes to the default branch, and on a weekly schedule.

## Browser access and data

MCPSafari runs locally, but your MCP client receives tool results and may send them to its model provider. The extension can read and act on sites where you grant it access, using your existing Safari session.

The details below describe `main`; installed releases may differ.

### WebSocket authentication

The server generates a random UUID token at startup, writes it to `~/Library/Application Support/MCPSafari/tokens/<port>` (mode `0600`), and requires it as the first WebSocket message before any MCP tool traffic is sent. The extension reads the per-port token map via native messaging from the host app, so multiple server instances can authenticate independently. Connections without a valid token are closed.

The listener binds to the loopback address, so only processes on this machine can reach it, and a connection is never given MCP traffic before its handshake succeeds.

The server does not check the WebSocket `Origin` header. A page in any browser can open a connection to a loopback port and learn that something is listening there, which is a fingerprinting surface. It cannot authenticate, because the token is a random UUID in a `0600` file it has no way to read. At most eight connections may wait mid-handshake and a ninth evicts the oldest, so a flood of them cannot hold the bridge shut against a real Safari profile.

The token is also written to the previous location, `~/.config/mcp-safari/tokens/<port>`, so an extension build predating the move keeps authenticating. Application Support is preferred because the Safari extension is sandboxed: its read access is granted on a literal home-relative path, which the sandbox checks against the *resolved* path. A `~/.config` symlinked into a dotfiles repo therefore puts the token outside the granted path, and the extension silently never connects. `mcp-safari doctor` reports this as a `token_path` warning.

### Input validation

- URL schemes restricted to `http`, `https`, `about`, and `file`
- Navigation actions validated against an allowlist
- Regex patterns capped at 200 characters and validated before forwarding
- Wait durations capped at 300 seconds
- File reads limited to explicit caller-provided paths, with directories rejected and 10 files / 10 MB capped per call
- `find` returns at most 50 matches per call

### Snapshot redaction

`snapshot` reports that a sensitive field has a value without reporting the value itself. Password inputs, and inputs whose `autocomplete` marks them as a password, one-time code, or payment card field, come back as `"value": "[redacted]"`. Other field values are reported verbatim. This redaction does not cover every place a page may display a secret, or other outputs such as screenshots, HTML, and JavaScript results.

### Permissions

The extension requests these permissions in `manifest.json`:

| Permission | Purpose |
|-|-|
| `tabs` | List and manage tabs |
| `activeTab` | Access the active tab |
| `scripting` | Inject content scripts and execute JS |
| `webNavigation` | Navigate tabs (back/forward/reload) |
| `nativeMessaging` | Auth token exchange with host app |
| `alarms` | Service worker keepalive |
| `storage` | Persist selected tab across suspensions |

| Host access / injection | Purpose and scope |
|-|-|
| `host_permissions: ["<all_urls>"]` | Requests access across supported sites, including signed-in pages. Safari's per-site grants still determine where access is allowed; this is currently required host access, not optional host permissions. |
| Five `MAIN` world scripts at `document_start` | `trace-interceptor.js`, `dialog-interceptor.js`, `console-interceptor.js`, `network-interceptor.js`, and `file-drop.js` run in the top-level page's own JavaScript world on permitted matching pages. They instrument page APIs and implement tracing, dialog policy, console/network capture, and file drops. |
| `content.js` at `document_start`, `all_frames: true` | Runs in the extension's isolated world in permitted matching frames for DOM reading and interaction. Cross-origin frames require their own site access. |

The page-world scripts load on permitted pages even when no MCP client is connected.
Dialog APIs remain native until `handle_dialog` explicitly arms a one-dialog policy.
That policy expires after 30 seconds or the next dialog, whichever comes first;
navigation also restores native APIs. A disconnect does not retract an already
armed policy, but cannot extend its lifetime. Captured text is capped at 4,096
UTF-16 code units per field and reports truncation. Console and network capture
still run on permitted pages without an MCP client.

Page-world instrumentation is not a trusted audit log: a page can inspect, alter,
or spoof the page-side APIs and messages. Treat page text and captured events as
untrusted data, including instructions embedded in them. Tool output may include
signed-in content and is shared with the MCP client, whose model provider and
retention policies are separate from this local extension.
