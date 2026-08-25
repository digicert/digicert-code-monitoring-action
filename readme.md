# Code monitoring with DigiCert® Software Trust Manager

Automate and secure your application code workflows with DigiCert® Software Trust Manager code monitoring integrated into GitHub Actions.

This feature enables continuous, automated code security scanning and software transparency directly within your CI/CD pipelines. It uses CodeQL for multi-language analysis, Gitleaks for secret scanning, and `smctl` to generate CycloneDX SBOMs and upload all scan results to DigiCert Software Risk Manager (SRM).

The action creates an SRM external release for each run. Release tracking allows you to associate scans with specific application versions, helping strengthen your software supply chain security and compliance posture.

**This GitHub action**:

- Creates a `BUILD_ONLY` SRM release for standard build scans.
- Creates a `RELEASED` SRM release for release-aligned scans.
- Performs CodeQL analysis with explicitly supplied or GitHub-detected languages.
- Performs Gitleaks secret scanning.
- Generates and uploads a CycloneDX SBOM through `smctl`.
- Uploads CodeQL and Gitleaks SARIF results to the SRM release.

**The DigiCert code monitoring action allows you to:**

- Automate multi-language security scanning without manual configuration.
- Detect secrets with Gitleaks.
- Gain visibility into your software supply chain through SBOM generation.
- Centralize scan results within DigiCert SRM.
- Align security scans with your release lifecycle for better traceability.

## Before you begin

Before you begin, review the following prerequisites:

- GitHub Actions is enabled and you have access to the repository.
- A valid DigiCert SRM host URL and API key are available.
- The runner is Linux x64. GitHub-hosted `ubuntu-latest` is recommended.
- The runner can reach the SRM host, DigiCert CDN, GitHub, and GitHub release downloads.
- The runner provides Bash, `curl`, `gh`, `jq`, `openssl`, `sha256sum`, `zip`, and `git`.
- Required permissions are configured: `contents: read` and `actions: read`.

**Note:** `security-events: write` permission is not required because CodeQL uploads are disabled and results are sent to SRM through `smctl`.

## Best practices

### Security

- Never hardcode API keys; always use encrypted repository or organization secrets.
- Prefer pinning third-party actions to a commit SHA in high-trust environments.
- Grant minimal required permissions (`contents: read`, `actions: read`).
- Do not run this action on `pull_request_target`; use `pull_request`, `push`, or `workflow_dispatch`.
- Use HTTPS values for both `host` and `digicert-cdn`.

**Important:** This action intentionally fails fast when triggered by `pull_request_target` to prevent secrets from being exposed to untrusted fork code.

### Performance

- Run scans on main and pull request (PR) pushes, or on a schedule.
- Use `languages` to avoid unnecessary CodeQL language detection when the languages are known.
- Auto-detection skips `C`/`C++`/`Swift` because they require a project-specific build; set `languages` explicitly (with a manual build) to scan them.
- Use `ubuntu-latest-xl` or another larger Linux x64 runner for large codebases.
- Increase `scan-timeout` for repositories that need more time for Gitleaks and SBOM generation.

### Maintenance

- Use a versioned action reference such as `@v2` or an immutable commit SHA.
- Keep `gitleaks-version` and `codeql-tools-version` current according to your security policy.
- Monitor scan results regularly.
- Keep track of action version releases and review their changelogs.

### Naming

- For **release scans**, use the application name and version:

  ```yaml
  name: my-app
  with-release: true
  tag: v1.2.3
  ```

  Both are optional to pass explicitly: if `name` is omitted, it resolves to the repository name; if `tag` is omitted and the workflow was triggered by a tag push (`refs/tags/<tag>`), it resolves to that tag. Otherwise `tag` is still required.

- For **build scans**, `name` is optional. Omit it to let the action generate a name from the workflow and event.

## Get started

### 1. Configure API key

**Repository-level** (recommended):

1. Go to **Settings** → **Secrets and variables** → **Actions**.
2. Select **New repository secret**.
3. Specify `DC_API_KEY` as the secret name.

**Organization-level** (shared across repositories):

1. Go to **Organization Settings** → **Secrets and variables** → **Actions**.
2. Create `DC_API_KEY` and grant repository access.

### 2. Store your API key

