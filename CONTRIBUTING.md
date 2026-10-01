# Contributing

Issues and pull requests are both welcome.

## Before you start

[docs/development.md](docs/development.md) has the build, the test commands, the
architecture, and the release qualification steps. Everything below assumes you can
run the suites it lists.

For anything larger than a bug fix, open an issue first. The tab surface and the
permission model are both mid-redesign, which is better to hear before you write
the code than after.

## What a change needs

Every behaviour change carries a test that fails without it. Check that by reverting
your change and watching the test go red, rather than assuming it would.

Run all four suites before you push:

```sh
(cd MCPServer && swift build && swift test)
node --test Tests/*.mjs
node --test .github/scripts/test_mcp_results.mjs
python3 .github/scripts/test_prepare_release.py
```

Two kinds of change need more than that. Anything touching the bridge needs a
loopback test over real sockets, because a faked transport would have passed the
profile-flapping bug in #54. Anything touching Safari's permission or profile model
has to be checked against real Safari, because Safari has now twice behaved
differently from what its documentation implies. Say in the pull request which of
these you ran, and on which macOS and Safari versions.

## Pull requests

Describe the defect mechanism, then the fix. Naming the behaviour that changed is
more useful than listing the files you touched.

Add a `CHANGELOG.md` entry under `[Unreleased]`, in one of Added, Changed,
Deprecated, Removed, Fixed, or Security. The release workflow copies that entry
onto the release page verbatim, so those headings are the ones that reach users.

Keep unrelated cleanup out of the diff. If you notice something adjacent and wrong,
say so in the pull request and we will take it separately.

## Security

Please do not open a public issue for a suspected vulnerability.
[SECURITY.md](SECURITY.md) has the reporting address, and a threat model saying
what we treat as a vulnerability.
