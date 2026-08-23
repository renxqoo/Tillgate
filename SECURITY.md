# Security Policy

## Supported versions

Only the latest `main` branch receives security fixes.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use
[GitHub private vulnerability reporting](https://github.com/renxqoo/TokenLens-v2/security/advisories/new)
for this repository. Please include:

- A description of the issue and its impact
- Steps or proof-of-concept to reproduce it
- Affected endpoints / components (e.g. `apps/gateway`, billing path)
- Any suggested mitigation

We aim to acknowledge reports within 72 hours and will keep you informed about
remediation progress.

## Scope notes

- Secrets (JWT secrets, `ENCRYPTION_KEY`, provider API keys) are
  operator-supplied; compromised deployments caused by weak operator secrets
  are not vulnerabilities of this project — rotate via `.env`.
- Channel upstream keys are encrypted at rest with AES-256-GCM
  (`ENCRYPTION_KEY` on the gateway; the worker decrypts with
  `CHANNEL_API_KEY_ENCRYPTION`). Key rotation guidance — see
  [docs/deployment-checklist.md](docs/deployment-checklist.md).
