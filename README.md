<div align="center">
  <video src="https://github.com/user-attachments/assets/96566f48-a7b7-468b-bf96-8ca5c5c86da7" muted autoplay loop playsinline width="100%"></video>
</div>

# MCPSafari: Native Safari MCP Server for AI Agents
![Stars](https://img.shields.io/github/stars/Epistates/MCPSafari)
![MCP](https://img.shields.io/badge/MCP-2025-blue)
![macOS](https://img.shields.io/badge/macOS-14+-orange)
![Swift](https://img.shields.io/badge/Swift-6.1+-orange)
![Xcode](https://img.shields.io/badge/Xcode-16+-orange)

Give Claude, Cursor, or any MCP-compatible AI full native control of Safari on macOS. Navigate tabs, click/type/fill forms (even React), read HTML/accessibility trees, execute JS, capture screenshots, inspect console & network — all with 23 secure tools. Zero Chrome overhead, Apple Silicon optimized, token-authenticated, and built with official Swift + Manifest V3 Safari Extension.

## Why MCPSafari?

- Smarter element targeting (UID + CSS + text + coords + interactive ranking)
- Works flawlessly with complex sites
- Local & private (runs on your Mac)
- Perfect drop-in for Mac-first agent workflows

**macOS 14+** • **Safari 17+** • **Xcode 16+**

Built with the official [swift-sdk](https://github.com/modelcontextprotocol/swift-sdk) and a Manifest V3 Safari Web Extension.

## Why Safari over Chrome?
- 40–60% less CPU/heat on Apple Silicon  
- Keeps your existing Safari logins/cookies  
- Native accessibility tree (better than Playwright for complex UIs)

## How It Works

```
MCP Client (Claude, etc.)
        │ stdio
┌───────▼──────────────┐
│  Swift MCP Server    │
│  (MCPSafari binary)  │
└───────┬──────────────┘
        │ WebSocket (localhost:8089)
┌───────▼──────────────┐
│  Safari Extension    │
│  (background.js)     │
└───────┬──────────────┘
        │ content scripts
┌───────▼──────────────┐
│  Safari Browser      │
│  (macOS 14.0+)       │
└──────────────────────┘
```

The MCP server communicates with clients over **stdio** and bridges tool calls to the Safari extension over a local **WebSocket**. The extension executes actions via browser APIs and content scripts injected into pages.

## Requirements

- macOS 14.0 (Sonoma) or later
- Safari 17+
- Swift 6.1+ (for building from source)
- Xcode 16+ (for building the Safari extension)

## Installation

### Homebrew (recommended)

Installs the MCP server binary **and** the Safari extension app to `/Applications` in one step. Automatically cleans up any previous installation.

```bash
brew install --cask epistates/tap/mcp-safari
```

Upgrading:

```bash
brew upgrade --cask epistates/tap/mcp-safari
```

After install, enable the extension in **Safari > Settings > Extensions > MCPSafari Extension**.

### From Release

If you don't use Homebrew, download both the CLI binary and the extension app from [GitHub Releases](https://github.com/Epistates/MCPSafari/releases):

| Asset | Description |
|-------|-------------|
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

### From Source

```bash
git clone https://github.com/Epistates/MCPSafari.git
cd MCPSafari

# Build the MCP server
cd MCPServer
swift build -c release
# Binary is at .build/release/MCPSafari

# Build and open the Safari extension
cd ../MCPSafari
xcodebuild -project MCPSafari.xcodeproj -scheme MCPSafari build
open ~/Library/Developer/Xcode/DerivedData/MCPSafari-*/Build/Products/Debug/MCPSafari.app
```

Then enable the extension in **Safari > Settings > Extensions > MCPSafari Extension**.

## Configuration

### Claude Code

Add to your MCP settings (`.claude/settings.json` or project-level):

```json
{
  "mcpServers": {
    "mcp-safari": {
      "command": "mcp-safari"
    }
  }
}
```

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

### Cursor / Windsurf / Other MCP Clients

Any client that supports the MCP stdio transport can connect. Point it at `mcp-safari` (or the full path if not in `$PATH`).

### Multiple Claude Instances

Multiple MCP clients work automatically. The server auto-finds a free port if the default (8089) is in use, and the extension auto-discovers all servers in the 8089-8098 range. No configuration needed — just start multiple clients and they each get their own connection.

For ports outside the default range, add them manually in the extension popup or specify explicitly:

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

### CLI Options

| Flag | Description |
|------|-------------|
| `--port <n>` / `-p <n>` | WebSocket port (default: `8089`) |
| `--verbose` | Debug-level logging to stderr |

## Tools (23)

### Tab Management

| Tool | Description |
|------|-------------|
| `tabs_context` | List all open tabs with IDs, URLs, and titles |
| `tabs_create` | Open a new tab, optionally with a URL |
| `close_tab` | Close a tab by ID |
| `select_tab` | Pin a tab as the default context for future calls |

### Navigation

| Tool | Description |
|------|-------------|
| `navigate` | Go to a URL, or use `back` / `forward` / `reload` actions |

### Page Reading

| Tool | Description |
|------|-------------|
| `read_page` | Get page content as `text`, `html`, or `snapshot` |
| `snapshot` | Accessibility tree with element UIDs for interaction |
| `find` | Find elements by CSS selector, text, or ARIA role |

### Interaction

| Tool | Description |
|------|-------------|
| `click` | Click by UID, CSS selector, text, or coordinates |
| `type_text` | Type into an element with optional `clearFirst` and `submitKey` |
| `form_input` | Batch fill form fields (CSS selector → value map) |
| `select_option` | Select a dropdown option by value or label |
| `scroll` | Scroll page or element in any direction |
| `press_key` | Press key combinations (e.g., `Enter`, `Meta+a`, `Control+c`) |
| `hover` | Hover to trigger tooltips, menus, or hover states |
| `drag` | Drag and drop between elements |

### Dialogs

| Tool | Description |
|------|-------------|
| `handle_dialog` | Accept or dismiss alerts, confirms, and prompts |

### Screenshots

| Tool | Description |
|------|-------------|
| `screenshot` | Capture the visible tab area as a PNG image |

### JavaScript

| Tool | Description |
|------|-------------|
| `javascript_tool` | Execute arbitrary JS in the page context |

### Debugging

| Tool | Description |
|------|-------------|
| `read_console` | Read console messages with level and regex filtering |
| `read_network` | Read captured XHR/fetch requests with type filtering |

### Window

| Tool | Description |
|------|-------------|
| `resize_window` | Resize the browser window to specific dimensions |

### Utility

| Tool | Description |
|------|-------------|
| `wait` | Wait for a duration, CSS selector, or text to appear |

## Usage

### Basic Workflow

1. **Start with context** — call `tabs_context` to see what's open, or `navigate` to a URL.
2. **Take a snapshot** — call `snapshot` to get the accessibility tree with element UIDs.
3. **Interact** — use UIDs from the snapshot with `click`, `type_text`, `hover`, etc.
4. **Verify** — pass `includeSnapshot: true` on interaction tools to see the updated state, or take a `screenshot`.

### Element Targeting

Tools that interact with elements accept multiple targeting strategies:

| Strategy | Example | When to Use |
|----------|---------|-------------|
| **UID** | `uid: "e42"` | Most precise — from a `snapshot` |
| **CSS selector** | `selector: "#login-btn"` | When you know the DOM structure |
| **Text** | `text: "Sign In"` | Interactive elements are ranked higher |
| **Coordinates** | `x: 100, y: 200` | Last resort — click at exact position |

### Form Filling

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

### Smart Text Matching

When targeting by `text`, interactive elements (buttons, links, inputs) are ranked higher than generic containers. Clicking `text: "Submit"` will prefer a `<button>Submit</button>` over a `<div>Submit</div>`.

### Post-Action Snapshots

Most interaction tools support `includeSnapshot: true`, which returns the updated accessibility tree after the action — useful for verifying the result without a separate `snapshot` call.

## Architecture

### MCP Server (`MCPServer/`)

A Swift executable using the official [modelcontextprotocol/swift-sdk](https://github.com/modelcontextprotocol/swift-sdk). Communicates with MCP clients via **stdio** and with the Safari extension via a **WebSocket** bridge using `Network.framework`.

- `main.swift` — Entry point, parses CLI flags, starts the server
- `SafariMCPServer.swift` — Tool definitions and handlers (actor)
- `WebSocketBridge.swift` — WebSocket server with request/response correlation (actor)
- `BridgeMessage.swift` — Wire protocol types and `AnyCodable` serialization

### Safari Extension (`MCPSafari/`)

A Manifest V3 Safari Web Extension with:

- `background.js` — WebSocket client, request router, tab/navigation/screenshot handlers
- `content.js` — DOM interaction, accessibility snapshots, element finding, click/type/scroll simulation
- `dialog-interceptor.js` — Patches `window.alert/confirm/prompt` before page scripts run
- `console-interceptor.js` — Captures console messages for `read_console`
- `network-interceptor.js` — Captures XHR/fetch requests for `read_network`
- `popup.html/js/css` — Extension popup showing connection status

### macOS Host App

A minimal macOS app (`AppDelegate.swift`, `ViewController.swift`) that registers the Safari extension and provides native messaging for auth token exchange.

## Security

### WebSocket Authentication

The server generates a random UUID token at startup, writes it to `~/.config/mcp-safari/token` (mode `0600`), and requires it as the first WebSocket message. The extension reads the token via native messaging from the host app. Connections without a valid token are accepted in unauthenticated mode for development convenience.

### Input Validation

- URL schemes restricted to `http`, `https`, `about`, and `file`
- Navigation actions validated against an allowlist
- Regex patterns capped at 200 characters and validated before forwarding
- Wait durations capped at 300 seconds

### Permissions

The extension requests these permissions in `manifest.json`:

| Permission | Purpose |
|-----------|---------|
| `tabs` | List and manage tabs |
| `activeTab` | Access the active tab |
| `scripting` | Inject content scripts and execute JS |
| `webNavigation` | Navigate tabs (back/forward/reload) |
| `nativeMessaging` | Auth token exchange with host app |
| `alarms` | Service worker keepalive |
| `storage` | Persist selected tab across suspensions |

## Troubleshooting

### Extension shows "Disconnected"

1. Make sure the MCP server is running (check your MCP client logs)
2. Verify port 8089 is not in use: `lsof -i :8089`
3. Click "Reconnect" in the extension popup
4. Use `--verbose` flag on the server for debug logs

### "Could not establish connection" errors

The content scripts may not be injected yet. The extension auto-injects on first interaction, but you can also reload the page.

### Safari permission prompts

Safari prompts for per-site permissions the first time the extension interacts with a domain. Click "Always Allow on Every Website" in Safari > Settings > Extensions > MCPSafari Extension to avoid repeated prompts.

### Port already in use

Use `--port` to pick a different port:

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

## Development

### Build & Test

```bash
# Build the MCP server
cd MCPServer
swift build

# Build the Safari extension
cd MCPSafari
xcodebuild -project MCPSafari.xcodeproj -scheme MCPSafari build

# Run the server with verbose logging
.build/debug/MCPSafari --verbose
```

### CI

The CI workflow runs on every push and PR to `main`:

1. Builds the MCP server (`swift build`)
2. Tests the MCP handshake (verifies the binary responds to `initialize`)
3. Builds the Safari extension (`xcodebuild`)

### Project Structure

```
MCPSafari/
├── MCPServer/                      # Swift MCP server
│   ├── Package.swift
│   └── Sources/mcp-safari/
│       ├── main.swift
│       ├── SafariMCPServer.swift
│       ├── WebSocketBridge.swift
│       └── BridgeMessage.swift
├── MCPSafari/                      # Xcode project
│   ├── MCPSafari/                  # macOS host app
│   ├── MCPSafari Extension/        # Safari web extension
│   │   ├── Resources/
│   │   │   ├── background.js
│   │   │   ├── content.js
│   │   │   ├── dialog-interceptor.js
│   │   │   ├── console-interceptor.js
│   │   │   ├── network-interceptor.js
│   │   │   ├── manifest.json
│   │   │   └── popup.html/js/css
│   │   └── SafariWebExtensionHandler.swift
│   └── MCPSafari.xcodeproj
├── .github/workflows/
│   ├── ci.yml
│   └── release.yml
└── CHANGELOG.md
```

## License

MIT
