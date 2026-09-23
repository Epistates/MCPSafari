import hashlib
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from prepare_release import ARTIFACTS, prepare_artifacts, release_notes, qualification


class ReleasePreparationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        fixtures = {
            "MCPSafari/MCPSafari Extension/Resources/manifest.json": '{"version":"0.3.2"}',
            "MCPServer/Sources/mcp-safari/Diagnostics.swift": 'static let version = "0.3.2"',
            "MCPSafari/MCPSafari.xcodeproj/project.pbxproj": "MARKETING_VERSION = 0.3.2;",
        }
        for name, contents in fixtures.items():
            destination = self.root / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(contents)
        (self.root / "CHANGELOG.md").write_text(
            "## [Unreleased]\nNot shipped\n\n## [0.3.2] - 2026-09-14\n"
            "### Fixed\nA useful explanation.\n\n## [0.3.1]\nOld notes\n"
        )

    def test_notes_use_only_the_matching_entry(self):
        notes = release_notes("v0.3.2", self.root)
        self.assertIn("A useful explanation.", notes)
        self.assertIn("brew trust", notes)
        self.assertNotIn("Old notes", notes)
        self.assertNotIn("Not shipped", notes)

    def test_tag_and_product_versions_must_match(self):
        for tag in ("v0.4.0", "v0.3.2-rc1", "v0.3.2\n", "$(command)"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release_notes(tag, self.root)

    def test_missing_empty_or_duplicate_notes_fail(self):
        for changelog in ("## [Unreleased]\nChanges", "## [0.3.2]\n", "## [0.3.2]\nA\n## [0.3.2]\nB"):
            (self.root / "CHANGELOG.md").write_text(changelog)
            with self.subTest(changelog=changelog), self.assertRaises(ValueError):
                release_notes("v0.3.2", self.root)

    def test_an_individual_component_version_mismatch_fails(self):
        path = self.root / "MCPSafari/MCPSafari Extension/Resources/manifest.json"
        path.write_text('{"version":"0.3.1"}')
        with self.assertRaises(ValueError):
            release_notes("v0.3.2", self.root)

    def test_checksums_are_complete_relative_and_repeatable(self):
        for name in ARTIFACTS:
            (self.root / name).write_bytes(b"artifact")
        prepare_artifacts(self.root)
        sums = (self.root / "SHA256SUMS").read_text()
        digest = hashlib.sha256(b"artifact").hexdigest()
        self.assertEqual(sums, "".join(f"{digest}  {name}\n" for name in ARTIFACTS))
        prepare_artifacts(self.root)
        self.assertEqual(sums, (self.root / "SHA256SUMS").read_text())
        for name in ARTIFACTS:
            self.assertEqual((self.root / f"{name}.sha256").read_text(), f"{digest}  {name}\n")

    def test_missing_or_empty_artifact_prevents_checksums(self):
        for name in ARTIFACTS[:-1]:
            (self.root / name).write_bytes(b"artifact")
        for empty in (False, True):
            if empty:
                (self.root / ARTIFACTS[-1]).touch()
            with self.subTest(empty=empty), self.assertRaises(ValueError):
                prepare_artifacts(self.root)
            self.assertFalse((self.root / "SHA256SUMS").exists())



class QualificationTests(unittest.TestCase):
    def test_evidence_and_source_changes_are_enforced(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=root, text=True).strip()
            git("init", "-q")
            git("config", "user.email", "test@example.invalid")
            git("config", "user.name", "Qualification Test")
            (root / "MCPServer").mkdir()
            (root / "MCPServer/source.swift").write_text("original")
            git("add", ".")
            git("commit", "-qm", "candidate")
            evidence = {
                "version": "0.4.0", "sourceCommit": git("rev-parse", "HEAD"),
                "macOS": "test-os", "safari": "test-browser", "testedBy": "test", "testedAt": "2026-09-23",
                "checks": {name: {"status": "passed", "evidence": "test evidence"} for name in
                           ("profileRouting", "profileReconnect", "permissions", "privateByDefault")},
            }
            (root / ".github").mkdir()
            path = root / ".github/release-qualification.json"
            path.write_text(json.dumps(evidence))
            git("add", ".")
            git("commit", "-qm", "evidence")
            qualification("v0.4.0", root)
            with self.assertRaises(ValueError):
                qualification("v0.4.1", root)
            evidence["checks"]["permissions"]["status"] = "pending"
            path.write_text(json.dumps(evidence))
            with self.assertRaisesRegex(ValueError, "permissions"):
                qualification("v0.4.0", root)
            evidence["checks"]["permissions"]["status"] = "passed"
            path.write_text(json.dumps(evidence))
            (root / "MCPServer/source.swift").write_text("changed")
            git("add", ".")
            git("commit", "-qm", "changed source")
            with self.assertRaisesRegex(ValueError, "differs"):
                qualification("v0.4.0", root)

if __name__ == "__main__":
    unittest.main()
