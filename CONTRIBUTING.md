# Contributing to Maws

Thanks for your interest in contributing. Maws is a personal tool, but PRs and issues are welcome.

---

## Reporting Bugs

Open a [GitHub Issue](https://github.com/r41n403/maws/issues/new) and include:

- macOS version and Maws version (shown in the window title)
- Steps to reproduce
- What you expected vs. what happened
- Relevant entries from the audit log (`~/Library/Application Support/maws/audit.log`)

For security vulnerabilities, see [SECURITY.md](./SECURITY.md) — do not open a public issue.

---

## Feature Requests

Open an issue describing the use case before building. Maws follows a modular feature system — most new features should be self-contained modules in `src/features/`. Read the **Adding a Feature** section in the [README](./README.md) first.

---

## Development Setup

```bash
git clone https://github.com/r41n403/maws.git
cd maws
npm install          # also rebuilds keytar for Electron via postinstall
bash fix-electron.sh # downloads the Electron binary if npm didn't
npm start
```

Node 20+ and macOS are required. The app will not run on Linux or Windows.

---

## Submitting a Pull Request

1. Branch off `main` using a descriptive name: `feature/my-thing` or `fix/issue-description`
2. Make your changes
3. Run `npm test` — all tests must pass
4. Run `npm audit --audit-level=high` — no new high-severity CVEs
5. Push and open a PR against `main`
6. CI must be green before merging

Keep PRs focused — one feature or fix per PR makes review easier.

---

## Code Style

- `'use strict';` at the top of every file
- CommonJS (`require`/`module.exports`) — no ESM
- Main process code lives in `src/main/`, renderer code in `src/renderer/`
- No credentials, tokens, ARNs, or account IDs in committed code or tests

---

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | When to use |
|--------|-------------|
| `feat:` | New feature or capability |
| `fix:` | Bug fix |
| `security:` | Security fix or hardening |
| `build:` | Dependency or build system changes |
| `test:` | Adding or updating tests |
| `docs:` | Documentation only |

GitHub uses these to auto-generate release notes, so consistency helps.
