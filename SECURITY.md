# Security Policy

## Supported Versions

Security support is provided for the latest released version on `main`.

## Reporting a Vulnerability

Please do **not** open public issues for suspected vulnerabilities.

Instead, email the maintainer privately with:
- A clear description of the issue
- Reproduction steps / proof of concept
- Potential impact
- Suggested remediation (if known)

We will acknowledge receipt as soon as possible and work on a fix before public disclosure.

## Security Controls in this Repository

This repository includes automated security scanning via GitHub Actions:
- **CodeQL** for static analysis of Swift code
- **Gitleaks** for accidental secret detection
- **OSV-Scanner** for vulnerable dependency detection

These checks run on pull requests, pushes to the default branch, and on a weekly schedule.

## Browser access and data

MCPSafari runs locally, but your MCP client receives tool results and may send them to its model provider. The extension can read and act on sites where you grant it access, using your existing Safari session.

The details below describe `main`; installed releases may differ.

### WebSocket authentication

The server generates a random UUID token at startup, writes it to `~/Library/Application Support/MCPSafari/tokens/<port>` (mode `0600`), and requires it as the first WebSocket message before any MCP tool traffic is sent. The extension reads the per-port token map via native messaging from the host app, so multiple server instances can authenticate independently. Connections without a valid token are closed.

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
