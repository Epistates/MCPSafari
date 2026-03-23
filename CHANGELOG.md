# Changelog

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
