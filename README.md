# MCPSafari: Your favorite browser, ready for agents

A native Safari MCP server for your real, logged-in Safari on macOS. Works with any MCP-compatible client, including Claude Code, Codex, Cursor, OpenCode, and oh-my-pi.

<div align="center">
  <video src="https://github.com/user-attachments/assets/96566f48-a7b7-468b-bf96-8ca5c5c86da7" muted autoplay loop playsinline width="100%"></video>
</div>

Your agent starts with your existing logins, cookies, and history. Open a signed-in page and get to work.

- Test your site in Safari. Let your agent check forms, menus, and drag-and-drop in the browser your Safari users will see.
- Target elements by UID (from a snapshot), CSS, text, or coordinates. Fill React forms with setters that update application state.
- Check what happened. Read console and network activity, and save screenshots to disk for review without filling the agent's context with image data.
- Run DOM tasks in the background. Native typing, key presses, hover, and drag need Safari in front and Accessibility permission.

QA on real sites has shaped the tools, including fixes for [menus that ignored clicks](https://github.com/Epistates/MCPSafari/pull/74) and [drop zones that missed files](https://github.com/Epistates/MCPSafari/pull/75).

Built with Swift and a Manifest V3 Safari extension. Requires macOS 14+ and Safari 17+. Xcode is only needed to build from source.

## Quick start

### 1. Install

```sh
brew install --cask epistates/tap/mcp-safari
```

Enable **MCPSafari Extension** in Safari → Settings → Extensions. Grant access to the sites you want your agent to use.

Homebrew installs the published release. This README and the [tool reference](docs/tools.md) describe `main`, which may include unreleased features. Check [Releases](https://github.com/Epistates/MCPSafari/releases) for your version.

### 2. Connect your client

For Claude Code:

```sh
claude mcp add --scope user mcp-safari mcp-safari
```

For Codex CLI:

```sh
codex mcp add mcp-safari -- mcp-safari
```

Start a new client session after adding the server. For Claude Desktop, Cursor, and other clients, see [client configuration](docs/setup.md#configuration).

### 3. Try it

Ask your agent:

> Open example.com in a new Safari tab, read the page heading, and take a screenshot.

The heading should be “Example Domain”. If the connection fails, see [troubleshooting](docs/setup.md#troubleshooting). On versions that include it, `mcp-safari doctor` checks the installation without changing it.

## Before you use it

Your agent acts in your existing browser session. It can access signed-in pages where you allow the extension. Tool results go to your MCP client and may be sent to its model provider; see [browser access and data](SECURITY.md#browser-access-and-data).

Background DOM tasks do not need native input. For hover styling, real keyboard events, and native drag, Safari must be in front. Native hover and drag move your pointer, so leave the mouse alone while they run. See [synthetic and native input](docs/tools.md#synthetic-and-native-input).

Console and network capture have limits. Pages can alter the captured data, and resource timings do not include HTTP status or headers. See [debugging](docs/tools.md#debugging).

## Documentation

- [Setup and troubleshooting](docs/setup.md): manual installation, client configuration, ports, and diagnostics.
- [Tools and usage](docs/tools.md): tool list, targeting, forms, uploads, waits, and batches.
- [Development](docs/development.md): source builds, tests, and architecture.
- [Security](SECURITY.md): permissions, redaction, and vulnerability reporting.
- [Changelog](CHANGELOG.md) and [releases](https://github.com/Epistates/MCPSafari/releases).

## License

MIT
