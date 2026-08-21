# Contributing to TokenLens

Thanks for your interest in contributing! This guide covers setup, code standards, and the PR process.

## Development setup

Prerequisites: [Bun](https://bun.com) ≥ 1.4, Docker (PostgreSQL + Redis).

```bash
bun install
cp .env.example .env
docker compose -f docker/compose.dev.yml up -d
bun run db:migrate
bun dev            # or: bun dev:all (includes the Next.js consoles)
```

## Quality gates (all four must pass)

```bash
bun run typecheck   # tsc, no emit
bun run lint        # oxlint
bun run build       # bun build, per package
bun run test        # vitest (integration tests need a local PostgreSQL)
```

`bun run regress` runs the shared-package and backend-app gates in one command.

## Code standards

Read [AGENT.md](AGENT.md) before your first change — it is the authoritative engineering standard:

- Layered architecture: `routes → Service → Domain → Repository → db`; SQL lives only in `packages/repository`, business rules only in `packages/domain`, transactions only in services.
- Everything injectable — no hardcoded thresholds, currencies, or policy flags.
- One verb / one use case per file (~150 lines max); factory closures over classes.
- Money logic has extra rules (idempotency, CAS state transitions, double-entry ledger) — summarized in AGENT.md §6. The code in `packages/wallet` / `packages/service` is the source of truth; docs under `docs/` are introductory guides only.
- Code comments are written in Chinese; API error messages are English.
- No compatibility shims or dead code — when a new path replaces an old one, delete the old one in the same PR.

## Commit & PR conventions

- English [Conventional Commits](https://www.conventionalcommits.org/): `feat(wallet): …`, `fix(gateway): …`, breaking changes add `!`.
- Keep PRs focused; describe behavior changes and how you verified them (tests added / gates run).
- New tables or columns require a migration in `packages/db/migrations/` (idempotent SQL + `_journal.json` entry — `when` must be greater than the previous entry).

## Reporting issues

Use the issue templates (bug / feature). For security vulnerabilities, see [SECURITY.md](SECURITY.md) — please do not open public issues for them.
