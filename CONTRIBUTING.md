# Contributing to DigiCert SRM GitHub Action

Thank you for your interest in contributing to this project. This document explains how to get help, report bugs, request features, and submit pull requests.

## Getting Help

If you need help with setup, credentials, backend connectivity, or workflow troubleshooting, use DigiCert support channels:

- Support Portal: https://www.digicert.com/support
- Contact Us: https://www.digicert.com/contact-us

These channels are best for account-level and environment-specific questions.

Note: Support requests opened as GitHub issues in this repository may be redirected to DigiCert support channels.

## Reporting Bugs

If you find a bug in this action, open a GitHub issue and include:

- A clear summary of the problem and expected behavior
- Steps to reproduce
- Runner type and OS (GitHub-hosted or self-hosted; Linux, Windows, or macOS)
- Relevant workflow logs with secrets and sensitive values redacted
- Action version or commit SHA in use

## Requesting Features

To request a feature, open a GitHub issue with:

- The use case and why the feature is needed
- Proposed behavior
- Alternatives considered

## Submitting Pull Requests

When submitting a PR:

- Keep the scope focused on one change set
- Update documentation when behavior changes
- Add or update changelog entries in CHANGELOG.md when appropriate
- Reference related issues in the PR description
- Ensure examples and YAML syntax are valid

## Security

- Do not commit secrets, API keys, or internal tokens
- Sanitize user-controlled inputs in workflow logic
- Prefer pinned action versions/tags where feasible

For sensitive vulnerability reports, contact DigiCert through official security/support channels instead of creating a public issue.
