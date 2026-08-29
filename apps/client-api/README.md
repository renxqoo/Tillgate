# @tillgate/client-api —— 用户控制台 REST API

Hono 用户面 API（端口沿用 v1 `8081`）：会话/资料/Key/App/组织/钱包/兑换/支付/订阅/用量/定价/推荐。
业务全部经能力包 facade，本 app 只保留协议与装配（P5）。

错误码演进依据 [ADR-0001](../../docs/adr/0001-errors-registry-ownership.md)

## 核心能力

- **51 条路由**（与 v1 逐条对齐）：auth（注册/登录/验证码/OAuth GitHub+Google）、me、keys、apps、orgs、wallet、redeem、payments（EPAY/Stripe 下单 + 公开回调）、subscriptions、usage、pricing、referrals
- **会话**：用户面 realm JWT（`JWT_SECRET`，与管理面/网关物理隔离）；登录邮箱验证码两级（`EMAIL_CODE_REQUIRED=auto|on|off`）；SMTP 未配置 = 验证码模式 fail-closed
- **契约**：错误信封 `{error:{code,message,context?}}` + 命名空间码（v1 裸码 → `accounts.* / identity.* / billing.*`）；`x-request-id` 服务端回显；分页钉死 `page`/`limit`（strict，limit 1..100 默认 20）；金额一律 JSON 字符串
- **可选能力组**（全配才启用，半配启动失败）：EPAY 五件套、Stripe 四件套、Turnstile 人机验证、OAuth 凭证、SMTP 三要素

## 目录结构（src/）

```
config.ts      # env zod schema + 成组 fail-fast（生产 SECURE_COOKIE 强制）
assembly.ts    # 唯一装配根：db/redis/identity/accounts/billing/observability
http/          # contracts（zod）/ routes / middleware / presenters
adapters/      # 跨能力只读面组合（account/billing/usage/subscription/pricing-read）+ redis/oauth/turnstile/smtp 适配
app.ts / index.ts / shutdown.ts
```

## 配置与端口

- 端口 `8081`（`CLIENT_API_PORT`）；健康探针 `GET /healthz`（db ping + redis ping，公开）
- 必填：`DATABASE_URL`、`REDIS_URL`、`JWT_SECRET`（生产 ≥32）、`CLIENT_CODE_PEPPER`（生产 ≥32，挑战防离线穷举）、`ENCRYPTION_KEY`（生产 ≥32）
- Redis Sentinel 可选：`REDIS_SENTINELS` + `REDIS_SENTINEL_NAME`（配了节点列表必须带主名）
- 常用缺省：`SESSION_TTL_SECONDS=86400`、`REGISTER_ENABLED=true`、`TRUSTED_PROXY_HOPS=0`、`TOPUP_MIN/MAX/EXCHANGE_RATE`、`KEY_PREFIX=sk_`
- OTel：`OTEL_TRACES_MODE=off|otlp`（缺省 off）；otlp 需 `OTEL_EXPORTER_OTLP_ENDPOINT`，推送鉴权 `TRACE_RECEIVER_TOKEN`（Bearer，与 trace-receiver 同键同值）

## 装配与依赖

- 能力包 facade：`@tillgate/identity`（会话/挑战/OAuth，经 `adapters/identity-stack`）、`@tillgate/accounts`（+`/composition` 资金来源解析器）、`@tillgate/billing`（+`/composition` wallet/payments/redeem postgres stores 与 EPAY/Stripe provider）、`@tillgate/observability`（initOtel）、`@tillgate/runtime`（redis/cipher/爆破守卫/logger）、`@tillgate/db`
- app 永不触 DbTx：无共享事务的 facade 动词编排；跨能力只读面组合在 `src/adapters/*-read.ts`
- 消费方：apps/client（Next.js BFF，经 `@tillgate/api-client/next` 持 `ag_session` cookie 出站 Bearer）

## 本地运行与测试

```bash
bun dev        # 仓库根（--env-file=../../.env --watch src/index.ts）
cd apps/client-api
bun run typecheck && bun run lint && bun run test
bun run test:real     # app.real.test.ts：真实 PG/Redis 集成
```
