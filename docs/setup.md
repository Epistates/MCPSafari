# Setup and troubleshooting

[Back to README](../README.md) · [Tool reference](tools.md)

These instructions describe `main`. For an installed release, use the documentation at its tag in [Releases](https://github.com/Epistates/MCPSafari/releases).

## Installation

### Homebrew (recommended)

Installs the MCP server binary and the Safari extension app to `/Applications`.

```bash
brew trust epistates/tap
brew install --cask epistates/tap/mcp-safari
```

The `brew trust` line is needed once. Installing a cask auto-trusts the cask itself, but this cask depends on the `mcp-safari-server` formula, and a differently named dependency in the same tap is not covered by that. Without it the install stops at `Refusing to load formula epistates/tap/mcp-safari-server from untrusted tap`.

Upgrading:

```bash
brew upgrade --cask epistates/tap/mcp-safari
```

Open MCPSafari.app once so Safari picks up the extension, then enable it in **Safari > Settings > Extensions > MCPSafari Extension**.

### From release

If you don't use Homebrew, download both the CLI binary and the extension app from [GitHub Releases](https://github.com/Epistates/MCPSafari/releases):

| Asset | Description |
|-|-|
| `MCPSafari-Server-arm64-apple-darwin` | MCP server binary for Apple Silicon (M1, M2, M3, M4) |
| `MCPSafari-Server-x86_64-apple-darwin` | MCP server binary for Intel Macs |
| `MCPSafari-Server-universal-apple-darwin` | MCP server binary — universal, runs on any Mac |
| `MCPSafari-Extension-arm64.tar.gz` | Safari extension app for Apple Silicon (M1, M2, M3, M4) |
| `MCPSafari-Extension-x86_64.tar.gz` | Safari extension app for Intel Macs |

```bash
# Apple Silicon (M1/M2/M3/M4) — use x86_64 for Intel Macs
curl -L -o /usr/local/bin/mcp-safari https://github.com/Epistates/MCPSafari/releases/latest/download/MCPSafari-Server-arm64-apple-darwin
chmod +x /usr/local/bin/mcp-safari

# Safari extension (must be in /Applications for macOS 26+)
curl -L https://github.com/Epistates/MCPSafari/releases/latest/download/MCPSafari-Extension-arm64.tar.gz | tar xzf -
mv MCPSafari.app /Applications/
open /Applications/MCPSafari.app
```

Then enable the extension in **Safari > Settings > Extensions > MCPSafari Extension**.

### From source

See [development](development.md) for build requirements and commands.

## Configuration

### Codex CLI

Register the server with Codex CLI:

```bash
codex mcp add mcp-safari -- mcp-safari
```

If `mcp-safari` is not in your `$PATH`, use the full path to the server binary:

```bash
codex mcp add mcp-safari -- /usr/local/bin/mcp-safari
```

Verify the registration:

```bash
codex mcp list
codex mcp get mcp-safari
```

Start a new Codex CLI session after registering the server. MCPSafari uses the MCP stdio transport, so use `--` before the command; `--url` is only for streamable HTTP MCP servers.

### Claude Code

Register the server with the Claude Code CLI (user scope, available in every project):

```bash
claude mcp add --scope user mcp-safari mcp-safari
```

Or, to scope it to a single repo, create `.mcp.json` at the project root:

```json
{
  "mcpServers": {
    "mcp-safari": {
      "command": "mcp-safari"
    }
  }
}
```

Verify with `claude mcp list` — you should see `mcp-safari — ✓ Connected`.

Claude Code does not read `mcpServers` from `~/.claude/settings.json`. Use `claude mcp add` or `.mcp.json`; otherwise, the client will not start the server.

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-safari": {
      "command": "mcp-safari"
    }
  }
}
```

### Cursor / Windsurf / other MCP clients

Any client that supports the MCP stdio transport can connect. Point it at `mcp-safari` (or the full path if not in `$PATH`).

### Multiple MCP clients

Each MCP client starts its own server. The server finds a free port if 8089 is in use, and the extension discovers servers in the 8089–8098 range. These connections share Safari tabs and browser state.

For ports outside the default range, set the port in the client configuration and add it in the extension popup:

```json
{
  "mcpServers": {
    "mcp-safari": {
      "command": "mcp-safari",
      "args": ["--port", "9090"]
    }
  }
}
```

### Safari profiles

Safari runs a separate instance of the extension in every profile it is enabled for, each with its own background page and its own tabs. All of them connect to the same server. The server keeps one connection per profile and lists them under `profiles` in `status`.

Tool calls drive a single profile: the default one when it is connected, otherwise the first to connect. Naming a profile in a tool call is not supported yet, so if you want to automate a non-default profile, turn the extension off in the profiles you are not driving. Safari exposes no profile *name* to extensions, so `status` identifies profiles by the opaque UUID Safari assigns them.

### CLI options

| Flag | Description |
|-|-|
| `--port <n>` / `-p <n>` | WebSocket port (default: `8089`) |
| `--log-level <level>` | `trace`, `debug`, `info`, `notice`, `warning`, `error`, or `critical` (default: `notice`) |
| `--verbose` | Shorthand for `--log-level debug` |

Logs go to stderr. The default level is `notice`; use `--log-level info` for startup and connection messages, or `--verbose` for debug logs. Clients that pass environment variables but not arguments can set `MCP_SAFARI_LOG_LEVEL`. An explicit flag takes precedence.

Diagnose an installation without starting the MCP server:

```bash
mcp-safari doctor
mcp-safari doctor --json
```

The doctor checks the server executable, app and extension bundles, PlugInKit registration, matching versions, and the selected port's token file. It never returns token contents and does not change system state.

## Troubleshooting

### Extension shows "Disconnected"

1. Run `mcp-safari doctor` and address any failed checks. If your version has no `doctor` command, continue with the steps below.
2. Check your MCP client logs to confirm it started the server.
3. Enable the extension in Safari settings, then click "Reconnect" in its popup.
4. Start the server through your client with `--verbose` to see connection logs.

### "Could not establish connection" errors

The content scripts may not be injected yet. The extension auto-injects on first interaction, but you can also reload the page.

### Safari permission prompts

Safari prompts for per-site permissions the first time the extension interacts with a domain. Click "Always Allow on Every Website" in Safari > Settings > Extensions > MCPSafari Extension to avoid repeated prompts.

### Port already in use

The server tries other ports automatically. To choose a port outside 8089–8098, set `--port` and add that port in the extension popup. See [multiple MCP clients](#multiple-mcp-clients).
