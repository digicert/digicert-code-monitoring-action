# Code monitoring with DigiCert® Software Trust Manager

Automate and secure your application code workflows with DigiCert® Software Trust Manager code monitoring integrated into GitHub Actions.

This feature enables continuous, automated code security scanning and software transparency directly within your CI/CD pipelines. It leverages CodeQL for multi-language analysis with automatic language detection and generates CycloneDX SBOMs via Trivy, providing deep visibility into your software components and dependencies.

Scan results are securely transmitted to the DigiCert backend for centralized analysis and management, while release tracking allows you to associate scans with specific application versions, helping strengthen your software supply chain security and compliance posture

**This GitHub action**:

- Performs CodeQL analysis with languages automatically resolved from the DigiCert backend.
- Generates SBOMs in CycloneDX format using Trivy for dependency visibility.
- Securely uploads scan results and trigger backend ingestion callbacks.
- Enables release tracking by linking scans to specific application versions.

**The DigiCert code monitoring action allows you to:**

- Automate multi-language security scanning without manual configuration.
- Gain visibility into your software supply chain through SBOM generation.
- Centralize scan results within the DigiCert backend for analysis and management.
- Integrate security scanning seamlessly into GitHub Actions workflows.
- Align security scans with your release lifecycle for better traceability.

## Before you begin

Before you begin, review the following prerequisites:

- GitHub Actions is enabled and you have access to the repository.
- A valid DigiCert API key and region code are available (contact support if unknown).
- The runner environment is GitHub-hosted (Ubuntu) or self-hosted with at least 50 GB of disk space.
- Required permissions are configured: `contents: read` and `actions: read only`.

**Note:** `security-events: write` permission is not required (CodeQL uses `upload: false`)

## Best practices

### Security

- Never hardcode API keys; always use encrypted repository or organization secrets.
- Prefer pinning third-party actions to a commit SHA in high-trust environments.
- Validate all user-provided workflow inputs in caller workflows when possible.
- Grant minimal required permissions (`contents: read`, `actions: read` only)

### Performance

- Run scans on main and pull request (PR) pushes, not on every commit to dev branches.
- Use scheduled scans for baseline checks.
- Run scans in parallel with other jobs if possible.
- Use `ubuntu-latest-xl` for large codebases.

### Maintenance

- Use pin versions `@v1` (gets security updates) or `@v1.2.3` (exact).
- Monitor scan results regularly.
- Keep track of action version releases and review their changelogs.

### Naming

- For **Release-scans**, use app name with version

```yaml
name: my-app
tag: v1.2.3
```

## Get started

### 1. Configure API key

**Repositoty-level** (recommended):

1. Go to **Settings** → **Secrets and variables** → **Actions**
2. Specify **New Secret** as `DC_API_KEY`

**Organizational-level** (shared across repositories):

1. Go to **Organization Settings** → **Secrets and variables**
2. Grant repository access

```yaml
jobs:
  scan:
    steps:
      - uses: digicert/digicert-code-monitoring-action@v1
        with:
          api-key: ${{ secrets.DC_API_KEY }}
```

### 2. Store your API key

1. Go to your repository **Settings** → **Secrets and variables** → **Actions**.
2. Click **New repository secret**.
3. Set **Name** to `DC_API_KEY`.
4. Set **Value** to your DigiCert API key
5. Click **Add secret**.

### 3. Add scan snippet to workflow

Use an existing workflow file (recommended) or create a new one.

**Input parameters**

| Parameter      | Required | Default        | Notes                                          |
| -------------- | -------- | -------------- | ---------------------------------------------- | --- | ---------------------------------------------- |
| `region`       | Yes      |                | `us`, `eu`, `apac` (contact support if unsure) |     | `us`, `eu`, `apac` (contact support if unsure) |
| `api-key`      | Yes      |                | Store in GitHub Secrets, never hardcode        |
| `name`         | No       | Auto-generated | `{workflow}-{event}` if omitted                |
| `with-release` | No       | `false`        | Link to release version                        |
| `tag`          | No       |                | Required when `with-release` is`true`          |

Add the following snippet to your`jobs.scan.steps` workflow file:

```yaml
steps:
  - uses: actions/checkout@v6
  - name: Run DigiCert Scan
    uses: digicert/digicert-code-monitoring-action@v1
    with:
      region: us
      api-key: ${{ secrets.DC_API_KEY }}
```

Use the example template below when creating a new workflow file.

```yaml
name: DigiCert Code Scan

on:
  push:
    branches: ["main"]
  pull_request:
    branches: ["main"]
  workflow_dispatch:
jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    steps:
      - uses: actions/checkout@v6
      - name: Run DigiCert Scan
        uses: digicert/digicert-code-monitoring-action@v1
        with:
          region: us
          api-key: ${{ secrets.DC_API_KEY }}
```

### 4. Commit and push

```yaml
git add YOUR_CHANGED_WORKFLOW_FILE
git commit -m "Add DigiCert security scanning"
git push
```

**Note:** Replace `YOUR_CHANGED_WORKFLOW_FILE`with you actual file name.

