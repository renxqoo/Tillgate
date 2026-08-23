# Contributing to TokenLens

Thanks for your interest in contributing! This guide covers setup, code standards, and the PR process.

## Development setup

Prerequisites: [Bun](https://bun.com) ≥ 1.4, Docker (PostgreSQL + Redis).

```bash
bun install
cp .env.example .env               # required keys only; defaults live in each app's config.ts
docker compose -f docker/compose.dev.yml up -d
bun run db:migrate                 # schema (packages/db, drizzle-kit)
bun run db:seed                    # optional dev seed (admin + channel + model mapping + test key)
bun dev                            # turbo dev — all seven apps, hot reload
```

## Quality gates (all four must pass)

```bash
bun run typecheck   # tsc, no emit
bun run lint        # oxlint
bun run build       # bun build, per workspace
bun run test        # package-boundary gate + vitest (default gates are hermetic — no DB needed)
bun run format:check  # oxfmt
```

Additional gates, run explicitly when relevant:

- `bun run test:e2e` — cross-process system tests in `e2e/` (need `DATABASE_URL` + `REDIS_URL`;
  see `e2e/README.md`). Real-upstream (`test:e2e:real`) and per-package `test:real` suites need
  real credentials and are never run in CI.
- Coverage: packages enforce thresholds in their `vitest.config.ts` (run `test:coverage` in the
  package). Coverage below threshold means **add tests, never lower the threshold**.

## Code standards

Read [AGENT.md](AGENT.md) before your first change — it is the authoritative engineering standard
(§0 lists the hard rules). The essentials:

- Layered architecture: `routes → application → domain`, with `ports ← adapters` at real
  boundaries. Business rules live only in `domain` (pure functions), transactions only in
  `application`, SQL only in `adapters/postgres`, table definitions only in `packages/db`.
- Everything injectable and required at assembly time — no hardcoded thresholds, currencies, or
  policy flags; no hidden global defaults.
- One verb / one use case per file (~150 lines max); factory closures over classes.
- Money logic has extra rules (idempotency, CAS state transitions, double-entry ledger) —
  summarized in AGENT.md §6. The code in `packages/billing` is the source of truth; docs under
  `docs/` are introductory guides only.
- Tests live in the package-root `__test__/` directory, flat (no subdirectories); tests needing
  real credentials/PG are named `*.real.test.ts` and excluded from default gates.
- Code comments are written in Chinese; API error messages are English (localized `zh` text
  belongs in the error registry).
- No compatibility shims or dead code — when a new path replaces an old one, delete the old one
  in the same PR.
- Docs-first workflow for features and refactors (AGENT.md §9): DESIGN / IMPLEMENTATION /
  MIGRATION docs per capability; architecture decisions get an ADR in `docs/adr/`.

## Commit & PR conventions

- English [Conventional Commits](https://www.conventionalcommits.org/): `feat(billing): …`,
  `fix(gateway): …`, breaking changes add `!`. Commit messages may reference doc sections
  (e.g. `docs(ai): … §3.2`).
- Keep PRs focused; describe behavior changes and how you verified them (tests added / gates run).
- `git add` files explicitly — never `git add -A` (multiple agents/sessions share this tree).
- New tables or columns require a migration in `packages/db/migrations/` (idempotent SQL +
  `_journal.json` entry — `when` must be greater than the previous entry). Do **not** run
  `db:generate` against `request_logs` (partitioned mother table).

## Reporting issues

Use the issue templates (bug / feature). For security vulnerabilities, see
[SECURITY.md](SECURITY.md) — please do not open public issues for them.