1. Go to your repository **Settings** → **Secrets and variables** → **Actions**.
2. Click **New repository secret**.
3. Set **Name** to `DC_API_KEY`.
4. Set **Value** to your DigiCert SRM API key.
5. Click **Add secret**.

### 3. Add scan snippet to workflow

Use an existing workflow file or create a new one.

**Input parameters**

| Parameter | Required | Default | Notes |
| --- | --- | --- | --- |
| `host` | Yes | | HTTPS DigiCert SRM host URL |
| `api-key` | Yes | | Store in GitHub Secrets; never hardcode |
| `name` | No | `<workflow>-<event>`, or repository name when `with-release` is `true` | Auto-resolved when omitted |
| `with-release` | No | `false` | Create a `RELEASED` SRM release |
| `tag` | No | | Auto-resolved from a tag-push ref when `with-release` is `true` and omitted; otherwise required |
| `languages` | No | Empty | Comma-separated CodeQL language override |
| `github-token` | No | `${{ github.token }}` | Token for GitHub API calls |
| `release-url` | No | Empty | Optional release metadata shortcut |
| `release-node-id` | No | Empty | Optional release metadata shortcut |
| `released-at` | No | Empty | Optional release metadata shortcut; defaults to the current time when a timestamp is required and none is provided |
| `source` | No | `GITHUB_ACTION` | Release source label (`GITHUB` or `GITHUB_ACTION`) |
| `digicert-cdn` | No | DigiCert CDN | HTTPS URL for `smctl` |
| `sbom-spec-version` | No | `1.6` | CycloneDX version: `1.5` or `1.6` |
| `use-github-caching-service` | No | `true` | Cache `smctl` and Gitleaks |
| `use-binary-sha256-checksum` | No | `true` | Verify and invalidate the `smctl` cache by checksum |
| `cache-version` | No | `0.0.0-0` | Manual `smctl` cache-busting value |
| `gitleaks-version` | No | `8.18.4` | Gitleaks version to download |
| `codeql-tools-version` | No | Empty | Optional CodeQL CLI bundle version |
| `scan-timeout` | No | `600` | Maximum wait time for background scans, in seconds |

Add the following snippet to your `jobs.scan.steps` workflow file for a build scan. `name` is intentionally omitted here — when `with-release` is `false` (the default) and `name` is not passed, the action auto-resolves it to `<workflow>-<event>`. When `with-release: true`, an omitted `name` resolves to the repository name and an omitted `tag` resolves to the triggering tag ref, if the workflow was triggered by a tag push; otherwise `tag` must be passed explicitly.

```yaml
steps:
  - name: Run DigiCert Scan
    uses: digicert/digicert-code-monitoring-action@v2
    with:
      host: https://releasemonitor.digicert.com
      api-key: ${{ secrets.DC_API_KEY }}
```

Use the example template below when creating a new workflow file.

```yaml
name: DigiCert Code Scan

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  workflow_dispatch:

jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    steps:
      - name: Run DigiCert Scan
        uses: digicert/digicert-code-monitoring-action@v2
        with:
          host: https://releasemonitor.digicert.com
          api-key: ${{ secrets.DC_API_KEY }}
```

### 4. Commit and push

```shell
git add YOUR_CHANGED_WORKFLOW_FILE
git commit -m "Add DigiCert security scanning"
git push
```

**Note:** Replace `YOUR_CHANGED_WORKFLOW_FILE` with your actual file name.

### 5. Monitor your first scan

1. Go to the **Actions** tab in your repository.
2. Select the **DigiCert Code Scan** workflow.
3. Wait for the scan and uploads to complete.

## Publishing

1. Commit changes to this repository.
2. Create a semantic version tag, for example `v2.0.0`.
3. Push the tag.
4. Optionally maintain a major tag, such as `v2`, that points to the latest compatible release.

## Compatibility

- This action runs on Linux x64 GitHub-hosted or compatible self-hosted runners.
- The runner must have the command-line tools listed in **Before you begin**.
- Users running self-hosted runners must keep their runner binaries up to date to support the referenced action versions.
- GitHub Enterprise Server users must verify that their GHES version supports the referenced action versions and GitHub CLI APIs.

## Usage examples

### Manual (on-demand scanning)

