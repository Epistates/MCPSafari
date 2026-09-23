#!/usr/bin/env python3
"""Fail-closed release metadata and artifact preparation; no network access."""
import argparse
import hashlib
import json
import re
import subprocess
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


SOURCE_PATHS = ("MCPServer", "MCPSafari", ".github/workflows", ".github/scripts", "Tests")


def qualification(tag: str, root: Path = ROOT) -> None:
    evidence = json.loads((root / ".github/release-qualification.json").read_text())
    if evidence.get("version") != tag.removeprefix("v"):
        raise ValueError("No Safari qualification for this release version")
    commit = evidence.get("sourceCommit", "")
    if not isinstance(commit, str) or not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise ValueError("Qualification must identify the tested source commit")
    for field in ("macOS", "safari", "testedBy", "testedAt"):
        if not isinstance(evidence.get(field), str) or not evidence[field].strip():
            raise ValueError(f"Qualification is missing {field}")
    for check in ("profileRouting", "profileReconnect", "permissions", "privateByDefault"):
        result = evidence.get("checks", {}).get(check, {})
        if result.get("status") != "passed" or not isinstance(result.get("evidence"), str) or not result["evidence"].strip():
            raise ValueError(f"Safari qualification incomplete: {check}")
    # The evidence is committed after testing. Permit documentation/evidence-only
    # commits, but reject any change to the tested implementation or packaging.
    subprocess.run(["git", "cat-file", "-e", f"{commit}^{{commit}}"], cwd=root, check=True)
    result = subprocess.run(["git", "diff", "--quiet", commit, "HEAD", "--", *SOURCE_PATHS], cwd=root)
    if result.returncode != 0:
        raise ValueError("Release source differs from the Safari-qualified commit; rerun qualification")


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
    qualify = commands.add_parser("qualify")
    qualify.add_argument("tag")
    artifacts = commands.add_parser("artifacts")
    artifacts.add_argument("directory", type=Path)
    args = parser.parse_args()
    try:
        if args.command == "notes":
            args.output.write_text(release_notes(args.tag))
        elif args.command == "qualify":
            qualification(args.tag)
        else:
            prepare_artifacts(args.directory)
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Release preparation failed: {error}\n")


if __name__ == "__main__":
    main()
