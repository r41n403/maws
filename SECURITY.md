# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release | ✅ |
| Older releases | ❌ |

Only the latest release receives security fixes. Update to the latest version before reporting a vulnerability.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately via [GitHub's private vulnerability reporting](https://github.com/r41n403/maws/security/advisories/new).

Include:
- A description of the vulnerability and its potential impact
- Steps to reproduce
- Any proof-of-concept code or screenshots (if applicable)

You can expect an initial response within **48 hours** and a fix or mitigation plan within **7 days** for confirmed issues.

## Security Design

### Credential Storage

| Data | Location | Notes |
|------|----------|-------|
| AWS session credentials | macOS Keychain (via keytar) | Never written to disk as plain text |
| IAM access keys | `~/.aws/credentials` (standard AWS CLI location) | Written by user request only |
| SSO tokens | AWS SDK default cache (`~/.aws/sso/cache/`) | Managed by the AWS SDK |
| App lock password | `~/Library/Application Support/maws/settings.json` | PBKDF2-hashed (100k iterations, SHA-512, random salt) — never stored in plain text |
| Audit log | `~/Library/Application Support/maws/audit.log` | JSONL, no credentials stored |

### Architecture Hardening

- **IPC allowlist** — the renderer process can only invoke IPC channels with a known prefix (`auth:`, `settings:`, `features:`, etc.). Unknown channels are blocked at the preload layer.
- **Webview navigation restriction** — embedded AWS Console and CloudShell webviews are restricted to `*.amazonaws.com`, `*.aws.amazon.com`, `*.awsapps.com`, and `signin.aws.amazon.com`. Navigation to other domains is blocked and opened externally instead.
- **Single instance enforcement** — only one instance of the app can run at a time, preventing IPC race conditions.
- **No remote content in the main window** — the main renderer loads local files only; navigation is blocked via `will-navigate`.
- **App lock** — optional Touch ID or password lock on launch and after a configurable idle timeout.

### Known Limitations

- **Unsigned binary** — Maws is not code-signed with an Apple Developer certificate. macOS Gatekeeper will quarantine it on first install; users must run `xattr -cr /Applications/Maws.app` or right-click → Open. This means macOS cannot verify the binary hasn't been tampered with after download. For high-security environments, build from source.
- **No automatic updates** — there is no auto-update mechanism. Users must manually download new releases.
- **Audit log is local only** — the audit log is not tamper-evident; a local attacker with file system access could modify it.

## Dependency Security

Dependencies are monitored by [Dependabot](https://github.com/r41n403/maws/security/dependabot) with automatic PRs for updates. The CI pipeline runs `npm audit --audit-level=high` on every pull request — PRs that introduce high-severity CVEs will fail to merge.
