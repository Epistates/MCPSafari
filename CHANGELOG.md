# Changelog

## [0.2.3] - 2026-03-25

### Auto-Discovery (Secure)
- Extension initializes all ports in the scan range (8089-8098) at startup
- **Auto-scan ports require auth token** — prevents rogue local processes from hijacking the extension
- When native messaging delivers the token, auto-discovery works seamlessly
- When native messaging is unavailable, auto-scan ports are skipped; user must manually add ports (explicit trust)
- Manual ports persisted in `storage.local` (survives Safari restarts); auto-ports are ephemeral
- Auto-discovered ports cleaned up after 2 minutes of disconnection or 3 failed initial attempts

### Bug Fixes
- Fixed reconnect amplification: guard against `CONNECTING` state prevents duplicate socket creation
- Fixed pending request drain on `.cancelled` only applying to the active connection (not a replacement)
- Fixed double JSON parse in WebSocket error handler
- Auth token mismatch now closes the connection instead of leaving it open
- Eliminated probe WebSocket churn (init all ports, connect via normal loop)
- Cleaned up dead code (`TOKEN_FILE_PATH` constant, unused `.btn` CSS)
- `stop()` now nils the listener reference

### UI
- Per-port reconnect (refresh icon) and remove (X) buttons replace global "Reconnect All"
- Auto-discovered ports show "auto" badge; manual ports are always removable
- Connected ports sorted first in the popup

## [0.2.2] - 2026-03-25

### Port Auto-Fallback
- Server automatically finds a free port if the requested one is in use (tries up to 10 successive ports)
- Fixes "Address already in use" crash when multiple MCP clients (e.g., Claude Desktop Chat + Cowork) spawn concurrent server instances
- Logs the fallback clearly: `Port 8089 in use — listening on 8090 instead`

### Release Artifact Naming
- Server binaries renamed to `MCPSafari-Server-*` for clarity
- Extension app bundles renamed to `MCPSafari-Extension-*` for clarity

## [0.2.1] - 2026-03-25

### Multi-Connection Support
- Extension now supports **multiple simultaneous MCP server connections** — run Claude Code and Claude Desktop (or any number of MCP clients) at the same time, each on its own port
- Extension popup shows all connections with live status indicators
- Add/remove ports from the popup UI
- "Reconnect Disconnected" only retouches broken connections, leaving healthy ones alone
- Configurable WebSocket port per server instance (`--port <n>`)

### Connection Reliability
- Server accepts WebSocket connections immediately (fixed deadlock where `awaitFirstMessage` blocked when extension sent no auth token)
- Auth handshake handled inline in message stream instead of blocking connection setup
- Reduced max reconnect backoff from 30s to 5s for faster recovery
- Keepalive alarm resets backoff so extension reconnects quickly when a new server starts
- Ports persisted across service worker suspensions via `browser.storage.session`

### Token Optimization
- Tool schemas reduced from ~3,500 to ~2,160 tokens (38% reduction)
- Terse descriptions and shared schema fragments minimize LLM context usage
- Removed redundant `get_page_text` tool (use `read_page` with `format: "text"`)
- Removed `title` from tool annotations (LLMs don't use it)
- Server instructions condensed to a single line

### Bug Fixes & Security
- Fixed extension registration on macOS 26 Tahoe — added required `app-sandbox` entitlements
- Fixed release signing: inner-to-outer with entitlements instead of `--deep` (which stripped them)
- Fixed `reload` navigation action fall-through (missing `break` in switch)
- Fixed WebSocket continuation race condition (registration before send)
- Fixed zombie continuations on connection replacement (drain on `.cancelled`)
- Fixed `selectOption` returning "undefined" when resolved by UID
- Fixed `read_page` silently falling through on unknown format
- Fixed `console-interceptor` clearing all levels when filtering by one
- Added URL scheme validation (http/https/about/file only)
- Added regex pattern validation and length cap (200 chars)
- Added `wait` duration cap (300 seconds max)
- Added `buildTree` depth limit (30 levels)

### Infrastructure
- CI and release workflows now run on `macos-26` runners
- CI skips on docs-only changes (`paths-ignore` for `*.md`, `LICENSE`, `.gitignore`)
- Homebrew cask installs app to `/Applications` + CLI binary via formula dependency
- Cask `postflight` auto-opens app to register extension

## [0.1.0] - 2026-03-23

Initial release of MCPSafari — Safari browser automation via the Model Context Protocol.

### Architecture
- Swift MCP server (`MCPSafari`) using the official `modelcontextprotocol/swift-sdk` v0.11.0
- WebSocket bridge between MCP server and Safari Web Extension (Network.framework)
- Safari Web Extension (Manifest V3) with content script injection and background service worker
- macOS host app for extension management

### Tools (24)

**Tab Management**
- `tabs_context` — List all open tabs with IDs, URLs, and titles
- `tabs_create` — Open a new tab with optional URL
- `close_tab` — Close a tab by ID
- `select_tab` — Pin a tab as the default context for future tool calls

**Navigation**
- `navigate` — Navigate to URL, go back/forward/reload (returns URL and title)

**Page Reading**
- `read_page` — Get page content as text, HTML, or accessibility snapshot
- `get_page_text` — Get visible text content
- `snapshot` — Accessibility tree with element UIDs for interaction tools
- `find` — Find elements by CSS selector, text content, or ARIA role

**Interaction**
- `click` — Click by UID, CSS selector, text, or coordinates (smart text ranking prefers interactive elements)
- `type_text` — Type into element by UID/selector with optional `submitKey` (e.g., Enter after typing)
- `form_input` — Batch fill form fields (React-compatible via nativeInputValueSetter)
- `select_option` — Select dropdown option by value or label
- `scroll` — Scroll page or element in any direction
- `press_key` — Press key combinations (e.g., Meta+a, Control+c)
- `hover` — Hover to trigger tooltips, menus, hover states
- `drag` — Drag and drop between elements

**Dialogs**
- `handle_dialog` — Accept or dismiss browser alerts/confirms/prompts

**Screenshots**
- `screenshot` — Capture visible tab as PNG image

**JavaScript**
- `javascript_tool` — Execute arbitrary JS in page context

**Debugging**
- `read_console` — Read captured console messages with level/pattern filtering
- `read_network` — Read captured XHR/fetch requests with type filtering

**Window**
- `resize_window` — Resize browser window

**Utility**
- `wait` — Wait for duration, CSS selector, or text to appear

### Features
- UID-based element targeting from accessibility snapshots
- `includeSnapshot` option on all interaction tools for immediate page state feedback
- Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`)
- Smart text matching — interactive elements (button, a, [role=button]) ranked over generic containers
- React/Next.js compatibility — uses `nativeInputValueSetter` for controlled input support
- Service worker keepalive via alarms API
- Auto-reconnect with exponential backoff
- Console interception (patches console.* at document_start)
- Network interception (patches XMLHttpRequest and fetch)
