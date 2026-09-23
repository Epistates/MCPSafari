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

## Release qualification

A green build proves compilation and automated behavior; it does not prove Safari's
permission dialogs or profile routing. Before tagging a release, record the exact
macOS and Safari versions, date, build commit, and result of each manual pass:

- Two real Safari profiles, each with the extension enabled; verify independent
  routing, selection, disconnect, and reconnect.
- A fresh, ungranted origin, a denied origin, and an allowed origin; verify the
  popup and tool errors, including a permission dialog behind another window.
- Any permission-manifest changes using a development build before changing the
  shipped defaults. Confirm what Safari returns for ungranted tabs and whether a
  popup permission request actually prompts.
- Native input with consent, focus loss, Accessibility refusal, and screenshot
  behavior while Safari is in the background.
- Both packaged architectures, matching app/server versions, clean installation,
  upgrade, signature verification, notarization, and Gatekeeper assessment.

Use a statement such as `Verified on macOS <exact version> / Safari <exact version>
— <date>, <commit>, <passes performed>` only for completed checks. An installed
Safari version or a simulated profile test is not evidence of a real Safari pass.

Tagged releases require matching versions in the CLI, extension manifest, Xcode
project, and a nonempty versioned changelog entry. The release workflow publishes
that entry, checks the complete artifact set, verifies signatures, notarizes the
app and standalone CLI binaries, and creates relative-path checksums. Manual
workflow dispatch builds artifacts for inspection and does not publish a release.
Actual Developer ID signing and Apple service acceptance must still be verified
in the release environment; local script tests cannot establish either.

For full distribution qualification before a tag, dispatch the Release workflow
with `validate_distribution: true` and the version recorded in the source and
changelog. This requires valid Developer ID credentials, notarizes the app and all
CLI binaries (including the universal binary), and uploads `validated-distribution`
artifacts. The publication step only runs on a tag push. The default manual run
remains a build-only dry run that permits missing signing credentials.

### Recording release qualification

Tagged publishing requires `.github/release-qualification.json` to name the release
version, tested source commit, exact macOS/Safari versions, tester, date, and passing
evidence for profile routing, reconnect isolation, permissions, and private-by-default
behavior. Pending entries deliberately prevent publishing. Never substitute mock
extension tests or a distribution dry run for browser evidence.

Commit evidence after testing the candidate. The release gate compares implementation,
tests, and workflow paths against `sourceCommit`; changes in these paths require a
new qualification. Documentation-only evidence commits are allowed. Check locally:

```sh
python3 .github/scripts/prepare_release.py qualify v0.4.0
```

Manual distribution validation remains available while browser qualification is
pending and cannot publish. This is workflow enforcement, not repository access
control: administrators able to change workflows can change this gate.
