# Security Policy

## Supported Versions

Security support is provided for the latest released version on `main`.

## Reporting a Vulnerability

Please do **not** open public issues for suspected vulnerabilities.

Instead, email the maintainer privately with:
- A clear description of the issue
- Reproduction steps / proof of concept
- Potential impact
- Suggested remediation (if known)

We will acknowledge receipt as soon as possible and work on a fix before public disclosure.

## Security Controls in this Repository

This repository includes automated security scanning via GitHub Actions:
- **CodeQL** for static analysis of Swift code
- **Gitleaks** for accidental secret detection
- **OSV-Scanner** for vulnerable dependency detection

These checks run on pull requests, pushes to the default branch, and on a weekly schedule.
