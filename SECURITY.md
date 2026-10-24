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
- **CodeQL** for static analysis of the Swift server and the extension JavaScript
- **Gitleaks** for accidental secret detection
- **OSV.dev API audit** of the pinned SwiftPM dependencies

These checks run on pull requests, pushes to the default branch, and on a weekly schedule.

Release assets from v0.4.0 onward carry a signed SLSA build provenance attestation, minted by the
release workflow through Sigstore. `gh attestation verify <file> --repo Epistates/MCPSafari` ties a
downloaded file back to the workflow run and commit that produced it, which a checksum cannot do.
Every workflow action is pinned by commit SHA, and dependency resolution is locked to
`Package.resolved`.

A release is built only from a commit that is on `main` and has passed the test suites and the
dependency audit. Both products are built before the signing certificate is imported, so build-time
code never runs with the key present. Each shipped archive is then unpacked and its signature,
notarization ticket, team, hardened runtime and entitlements are checked again. The signing secrets
sit in a protected `release` environment that needs a reviewer's approval; see
[Repository settings](docs/development.md#repository-settings).

## Browser access and data

MCPSafari runs locally, but your MCP client receives tool results and may send them to its model provider. The extension can read and act on sites where you grant it access, using your existing Safari session.

The details below describe `main`; installed releases may differ.

### WebSocket authentication

The server generates a random UUID token at startup and writes it to `~/Library/Application Support/MCPSafari/tokens/<port>` (mode `0600`). The extension reads the per-port token map via native messaging from the host app, so multiple server instances can authenticate independently. The token never crosses the WebSocket. Each side proves it holds the token by returning an HMAC-SHA256 over both sides' fresh nonces, keyed with the token, and the extension checks the server's proof before it sends its own:

1. The extension sends `hello` with a random 32-byte `clientNonce`, its version, the bridge protocol version and its Safari profile id.
2. The server answers with a `challenge`: a random 32-byte `serverNonce` and `serverProof`, the HMAC of `mcpsafari-v<N>-server|<port>|<clientNonce>|<serverNonce>`.
3. The extension verifies `serverProof` with WebCrypto, which compares in constant time. If it does not verify, the extension closes the connection, sends nothing further, and acts on no frame from that peer.
4. Otherwise it sends `clientProof`, the HMAC of `mcpsafari-v<N>-client|<port>|<serverNonce>|<clientNonce>`.
5. The server checks `clientProof` in constant time and answers `auth: ok`, or `auth: error` with `token_mismatch` and closes.

The two proofs carry different labels and take the nonces in opposite orders, so neither can be reflected back as the other. Each includes the port and fresh nonces from both sides, so a captured exchange cannot be replayed on another connection or against another server. Any frame other than the expected next step closes the connection, and the mid-handshake slot cap and deadline below cover the whole exchange, not just the first frame. A peer that merely listens on a port, or one that dials the extension, learns nothing from the exchange that lets it impersonate either side: before this protocol, the extension sent the token in its first frame and treated any `auth: ok` as proof of the server, so a process that had taken a port the extension was configured for received the token and could then be driven as if it were the server. That cannot happen now.

The proofs authenticate the handshake, not the stream that follows: later frames are neither signed nor encrypted. The listener is loopback-only, and a process that can sit between the two ends of a loopback connection is a process running as the user or as root, which the threat model above treats as out of scope.

Bridge protocol 2 does not interoperate with 0.3.x: a 0.3.x extension is told to update, and its token, which it sends in the clear, is only compared. A 0.4 extension dialling a 0.3.x server is closed without a message, because that server cannot parse the new hello. Install matching app and `mcp-safari` versions together.

The extension is sandboxed, and its only file grant is read access to that `tokens/` directory. It passes a file on to the background script only if the file is a regular file of at most 256 bytes holding a UUID, opened without following a symlink, and only if its name is a canonical port number. Anything else in the directory is skipped. The host app holds no file grants at all. An unknown native message gets a fixed error rather than an echo, and a missing token is reported as a code with no paths in it.

The token file is removed when the server stops, including on SIGTERM, SIGINT and SIGHUP. A server that is killed outright cannot remove it, so each token file has a `<port>.pid` file beside it naming the owning process, and a starting server deletes the token files whose recorded owner is no longer running. A token with no owner record is left alone, since nothing proves its server is gone.

The listener binds to the loopback address, so only processes on this machine can reach it, and a connection is never given MCP traffic before its handshake succeeds.

The server refuses a WebSocket upgrade whose `Origin` header is present and is not a `safari-web-extension://` one. Browsers do not apply same-origin to WebSockets, so a page in any browser can open a connection to a loopback port, and Safari sends `Origin: safari-web-extension://<per-profile UUID>` for the extension, as measured on a real run. The host part is a UUID that changes when the extension is reinstalled, so only the scheme is checked. A request with no `Origin` is admitted, since that is a client with no browser behind it, such as a test harness. A refused page is told so at the upgrade and holds no handshake slot afterwards. This is not what authenticates: a page that could somehow present the right origin still cannot complete the handshake without the token, which is a random UUID in a `0600` file it has no way to read, and a page can still learn that something is listening on a port by the refusal, which is a fingerprinting surface. At most eight connections may wait mid-handshake and a ninth is refused, so a flood of them cannot evict a real Safari profile that is partway through its handshake. A connection that has not authenticated within two seconds is closed, which frees its slot; the extension sends its handshake within milliseconds of opening. The first frame of an unauthenticated connection is also capped at 4 KiB and is closed without being decoded if it is larger. The listener's own message limit is far higher because tool responses need it, and it cannot differ per connection.

Tokens are written only under `~/Library/Application Support/MCPSafari/`. Earlier releases also wrote `~/.config/mcp-safari/tokens/<port>` and a single shared `token` file, so that extension builds predating per-port tokens could still authenticate. Both are gone: those builds cannot speak the current bridge protocol, and a second copy of the secret in a shared, replaceable file was a cost without a user. Application Support is used because the Safari extension is sandboxed: its read access is granted on a literal home-relative path, which the sandbox checks against the *resolved* path. A directory under `~/.config` that is symlinked into a dotfiles repo puts the token outside the granted path, and the extension silently never connects. `mcp-safari doctor` reports a symlinked token directory as a `token_path` warning.

### Input validation

- URL schemes restricted to `http`, `https`, `about`, and `file`, judged after the normalization the browser applies (leading and trailing control characters and spaces dropped, tabs and newlines removed), and the normalized URL is what is sent
- Navigation actions validated against an allowlist
- Optional arguments of the wrong type rejected with `invalid_input`, never read as absent, so a mistyped filter cannot return unfiltered data and a mistyped flag cannot fall back to its default
- Regex patterns held to the bounded subset (at most 200 UTF-16 code units, no repetition, groups, or backreferences) and validated by the server before forwarding, so the check does not depend on the page-world filter, which a page can rewrite
- Wait durations capped at 300 seconds
- File reads limited to explicit caller-provided paths, with directories rejected and 10 files / 10 MB capped per call
- `upload_file` and `drop_file` refuse any file inside the bridge token directories (`~/Library/Application Support/MCPSafari/` and `~/.config/mcp-safari/`). The check is made on the open descriptor's resolved path, so symlinks, including a symlinked `~/.config`, and different spellings of the same path do not get around it. `navigate` and `tabs_create` apply the same rule to `file:` URLs after resolving symlinks, so Safari cannot be pointed at the token and `read_page` cannot return it
- `screenshot` `filePath` must end in `.png`; an existing target must be a regular file that already begins with the PNG signature (symlinks and other files are refused, so it cannot overwrite `~/.zshrc` or a key), the token directories are refused, new files are created `0600`, and the write is a rename of a finished temporary file
- `find` returns at most 50 matches per call
- `maxChars`, `maxNodes` and `maxResults` clamped to documented maxima, so a caller cannot ask for unbounded output

### Snapshot redaction

`snapshot` reports that a sensitive field has a value without reporting the value itself. An `<input>` or `<textarea>` comes back as `"value": "[redacted]"` when any of these holds:

- Its type is `password`, in any letter case.
- Its `autocomplete` carries `current-password`, `new-password`, `one-time-code`, `cc-number`, `cc-csc`, `cc-exp`, `cc-exp-month`, or `cc-exp-year`, alone or among other tokens such as `section-x cc-csc`.
- It was a password field at any point while the page has been open. A show-password toggle flips the field to `type="text"`, so the extension watches `type` changes from page load and remembers the field.
- Its `name`, `id`, `aria-label`, `inputmode`, or `autocomplete` names a secret: a word such as `pass`, `pwd`, `pin`, `otp`, `cvv`, `cvc`, `ssn`, `secret`, `token`, or `2fa`, or a longer run containing `password`, `passcode`, `secret`, `token`, or `one-time`. Whole words are matched for the short ones, so `shipping` and `passenger` stay readable. Checkboxes, radio buttons, and buttons are exempt from this name test because their value is a fixed label rather than something typed.

A sensitive `<textarea>` also loses its default text from the snapshot, which would otherwise repeat what the value redaction withholds.

The name test is a heuristic, so a secret under a name nobody has thought of is reported verbatim, and a field that was toggled out of password type inside a shadow root before the first snapshot reached that root is caught only by its name. Other field values are reported verbatim. This redaction does not cover every place a page may display a secret, or other outputs such as screenshots, HTML, and JavaScript results.

### Tab URL redaction

A tab's URL is reported by `tabs_context`, `tabs_create`, `select_tab`, and `navigate`, and an OAuth callback or a presigned download carries its credential in the query or fragment. Those values come back as `[redacted]`: bearer and session parameters by name (`token`, `access_token`, `session`, `jwt`, `signature`, `X-Amz-Signature`, and the rest), plus `code` when `state` sits alongside it, since `code` on its own is more often a SKU than an OAuth code.

Matching is on the whole parameter name, so a name that describes a secret rather than carrying one stays readable: `token_type=bearer` and `password_hint` are reported as they are. Two limits follow from that. The list is maintained by hand, so a credential under a name nobody has thought of is reported verbatim, and only the query and fragment are considered, so a secret in the path is not redacted.

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
