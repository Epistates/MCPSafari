#!/usr/bin/env python3
import argparse
import json
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


OSV_QUERY_BATCH_URL = "https://api.osv.dev/v1/querybatch"


@dataclass(frozen=True)
class Pin:
    identity: str
    location: str
    version: str | None
    revision: str | None
    source: Path

    @property
    def repository_name(self) -> str:
        return normalize_repository_name(self.location)


@dataclass(frozen=True)
class Query:
    pin: Pin
    payload: dict[str, Any]


@dataclass(frozen=True)
class Vulnerability:
    id: str
    pin: Pin


def normalize_repository_name(location: str) -> str:
    repository = location.strip()
    if repository.startswith("git@github.com:"):
        repository = "github.com/" + repository.removeprefix("git@github.com:")
    for prefix in ("https://", "http://", "ssh://git@"):
        if repository.startswith(prefix):
            repository = repository.removeprefix(prefix)
    repository = repository.rstrip("/")
    if repository.endswith(".git"):
        repository = repository[:-4]
    return repository.lower()


def load_pins(lockfiles: list[Path]) -> list[Pin]:
    pins: list[Pin] = []
    for lockfile in lockfiles:
        with lockfile.open(encoding="utf-8") as package_resolved:
            data = json.load(package_resolved)
        for pin in data.get("pins", []):
            state = pin.get("state", {})
            pins.append(
                Pin(
                    identity=pin["identity"],
                    location=pin["location"],
                    version=state.get("version"),
                    revision=state.get("revision"),
                    source=lockfile,
                )
            )
    return pins


def build_queries(pins: list[Pin]) -> list[Query]:
    queries: list[Query] = []
    seen: set[str] = set()

    def add(pin: Pin, payload: dict[str, Any]) -> None:
        key = json.dumps(payload, sort_keys=True)
        if key not in seen:
            queries.append(Query(pin=pin, payload=payload))
            seen.add(key)

    for pin in pins:
        if pin.version:
            for name in (pin.identity, pin.repository_name):
                add(
                    pin,
                    {
                        "package": {"ecosystem": "SwiftURL", "name": name},
                        "version": pin.version,
                    },
                )
            add(
                pin,
                {
                    "package": {
                        "purl": f"pkg:swift/{pin.repository_name}@{pin.version}"
                    }
                },
            )
        if pin.revision:
            add(pin, {"commit": pin.revision})

    return queries


def query_osv(queries: list[Query]) -> list[dict[str, Any]]:
    request = urllib.request.Request(
        OSV_QUERY_BATCH_URL,
        data=json.dumps({"queries": [query.payload for query in queries]}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.load(response)

    results = data.get("results", [])
    if len(results) != len(queries):
        raise RuntimeError(
            f"OSV returned {len(results)} results for {len(queries)} queries"
        )
    return results


def collect_vulnerabilities(
    queries: list[Query], results: list[dict[str, Any]]
) -> list[Vulnerability]:
    vulnerabilities: list[Vulnerability] = []
    seen: set[tuple[str, str, str | None]] = set()
    for query, result in zip(queries, results, strict=True):
        for vulnerability in result.get("vulns", []):
            vulnerability_id = vulnerability["id"]
            key = (query.pin.identity, vulnerability_id, query.pin.version)
            if key in seen:
                continue
            vulnerabilities.append(Vulnerability(id=vulnerability_id, pin=query.pin))
            seen.add(key)
    return vulnerabilities


def describe_pin(pin: Pin) -> str:
    if pin.version:
        return f"{pin.identity} {pin.version}"
    return f"{pin.identity} {pin.revision}"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Audit SwiftPM Package.resolved dependencies with OSV.dev."
    )
    parser.add_argument("lockfiles", nargs="+", type=Path)
    args = parser.parse_args(argv)

    try:
        pins = load_pins(args.lockfiles)
        queries = build_queries(pins)
        if not queries:
            print("No SwiftPM pins with versions or revisions found.")
            return 0

        results = query_osv(queries)
    except (OSError, json.JSONDecodeError, urllib.error.URLError, RuntimeError) as error:
        print(f"::error::SwiftPM OSV audit failed: {error}", file=sys.stderr)
        return 2

    vulnerabilities = collect_vulnerabilities(queries, results)
    if vulnerabilities:
        for vulnerability in vulnerabilities:
            print(
                f"::error file={vulnerability.pin.source}::"
                f"{vulnerability.id} affects {describe_pin(vulnerability.pin)}",
                file=sys.stderr,
            )
        return 1

    print(f"No OSV vulnerabilities found for {len(pins)} SwiftPM pins.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