```yaml
name: DigiCert Code Scan

on:
  workflow_dispatch:
  push:
    branches: [main]

jobs:
  code_scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    steps:
      - name: DigiCert Code Monitoring
        uses: digicert/digicert-code-monitoring-action@v2
        with:
          host: https://releasemonitor.digicert.com
          api-key: ${{ secrets.DC_API_KEY }}
```

### Every push to main (continuous scanning on code changes)

```yaml
name: DigiCert Code Scan

on:
  push:
    branches: [main]

jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    steps:
      - uses: digicert/digicert-code-monitoring-action@v2
        with:
          host: https://releasemonitor.digicert.com
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
      - uses: digicert/digicert-code-monitoring-action@v2
        with:
          host: https://releasemonitor.digicert.com
          api-key: ${{ secrets.DC_API_KEY }}
          with-release: true
          name: ${{ github.event.repository.name }}
          tag: ${{ github.ref_name }}
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

### Pull request scanning (pre-merge validation)

```yaml
name: DigiCert Code Scan

on:
  pull_request:
    branches: [main]

jobs:
  scan:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read
    steps:
      - uses: digicert/digicert-code-monitoring-action@v2
        with:
          host: https://releasemonitor.digicert.com
          api-key: ${{ secrets.DC_API_KEY }}
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
      - uses: digicert/digicert-code-monitoring-action@v2
        with:
          host: https://releasemonitor.digicert.com
          api-key: ${{ secrets.DC_API_KEY }}
```

### Release mode

When `with-release: true`, the SRM release name is built as `<name>-<tag>`. If `name` is omitted, it resolves to the repository name. If `tag` is omitted and the workflow was triggered by a tag push (`refs/tags/<tag>`), it resolves to that tag; otherwise `tag` must be passed explicitly.

Example:

```yaml
- name: DigiCert Code Monitoring (Release)
  uses: digicert/digicert-code-monitoring-action@v2
  with:
    host: https://releasemonitor.digicert.com
    api-key: ${{ secrets.DC_API_KEY }}
    with-release: true
    name: my-scan-name
    tag: v1.2.3
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Troubleshooting

### Quick diagnosis

1. Go to the **Actions** tab and select the failed workflow.
2. Expand the **Run DigiCert Scan** step.
3. Review the failing `smctl`, CodeQL, Gitleaks, or upload message.

### Common issues

| Error | Cause | Solution |
| --- | --- | --- |
| **`pull_request_target` rejected** | Unsafe event | Use `pull_request`, `push`, or `workflow_dispatch`. |
| **Host must use HTTPS** | Invalid `host` value | Use the HTTPS SRM host URL. |
| **Release metadata not found** | Tag is not a published GitHub release or token lacks access | Publish the release, grant `contents: read`, or provide all release metadata inputs. |
| **Checksum mismatch** | Downloaded `smctl` does not match the CDN checksum | Retry and verify the DigiCert CDN; do not bypass the mismatch. |
| **Background scan timeout** | Large repository or limited runner | Increase `scan-timeout` or use a larger Linux x64 runner. |
| **Release creation failed** | Invalid credentials, host, or repository context | Check the SRM host, API key, permissions, and `smctl` output. |
| **Upload failed** | Authentication, network, or SRM release problem | Review the failing upload output and verify the release ID. |

### Enable debug mode

To enable GitHub Actions debug logging, set the repository or workflow variable `ACTIONS_STEP_DEBUG` to `true`. Do not enable logging in a way that exposes secrets.

## Resources

- For third-party notices, see [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md).
- For changelog, see [CHANGELOG.md](CHANGELOG.md).
- For bug reports, feature requests, and pull requests, see [CONTRIBUTING.md](CONTRIBUTING.md).
- For more information on the license, see [LICENSE](LICENSE). This project is licensed under the MIT License.

## Support

If you need help with setup, credentials, backend connectivity, or workflow troubleshooting, use DigiCert support channels:

- Support Portal: https://www.digicert.com/support
- Contact Us: https://www.digicert.com/contact-us

These channels are staffed by DigiCert engineers who can assist with account-level and environment-specific questions.

> **Note:** Support requests opened as GitHub issues in this repository may be redirected to DigiCert support channels.

## Additional information

For more information about code monitoring workflows with Software Trust, contact Sales/Enquiry or visit the [DigiCert Software Trust Manager Documentation](https://docs.digicert.com/en/software-trust-manager.html) site.
