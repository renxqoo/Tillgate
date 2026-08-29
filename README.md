# Tillgate

**[中文文档](README.zh-CN.md)** | [docs](docs/) | [CHANGELOG](CHANGELOG.md)

![CI](https://github.com/renxqoo/Tillgate/actions/workflows/ci.yml/badge.svg)

Tillgate is a self-hosted **LLM API gateway**: one OpenAI-compatible endpoint in front of every upstream provider, with the parts that usually take months to build already inside — metered wallet billing, subscriptions, quota enforcement, an admin console, a user console, and per-request tracing. All TypeScript on [Bun](https://bun.com): Hono · Drizzle · PostgreSQL · Redis · BullMQ on the backend, Next.js 16 + React 19 + Tailwind v4 + shadcn/ui for the consoles.

```
client / agent ──> gateway (OpenAI · Claude · Gemini protocols)
                      ├── routing & failover ──> OpenAI / Anthropic / Gemini / Azure / Bedrock / Vertex / Qwen / MiniMax …
                      ├── hold → settle billing (double-entry ledger, PostgreSQL as source of truth)
                      └── traces · TTFT · usage logs ──> admin console
```

## Screenshots

**User console** (left) — balance & spend overview, daily cost trend, usage by model, API keys.
**Admin console** (right) — request/spend/token KPIs, channel health, 14-day trends, full operations surface.

<p align="center">
  <img src="docs/images/client-console-en.png" alt="User console — dashboard" width="49%">
  <img src="docs/images/admin-console-en.png" alt="Admin console — dashboard" width="49%">
</p>

## Why Tillgate

- **One `docker run`, whole stack up.** The all-in-one image bundles PostgreSQL, Redis, nginx and TLS; secrets, migrations and the first admin account are bootstrapped on first boot, and all state lives in a single `/data` volume. First boot downloads dependencies from npm (set `AIO_NPM_REGISTRY` to use a mirror) and caches them in `/data` — subsequent boots are fully offline.
- **Speaks your SDK's language.** OpenAI `chat/completions`, `responses`, `completions`, `embeddings`, images, audio, rerank — plus the Claude Messages protocol and native Gemini endpoints behind the same base URL. Existing OpenAI SDK code just changes `base_url`.
- **Billing that survives crashes.** Double-entry ledger with idempotent hold → settle (command fingerprints + replay) and a settlement state machine; PostgreSQL is the single source of truth for money, and amounts are Decimal-only — never floats.
- **Failover, not downtime.** Model mappings × weighted channels, per-channel budgets and probing, circuit breaker, dead-credential admission, retry with channel switch.
- **Limits on every dimension.** Per-key RPM/TPM, per-key daily spend caps, model allowlists, organization member billing — and user-level limits that always apply regardless of credential type.
- **See where latency and money go.** Dual TTFT metrics (upstream vs client-perceived first token, P50 + P95 per channel), OTLP traces with per-trace and topology views, usage/request/audit logs.

## Feature tour

**Gateway & protocols**

- OpenAI-compatible surface: `/v1/chat/completions` (streaming & non-streaming), `/v1/completions`, `/v1/responses`, `/v1/embeddings`, `/v1/images/generations`, `/v1/audio/speech`, `/v1/rerank`, `/v1/moderations`, `/v1/models`; Claude Messages protocol at `/v1/messages`; native Gemini at `/v1beta/models/*`; multimodal chat input.
- Dual credentials: static `sk-` API keys and gateway-issued App JWTs (`/oauth/token`) for agents.
- Async generation: video / music task submission, polling, and callback-based settlement.

**Upstream transport library** (`packages/ai`, zero internal dependencies)

- 8 protocol adapters: OpenAI-compatible, Anthropic, Gemini, Azure OpenAI, AWS Bedrock, Vertex AI, MiniMax, dashscope (Qwen).
- Zero-buffering SSE relay, upstream usage normalization, token estimator for providers that don't report usage, per-vendor parameter-quirk profiles.
- Hard SSRF egress guard: HTTPS-only, loopback / private-network rejection, per-address DNS resolution checks.

**Routing & reliability** (`packages/inference`)

- Weighted channel routing with per-channel budgets, probing, circuit breaker, dead-credential admission, retry with channel switch.
- Redis Sentinel support; graded degradation when Redis is down; settlement wakeups over PostgreSQL `LISTEN/NOTIFY`.

**Money** (`packages/billing`)

- Double-entry ledger, idempotent hold → settle, 8-state settlement machine, funding waterfall (subscription quota → PAYG balance), crash recovery and reconciliation.
- Plans, rate cards (official price × coefficient), free daily quotas, upgrades/downgrades, redeem codes and referral credits.
- EPAY and Stripe online top-up with webhook reconciliation.

**Accounts & access**

- Two consoles out of the box: admin (channels, models, rate cards, users, subscriptions, payments, observability) and client (keys, usage, billing, playground), consuming the APIs through a typed client (`packages/api-client`).
- GitHub / Google OAuth, Turnstile, SMTP and payment credentials are configured at runtime from the admin console — no redeploy to rotate.
- Transactional-outbox notifications (webhook / email), optional email verification-code second factor for admin sign-in.

**Observability** (`packages/observability`)

- OTLP trace ingestion with per-trace and topology views, dual TTFT metrics per channel, usage/request/audit logs, ops dashboards.

**Engineering**

- Executable architecture: package boundaries (dependency whitelist, explicit exports, no cycles) enforced in CI by `scripts/check-package-boundaries.ts`, plus per-package architecture tests and four root gates (`typecheck` / `lint` / `test` / `build`).

## Quick start

### Option 1 — Docker (fastest way to a running gateway)

One command brings up the entire stack; all state persists in `./data`:

```bash
docker run -d --name tillgate --restart always \
  --log-opt max-size=10m --log-opt max-file=3 \
  -p 443:443 -p 8443:8443 -p 80:80 \
  -v "$PWD/data:/data" \
  renxqoo/tillgate:latest
```

Grab the one-time admin password and watch the stack come up:

```bash
docker logs -f tillgate                                    # Ctrl-C when done; doesn't stop the service
docker exec tillgate cat /data/bootstrap-credentials.txt   # read once, then delete the file
```

| Entry                        | Address                                               |
| ---------------------------- | ----------------------------------------------------- |
| User console & inference API | `https://<server-ip>/` · `https://<server-ip>/v1/...` |
| Admin console                | `https://<server-ip>:8443`                            |

Self-signed TLS is generated on first boot (trust the cert, or terminate TLS at your edge). Domains, external databases, the multi-container production topology and HA are covered in the [deployment guide](docs/deployment.md).

### Option 2 — From source (for development)

Prerequisites: [Bun](https://bun.com) ≥ 1.4 and Docker (used only for PostgreSQL + Redis).

```bash
git clone https://github.com/renxqoo/Tillgate.git && cd Tillgate
bun install                                            # dependencies (bun.lock)
cp .env.example .env                                   # required keys only; everything else has safe defaults
# generate the five required secrets (weak/empty values refuse to boot):
for k in JWT_SECRET ADMIN_JWT_SECRET ENCRYPTION_KEY IDENTITY_CODE_PEPPER CLIENT_CODE_PEPPER; do
  sed -i.bak -E "s|^#?[[:space:]]?${k}=.*|${k}=$(openssl rand -hex 32)|" .env; done; rm -f .env.bak
docker compose --env-file .env -f docker/compose.dev.yml up -d   # postgres + redis only
bun packages/db/scripts/provision-fresh.ts             # fresh-db pre-provision (idempotent)
bun run db:migrate                                     # schema (idempotent)
cd apps/admin-api && bun scripts/create-admin.ts --email=admin@ai-gateway.local --apply && cd ../..
bun run dev                                            # all seven apps, hot reload
```

`create-admin` prints a one-time strong password for `admin@ai-gateway.local` (reruns are idempotent no-ops; production bootstrap uses the same script without a hardcoded password).

| Service                        | Port            |
| ------------------------------ | --------------- |
| Gateway — inference API        | `8080`          |
| User console                   | `3001`          |
| Admin console                  | `3002`          |
| client-api / admin-api         | `8081` / `8082` |
| worker health / trace-receiver | `8792` / `8793` |

### Make your first call

1. Sign in to the **admin console** (`http://localhost:3002`, or `https://<server-ip>:8443` on Docker) and add an upstream **channel** (provider base URL + API key, encrypted at rest) and a **model mapping** (public model name → real model × channels).
2. In the **user console** (`http://localhost:3001`) register an account and create an **API key** — optionally with per-key RPM/TPM limits, a daily spend cap, and a model allowlist.
3. Call it exactly like OpenAI:

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-..." -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

Existing OpenAI SDK code only changes the base URL:

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="sk-...")
```

## Repository layout

A Turborepo monorepo of 7 apps + 14 capability packages. Apps are thin assembly units (config + HTTP shell + wiring); business capability lives in packages with a `domain / application / ports / adapters` layering. Engineering standards: [AGENTS.md](AGENTS.md).

```
apps/       gateway · client-api · admin-api · worker · trace-receiver · client · admin   (assembly units)
packages/   ai · inference · billing · accounts · identity · control-plane · notifications ·
            observability · db · errors · http · runtime · api-client · ui                (capabilities)
e2e/        cross-process system tests (mock / real / smoke gates)
docker/     compose files for dev, production and HA topologies
```

## Documentation

- [Deployment guide](docs/deployment.md) — all-in-one container, multi-container compose, HA, external databases
- [Toolchain benchmark](docs/benchmark-2026-08-21-bun-vs-node.md) — why Bun end-to-end
- [CHANGELOG](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md)

## License

Released under the [MIT License](LICENSE). © 2026 Tillgate contributors.
