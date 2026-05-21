import json
import tempfile
import unittest
from pathlib import Path

import audit_swiftpm_osv as audit


class AuditSwiftPMOSVTests(unittest.TestCase):
    def test_load_pins_reads_swift_package_resolved(self):
        package_resolved = {
            "pins": [
                {
                    "identity": "swift-nio",
                    "location": "https://github.com/apple/swift-nio.git",
                    "state": {
                        "revision": "abc123",
                        "version": "2.97.0",
                    },
                }
            ]
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            lockfile = Path(temp_dir) / "Package.resolved"
            lockfile.write_text(json.dumps(package_resolved), encoding="utf-8")

            pins = audit.load_pins([lockfile])

        self.assertEqual(len(pins), 1)
        self.assertEqual(pins[0].identity, "swift-nio")
        self.assertEqual(pins[0].version, "2.97.0")
        self.assertEqual(pins[0].repository_name, "github.com/apple/swift-nio")

    def test_build_queries_checks_identity_repository_and_commit(self):
        pin = audit.Pin(
            identity="swift-nio",
            location="https://github.com/apple/swift-nio.git",
            version="2.97.0",
            revision="abc123",
            source=Path("MCPServer/Package.resolved"),
        )

        queries = audit.build_queries([pin])
        payloads = [query.payload for query in queries]

        self.assertIn(
            {
                "package": {"ecosystem": "SwiftURL", "name": "swift-nio"},
                "version": "2.97.0",
            },
            payloads,
        )
        self.assertIn(
            {
                "package": {
                    "ecosystem": "SwiftURL",
                    "name": "github.com/apple/swift-nio",
                },
                "version": "2.97.0",
            },
            payloads,
        )
        self.assertIn({"commit": "abc123"}, payloads)

    def test_collect_vulnerabilities_deduplicates_results(self):
        pin = audit.Pin(
            identity="swift-crypto",
            location="https://github.com/apple/swift-crypto.git",
            version="4.0.0",
            revision="abc123",
            source=Path("Package.resolved"),
        )
        queries = [
            audit.Query(pin=pin, payload={"package": {"name": "swift-crypto"}}),
            audit.Query(pin=pin, payload={"commit": "abc123"}),
        ]
        results = [
            {"vulns": [{"id": "GHSA-9m44-rr2w-ppp7"}]},
            {"vulns": [{"id": "GHSA-9m44-rr2w-ppp7"}]},
        ]

        vulnerabilities = audit.collect_vulnerabilities(queries, results)

        self.assertEqual(len(vulnerabilities), 1)
        self.assertEqual(vulnerabilities[0].id, "GHSA-9m44-rr2w-ppp7")


if __name__ == "__main__":
    unittest.main()
