## What & why

<!-- What does this PR change, and why? Link the issue if one exists.
     For refactors: reference the doc section (e.g. refactoring §3.2 / ADR-NNNN). -->

## Type of change

- [ ] feat — new capability
- [ ] fix — bug fix
- [ ] perf — performance improvement
- [ ] refactor — no behavior change
- [ ] docs / chore

## Behavior notes

<!-- For billing/money changes: which invariant applies (idempotency, CAS, funding waterfall)?
     For API changes: is the error contract unchanged (code/status)? -->

## Verification

- [ ] `bun run typecheck`
- [ ] `bun run lint`
- [ ] `bun run build`
- [ ] `bun run test`
- [ ] `bun run format:check`
- [ ] Tests added / updated for the change (boundary & regression cases are mandatory — AGENTS.md §10)
- [ ] Coverage numbers reported as-is if thresholds are affected (never lowered)

<!-- If migrations are included: `packages/db/migrations/` SQL idempotent, `_journal.json` entry
     appended with `when` greater than the previous entry. -->