### 5. Monitor your first scan

1. Go to **Actions** tab in your repository.
2. Select **DigiCert Code Scan** workflow.
3. Wait for completion.

## Publishing

1. Commit changes to this repository.
2. Create a semantic version tag (example: `v1.0.0`).
3. Push the tag.
4. Optionally maintain a major tag (`v1`) that points to latest compatible release.

## Compatibility

- This action can run in workflows on both GitHub-hosted or self-hosted runners.
- The Node.js version used by the caller project (for example via setup-node) is independent of the runtime used by GitHub actions referenced within this composite action.
- Users running self‑hosted runners must keep their runner binaries up to date to support the action versions used here.
- GitHub Enterprise Server users must verify that their GHES version supports the referenced action versions.

## Usage examples

### Manual (on-demand scanning)

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
      - uses: actions/checkout@v6

      - name: DigiCert Code Monitoring
        uses: digicert/digicert-code-monitoring-action@v1
        with:
          region: us
          api-key: ${{ secrets.DC_API_KEY }}
          name: my-scan-name
```

### Every push to main (continuous scanning on code changes)

```yaml
name: DigiCert Code Scan

on:
  push:
    branches: ["main"]
jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    steps:
      - uses: actions/checkout@v6
      - uses: digicert/digicert-code-monitoring-action@v1
        with:
          region: us
          api-key: ${{ secrets.DC_API_KEY }}
```

### Release tags (release-aligned scanning)

```yaml
name: DigiCert Code Scan

on:
  push:
    tags:
      - "v[0-9]+.[0-9]+.[0-9]+"
jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    steps:
      - uses: actions/checkout@v6
      - uses: digicert/digicert-code-monitoring-action@v1
        with:
          region: us
          api-key: ${{ secrets.DC_API_KEY }}
          with-release: "true"
          name: ${{ github.event.repository.name }}
          tag: ${{ github.ref_name }}
```

### Pull request scanning (pre-merge validation)

```yaml
name: DigiCert Code Scan

on:
  pull_request:
    branches: ["main"]
jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    steps:
      - uses: actions/checkout@v6
      - uses: digicert/digicert-code-monitoring-action@v1
        with:
          region: us
          api-key: ${{ secrets.DC_API_KEY }}
          name: pr-${{ github.event.number }
```

### Scheduled (daily)

```yaml
name: DigiCert Code Scan

on:
  schedule:
    - cron: "0 2 * * *" # Daily 2 AM UTC
jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    steps:
      - uses: actions/checkout@v6
      - uses: digicert/digicert-code-monitoring-action@v1
        with:
          region: us
          api-key: ${{ secrets.DC_API_KEY }}
```

### Release mode

When `with-release: "true"`, `name` and `tag` are required and scan name is built as `<name>-<tag>`.

Example:

```yaml
- name: DigiCert Code Monitoring (Release)
  uses: digicert/digicert-code-monitoring-action@v1
  with:
    region: us
    api-key: ${{ secrets.DC_API_KEY }}
    with-release: "true"
    name: my-scan-name
    tag: v1.2.3
```

## Troubleshooting

### Quick diagnosis

1. Go to **Actions** tab → select failed workflow.
2. Expand **Run DigiCert Scan** step.
3. Look for error message.

### Common issues

| Error                     | Cause                   | Solution                                  |
| ------------------------- | ----------------------- | ----------------------------------------- |
| **HTTP 401**              | API key invalid/expired | Verify key, contact support               |
| **HTTP 403**              | Missing permissions     | Check API key scopes                      |
| **HTTP 500**              | Backend error           | Wait 5 min, check status page             |
| **Invalid region**        | Wrong region code       | Use: `us`, `eu`, `apac`                   |
| **No languages returned** | Can't detect languages  | Check code exists                         |
| **shouldRun=false**       | Duplicate scan          | Use unique scan name or wait`             |
| **Scan takes >1hr**       | Large codebase          | Use larger runner or schedule differently |

### Enable debug mode

To enable debug logging, add the following to your workflow:

```yaml
-env:
  RUNNER_DEBUG: 1
```

## Resources

- For third-party notices, see [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md)
- For changelog, see [CHANGELOG.md](CHANGELOG.md)
- For bug reports, feature requests, and pull requests, see [CONTRIBUTING.md](CONTRIBUTING.md)
- For more information on license, see [LICENSE](LICENSE). This project is licensed under the MIT License.

## Support

If you need help with setup, credentials, backend connectivity, or workflow troubleshooting, use DigiCert support channels:

- Support Portal: https://www.digicert.com/support
- Contact Us: https://www.digicert.com/contact-us

These channels are staffed by DigiCert engineers who can assist with account-level and environment-specific questions.

> **Note:** Support requests opened as GitHub issues in this repository may be redirected to DigiCert support channels.

## Additional information

For more information about code monitoring workflows with Software Trust, contact Sales/Enquiry or visit our [DigiCert Software Trust Manager Documentation](https://docs.digicert.com/en/software-trust-manager.html) site.
