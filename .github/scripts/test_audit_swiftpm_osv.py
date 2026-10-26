import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

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
        self.assertIn(
            {
                "package": {
                    "purl": "pkg:swift/github.com/apple/swift-nio@2.97.0"
                }
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


def batch_response(*results):
    return io.BytesIO(json.dumps({"results": list(results)}).encode())


def make_queries(count):
    pin = audit.Pin(
        identity="swift-nio",
        location="https://github.com/apple/swift-nio.git",
        version="2.97.0",
        revision="abc123",
        source=Path("Package.resolved"),
    )
    return [audit.Query(pin=pin, payload={"commit": f"rev{n}"}) for n in range(count)]


class QueryOSVTests(unittest.TestCase):
    def run_query(self, responses, count=2):
        """Runs query_osv against scripted urlopen outcomes and returns what it
        sent, so a test can read the request bodies as well as the result."""
        sent = []

        def fake_urlopen(request, timeout):
            sent.append(json.loads(request.data)["queries"])
            outcome = responses.pop(0)
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        with mock.patch.object(audit.urllib.request, "urlopen", fake_urlopen), \
                mock.patch.object(audit.time, "sleep") as sleep:
            try:
                results = audit.query_osv(make_queries(count))
            finally:
                self.sleep = sleep
        return results, sent

    def test_follows_next_page_token_and_merges_pages(self):
        results, sent = self.run_query(
            [
                batch_response(
                    {"vulns": [{"id": "OSV-1"}], "next_page_token": "tok"},
                    {},
                ),
                batch_response({"vulns": [{"id": "OSV-2"}]}),
            ]
        )

        self.assertEqual([v["id"] for v in results[0]["vulns"]], ["OSV-1", "OSV-2"])
        self.assertEqual(results[1]["vulns"], [])
        # Only the query that still had pages is asked again, with its token.
        self.assertEqual(sent[1], [{"commit": "rev0", "page_token": "tok"}])

    def test_gives_up_when_pagination_never_ends(self):
        endless = [
            batch_response({"vulns": [], "next_page_token": "again"})
            for _ in range(audit.OSV_MAX_PAGES)
        ]

        with self.assertRaises(RuntimeError):
            self.run_query(endless, count=1)

    def test_retries_once_after_a_network_error(self):
        results, sent = self.run_query(
            [
                urllib.error.URLError("connection reset"),
                batch_response({"vulns": [{"id": "OSV-1"}]}, {}),
            ]
        )

        self.assertEqual(len(sent), 2)
        self.sleep.assert_called_once_with(audit.OSV_RETRY_BACKOFF_SECONDS)
        self.assertEqual(results[0]["vulns"], [{"id": "OSV-1"}])

    def test_retries_a_server_error_but_only_once(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.run_query([self.http_error(503), self.http_error(503)])

        self.sleep.assert_called_once()

    def test_does_not_retry_a_client_error(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.run_query([self.http_error(400)])

        self.sleep.assert_not_called()

    def http_error(self, code):
        error = urllib.error.HTTPError(
            audit.OSV_QUERY_BATCH_URL, code, "error", None, io.BytesIO()
        )
        self.addCleanup(error.close)
        return error


if __name__ == "__main__":
    unittest.main()
