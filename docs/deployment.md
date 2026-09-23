# Deployment and support boundaries

MCPSafari is a local browser-automation bridge, with the authority of the Safari
profile and sites the user grants. Tool results go to the MCP client; review that
client's model-provider, retention, and tool-approval settings before using signed-in
work accounts. Local transport does not make those downstream disclosures local.

The app and CLI target macOS 14 or later and ship arm64 and x86_64 artifacts. Build
targets are compatibility intentions, not evidence of testing every OS/browser pair.
Use the release's recorded Safari qualification to identify versions actually tested.
CI uses a simulated extension for tool contracts and cannot certify real Safari
permissions, multi-profile behavior, VoiceOver, or browser dialogs.

Deploy matching app and CLI versions. Keep Developer ID signing, notarization, and
Gatekeeper enabled. Avoid experimental unsigned extension builds in managed fleets.
Grant specific sites in Safari settings; broad site access is an explicit user choice.
The extension does not currently supply an organization-wide domain allowlist,
central audit service, remote policy enforcement, or an enterprise support SLA.
Organizations requiring those controls should qualify that gap before deployment.

Use `mcp-safari doctor` and `status` for local setup and connection diagnostics.
Do not treat page-world console/network captures as tamper-proof audit evidence.
Logs, traces, screenshots, and tool results can contain sensitive page data: retain
and share them according to your organization's policy. MCPSafari adds no telemetry
backend; this does not constrain the MCP client's own collection.

Report suspected vulnerabilities privately to support@epistates.com, following
[SECURITY.md](../SECURITY.md). Public issues are suitable for reproducible defects
with secrets and personal browsing data removed. No fixed response-time or security
backport commitment is implied; releases and changelogs describe shipped fixes.
