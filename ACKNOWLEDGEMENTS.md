# Acknowledgements

This repository uses third-party GitHub Actions and open-source tools.
Their licenses and terms are governed by their respective upstream projects.

## Third-Party Components

| Component                 | Version | License                 | Usage in this repository            | Upstream                                     |
| ------------------------- | ------- | ----------------------- | ----------------------------------- | -------------------------------------------- |
| actions/checkout          | v6      | MIT                     | Source checkout in composite action | https://github.com/actions/checkout          |
| github/codeql-action      | v4      | MIT (plus CodeQL Terms) | CodeQL init and analysis steps      | https://github.com/github/codeql-action      |
| actions/upload-artifact   | v6      | MIT                     | Upload SARIF and SBOM artifacts     | https://github.com/actions/upload-artifact   |
| aquasecurity/trivy-action | v0.35.0 | Apache-2.0              | SBOM generation step                | https://github.com/aquasecurity/trivy-action |

## Notes

- Refer to each upstream repository for the current license text and notices.
- Versions/tags should be pinned in workflows where stronger supply-chain control is required.
- This acknowledgements file does not replace upstream license obligations.
- CodeQL usage may also be subject to GitHub CodeQL Terms and Conditions.
