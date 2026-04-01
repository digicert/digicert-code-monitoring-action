# DigiCert Code Scan GitHub Action

Standalone composite GitHub Action that runs:

- CodeQL analysis (languages resolved from DigiCert backend)
- SBOM generation (CycloneDX via Trivy)
- Artifact upload and backend ingestion callbacks

This repository is intended to be published and versioned so other repositories can consume it using `uses: digicert/srm-github-action@<tag>`.

## Usage

```yaml
name: DigiCert Code Scan

on:
  workflow_dispatch:
  push:
    branches: ["main"]

jobs:
  code_scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
      security-events: write

    steps:
      - uses: actions/checkout@v4

      - name: DigiCert Scan
        uses: digicert/srm-github-action@v1
        with:
          region: us
          api-key: ${{ secrets.DC_API_KEY }}
          name: my-scan-name
```

## Inputs

- `region`: DC One region (required)
- `api-key`: API key for DigiCert backend (required, pass via secrets)
- `name`: Optional scan name. Required when `with-release` is `true`
- `with-release`: `true` or `false`. Default: `false`
- `tag`: Release tag. Required when `with-release` is `true`

## Release Mode

When `with-release: "true"`, `name` and `tag` are required and scan name is built as `<name>-<tag>`.

Example:

```yaml
- name: DigiCert Scan (Release)
  uses: digicert/srm-github-action@v1
  with:
    region: us
    api-key: ${{ secrets.DC_API_KEY }}
    with-release: "true"
    name: my-scan-name
    tag: v1.2.3
```

## Publishing

1. Commit changes to this repository.
2. Create a semantic version tag (example: `v1.0.0`).
3. Push the tag.
4. Optionally maintain a major tag (`v1`) that points to latest compatible release.

Consumers should pin to a release tag or SHA for stability.

## Repository Policies

- License: see [LICENSE](LICENSE)
- Third-party notices: see [LICENSE-ACKNOWLEDGEMENTS.md](LICENSE-ACKNOWLEDGEMENTS.md)

## Security Notes

- Never hardcode API keys; always use encrypted repository or organization secrets.
- Prefer pinning third-party actions to a commit SHA in high-trust environments.
- Validate all user-provided workflow inputs in caller workflows when possible.
