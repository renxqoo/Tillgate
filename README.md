# TokenLens

**[中文文档](README.zh-CN.md)** | [docs](docs/) | [CHANGELOG](CHANGELOG.md)

![CI](https://github.com/renxqoo/TokenLens/actions/workflows/ci.yml/badge.svg)

TokenLens is a self-hosted, production-grade **LLM API gateway**: one OpenAI-compatible endpoint in front of many upstream providers, with wallet-based metered billing, subscriptions, quota enforcement, and full observability. Built entirely on [Bun](https://bun.com) — Hono + Drizzle + PostgreSQL + Redis on the backend, Next.js 16 + React 19 + Tailwind v4 + shadcn/ui for the two consoles.

```
client / agent ──> gateway (/v1, OpenAI-compatible)
                     ├── routing & failover ──> OpenAI / DeepSeek / MiniMax / Qwen / Gemini / Anthropic …
                     ├── hold → settle billing (double-entry ledger, PostgreSQL authoritative)
                     └── traces / TTFT / usage logs ──> admin console
```

## Quick Start

### Installation

Prerequisites: [Bun](https://bun.com) ≥ 1.4 and Docker (for PostgreSQL + Redis).

```bash
git clone https://github.com/renxqoo/TokenLens.git && cd TokenLens
bun install                        # dependencies (bun.lock)
cp .env.example .env               # local defaults work out of the box
docker compose -f docker/compose.dev.yml up -d   # postgres + redis
bun run db:migrate                 # schema + identity/ledger provision + wallet opening
bun scripts/seed-admin.ts --password=YourStrongPass1   # first admin account
bun dev                            # gateway + worker + client-api + admin-api
bun dev:all                        # … plus the two Next.js consoles (3001 / 3002)
```

### Usage

1. Sign in to the **admin console** (`http://localhost:3002`) with the seeded admin account (`admin@ai-gateway.local` by default; the password you passed to `seed-admin`). Add an upstream **channel** (provider API key) and a **model mapping** (public model name → real model × channels). If your provider's API host is not in `UPSTREAM_HOST_ALLOWLIST` (`.env`), append it — outbound calls to unlisted hosts are blocked by the SSRF guard.
2. In the **user console** (`http://localhost:3001`), create an **API key** (optional per-key RPM/TPM limits, daily spend cap, model allowlist).
3. Call it like OpenAI:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-..." -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

Production deployment (TLS, certbot, nginx, observability stack, HA topology) is a single compose file — see the [deployment checklist](docs/deployment-checklist.md) and [HA deployment guide](docs/ha-deployment.md). **Never keep the default `.env` secrets in production** — rotate `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `JWT_SECRET`, `ADMIN_JWT_SECRET`, `ENCRYPTION_KEY`.

## Features

- **OpenAI-compatible gateway** — `/v1/chat/completions` (streaming & non-streaming), `/v1/embeddings`, multimodal input, plus native Gemini (`/v1beta`) and Anthropic protocol endpoints. Dual credentials: static API keys and gateway-issued App JWTs (`/oauth/token`) for agents.
- **Multi-provider transport layer** (`packages/ai`) — protocol adapters for OpenAI / DeepSeek / MiniMax / Qwen (dashscope) / Gemini / Anthropic, SSE relay with zero buffering, upstream usage normalization, a token estimator for providers that don't report usage, per-vendor parameter-quirk profiles, SSRF hard guard.
- **Channel routing & failover** — model mappings × weighted channels, per-channel budget and probing, circuit breaker, dead-credential admission, retry with channel switch.
- **Wallet billing** — double-entry ledger kernel (`packages/wallet`), idempotent hold → settle flow (command fingerprints + replay), an 8-state settlement state machine, funding waterfall (subscription quota → PAYG balance), crash recovery and reconciliation.
- **Subscriptions & pricing** — plans, rate cards (official price × coefficient), free daily quotas, upgrade/downgrade, redeem codes and referral credits.
- **API keys & quotas** — per-key RPM/TPM, per-key daily spend caps, model allowlists, organization member billing; user-level limits always apply regardless of credential type.
- **Payments** — EPAY and Stripe online top-up with webhook reconciliation.
- **Async generation** — video / music task submission, polling, and callback-based settlement.
- **Observability** — OTLP trace ingestion with per-trace and topology views, **dual TTFT metrics** (upstream vs client-perceived first-token latency, P50 + P95 per channel), usage/request/audit logs, ops dashboards.
- **Notifications & alerts** — transactional-outbox alert delivery (worker), webhook / email notification channels, optional email verification-code second factor for admin sign-in.
- **Resilience** — Redis Sentinel support; graded degradation when Redis is down (rate limiting fail-open, brute-force guard degraded to in-memory, free-quota fail-closed); settlement wakeups over PostgreSQL LISTEN/NOTIFY — no queue middleware.
- **Two consoles** — admin (channels, models, rate cards, users, subscriptions, payments, observability) and client (keys, usage, billing, playground).
- **Bun-native toolchain** — install / build / test / dev all on Bun 1.4 + Turborepo caching: ~2× gateway throughput and 49× faster builds than the Node baseline ([benchmark](docs/benchmark-2026-08-21-bun-vs-node.md)).

## Summary

TokenLens gives teams that resell or aggregate LLM APIs the infrastructure that usually takes months to build: a compatible front door, provider failover, a billing ledger that survives crashes, quota enforcement on every dimension, and tracing that shows exactly where latency and money go. Deep dives: [billing flow](docs/billing-flow-deep-dive.md) · [gateway pipeline](docs/gateway-pipeline.md) · [tech stack](docs/tech-stack.md) · [API contract](docs/api-contract.md) · [engineering standards](AGENT.md).

## License

Released under the [MIT License](LICENSE). © 2026 TokenLens contributors.
