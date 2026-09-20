#!/usr/bin/env python3
"""Fail-closed release metadata and artifact preparation; no network access."""
import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARTIFACTS = (
    "MCPSafari-Server-arm64-apple-darwin",
    "MCPSafari-Server-x86_64-apple-darwin",
    "MCPSafari-Server-universal-apple-darwin",
    "MCPSafari-Extension-arm64.tar.gz",
    "MCPSafari-Extension-x86_64.tar.gz",
)


def release_notes(tag: str, root: Path = ROOT) -> str:
    if not re.fullmatch(r"v\d+\.\d+\.\d+", tag):
        raise ValueError("Release tags must be vMAJOR.MINOR.PATCH")
    version = tag[1:]
    manifest = json.loads((root / "MCPSafari/MCPSafari Extension/Resources/manifest.json").read_text())
    swift = (root / "MCPServer/Sources/mcp-safari/Diagnostics.swift").read_text()
    project = (root / "MCPSafari/MCPSafari.xcodeproj/project.pbxproj").read_text()
    versions = [manifest["version"]]
    cli_versions = re.findall(r'static let version = "([^"]+)"', swift)
    app_versions = re.findall(r"MARKETING_VERSION = ([^;]+);", project)
    if not cli_versions or not app_versions:
        raise ValueError("Could not locate CLI or app versions")
    versions += cli_versions + app_versions
    if any(value != version for value in versions):
        raise ValueError(f"Tag {tag} does not match all product versions: {sorted(set(versions))}")
    changelog = (root / "CHANGELOG.md").read_text()
    entries = list(re.finditer(r"^## \[([^]]+)\][^\n]*$", changelog, re.MULTILINE))
    matching = [i for i, entry in enumerate(entries) if entry[1] == version]
    if len(matching) != 1:
        raise ValueError(f"Expected one CHANGELOG.md entry for {version}")
    index = matching[0]
    end = entries[index + 1].start() if index + 1 < len(entries) else len(changelog)
    notes = changelog[entries[index].end():end].strip()
    if not notes:
        raise ValueError("Release changelog entry is empty")
    return f"# MCPSafari {tag}\n\n{notes}\n\n## Installation\n\n" + (
        "```sh\nbrew trust epistates/tap\nbrew install --cask epistates/tap/mcp-safari\n```\n\n"
        f"See [setup instructions](https://github.com/Epistates/MCPSafari/blob/{tag}/docs/setup.md) "
        "for manual installation and client configuration.\n"
    )


def prepare_artifacts(directory: Path) -> None:
    # Validate the complete set before writing any checksums.
    for name in ARTIFACTS:
        path = directory / name
        if not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Missing or empty release artifact: {name}")
    lines = []
    for name in ARTIFACTS:
        digest = hashlib.sha256((directory / name).read_bytes()).hexdigest()
        line = f"{digest}  {name}\n"
        (directory / f"{name}.sha256").write_text(line)
        lines.append(line)
    (directory / "SHA256SUMS").write_text("".join(lines))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    notes = commands.add_parser("notes")
    notes.add_argument("tag")
    notes.add_argument("output", type=Path)
    artifacts = commands.add_parser("artifacts")
    artifacts.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "notes":
            args.output.write_text(release_notes(args.tag))
        else:
            prepare_artifacts(args.directory)
    except (ValueError, OSError, KeyError) as error:
        parser.exit(1, f"Release preparation failed: {error}\n")


if __name__ == "__main__":
    main()
