# @tillgate/admin-api —— 管理控制面 REST API

Hono 管理面 API：admin 会话鉴权 + 用户/Key/渠道/模型/费率/订阅资金/链路观测六域管理读写。
**业务规则零重写**——全部经能力包 facade，app 只保留 config、assembly、协议路由、中间件、presenter 与生命周期。

相关 [ADR-0001](../../docs/adr/0001-errors-registry-ownership.md) / [ADR-0007](../../docs/adr/0007-apps-assembly-ai-injection.md)

## 核心能力

- **会话**：`Authorization: Bearer <JWT>` → `identity.sessions.validate(token, 'admin')`（issuer `tillgate:admin`，与用户面/网关物理隔离）；失败统一 401 不区分原因；Redis 爆破双闸（email+ip / ip）与 jti 吊销面
- **路由族**：`/v1/users`（含 adjust/gift 调账赠送、transactions/audit-logs）、`/v1/admin-keys`、providers/channels（import/test）/channel-funds、models/rate-cards/fx/model-catalog、subscriptions 管理动词、`/v1/tracing/*` 五查询、audit-logs/logs、auth（login + 2FA）、notifications、stats/usage-logs/payment-orders/redeem-batches/marketing/referrals、`/v1/vendor-catalog`
- **列表契约**：`?page=&page_size≤100&q&sort_by&order`，信封 `{rows,total,page,pageSize}`，`sort_by` 白名单外 400
- **错误面**：信封 `{"error":{code,message}}`（message 英文）；`composeErrorCatalogs` 合成七包目录 + app 自有 `admin.*`
- OpenAPI：`bun run generate:openapi`（scripts/generate-openapi.ts → generated/）

## 目录结构（src/）

```
config.ts      # env zod schema（缺省值唯一真相）
assembly.ts    # 唯一装配根：db/redis/identity/billing/accounts/control-plane/observability/notifications
http/          # contracts（zod）/ routes / middleware（session/protocol）/ presenters / openapi
adapters/      # upstream-probe / funding-resolver / smtp-admin-mailer / redis-session-revocation / 审计桥
app.ts / index.ts / shutdown.ts
```

## 配置与端口

- 端口 `8082`（`ADMIN_API_PORT`）；健康探针 `/healthz` `/readyz`（查 DB）`/livez`（纯 200），豁免鉴权
- 必填：`DATABASE_URL`、`REDIS_URL`、`ADMIN_JWT_SECRET`（≥32）、`JWT_SECRET`（≥32，user realm 词表一致性，本 app 不签发）、`ENCRYPTION_KEY`（≥32，AES-256-GCM）、`IDENTITY_CODE_PEPPER`（≥16）
- 选配组：`SMTP_HOST/USER/PASS`（三要素齐全才发信，缺 = 2FA fail-closed）；`CORS_ORIGINS`（空 = 不放行跨域）
- OTel：`OTEL_TRACES_MODE=off|memory|console|otlp`（缺省开发 memory / 生产 off）；otlp 模式需 `OTEL_EXPORTER_OTLP_ENDPOINT`，推送鉴权 `TRACE_RECEIVER_TOKEN`（Bearer，与 trace-receiver 同键同值；缺此值对生产接收端 = span 全部 401）

## 装配与依赖

- 能力包 facade：`@tillgate/accounts`、`@tillgate/billing`（+`/composition` postgres stores）、`@tillgate/control-plane`（+`/composition` 目录源）、`@tillgate/identity`、`@tillgate/observability`（+`/composition` 的 `writeAudit`/`createBestEffortAuditSink` 审计桥）、`@tillgate/notifications`（渠道管理面；投递在 worker）、`@tillgate/inference`（generation_tasks 读侧 store）、`@tillgate/ai`（`SUPPORTED_PROTOCOLS` 词表 + 探针注入，ADR-0007）
- 组合不是第二套业务规则：跨 facade 编排（调账幂等 + 同事务审计、creditLimit 拆分）在路由层组合

## 本地运行与测试

```bash
bun dev        # 仓库根（--env-file=../../.env --watch src/index.ts）
cd apps/admin-api
bun run typecheck && bun run lint && bun run test
bun run test:real     # __test__/*.real.test.ts：真实 PG/Redis 集成
bun run test:e2e      # e2e/admin 切片
```
