# Development

[Back to README](../README.md) · [Setup](setup.md)

## Build and test

Source builds require macOS 14+, Safari 17+, Swift 6.3+, and Xcode 26.6 (the version selected by CI).

Clone the repository, then build from its root. The parentheses keep each command group in its own directory.

```sh
git clone https://github.com/Epistates/MCPSafari.git
cd MCPSafari

(cd MCPServer && swift build && swift test)
node --test Tests/*.mjs

(cd MCPSafari && xcodebuild -project MCPSafari.xcodeproj \
  -scheme MCPSafari -configuration Debug build \
  CODE_SIGN_IDENTITY="-" CODE_SIGNING_REQUIRED=NO)
```

The extension build above matches CI and checks compilation. To install a development build, open `MCPSafari/MCPSafari.xcodeproj` in Xcode, configure signing for your team, and build and run the app. Enable its extension in Safari settings.

Point your MCP client at `MCPServer/.build/debug/MCPSafari` using an absolute path. Add `--verbose` to its arguments for debug logs. For a release server binary:

```sh
(cd MCPServer && swift build -c release)
```

The binary is `MCPServer/.build/release/MCPSafari`.

## CI

[ci.yml](../.github/workflows/ci.yml) builds and tests the Swift server, runs the Node extension tests, checks the MCP handshake, and builds the Safari extension. Its path filters skip Markdown-only changes. Security scans have [separate workflows](../.github/workflows).

## Architecture

### MCP server (`MCPServer/`)

A Swift executable using the official [modelcontextprotocol/swift-sdk](https://github.com/modelcontextprotocol/swift-sdk). Communicates with MCP clients via **stdio** and with the Safari extension via a **WebSocket** bridge using `Network.framework`.

- `main.swift` — Entry point, parses CLI flags, starts the server
- `SafariMCPServer.swift` — Tool definitions and handlers (actor)
- `WebSocketBridge.swift` — WebSocket server with request/response correlation (actor)
- `BridgeMessage.swift` — Wire protocol types and `AnyCodable` serialization

### Safari extension (`MCPSafari/`)

A Manifest V3 Safari Web Extension with:

- `background.js` — WebSocket client, request router, tab/navigation/screenshot handlers
- `content.js` — DOM interaction, accessibility snapshots, element finding, click/type/scroll simulation
- `trace-interceptor.js` — Captures action-window URL, history, console, network, and DOM mutation events
- `dialog-interceptor.js` — Patches `window.alert/confirm/prompt` before page scripts run
- `console-interceptor.js` — Captures console messages for `read_console`
- `network-interceptor.js` — Captures XHR/fetch requests for `read_network`
- `popup.html/js/css` — Extension popup showing connection status

### macOS host app

A minimal macOS app (`AppDelegate.swift`, `ViewController.swift`) that registers the Safari extension and provides native messaging for auth token exchange.
