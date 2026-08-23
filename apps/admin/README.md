# @tokenlens/admin —— Next.js 管理后台（BFF）

管理面全部页面装配（用户/渠道/模型/计费/链路运营）：BFF 持会话，经 `@tokenlens/api-client` 调 admin-api，**零能力包直依赖**（架构测试锁定）。

设计基线 [DESIGN.md](./DESIGN.md) · 施工图 [IMPLEMENTATION.md](./IMPLEMENTATION.md) · 迁移核销 [MIGRATION.md](./MIGRATION.md)

## 核心能力

- **BFF 会话**：登录/2FA 验码为 server action 直调 admin-api（裸 fetch），token 写 `ag_admin_session` HttpOnly cookie；浏览器永不见 JWT，出站由 client 注入 Bearer + `accept-language` + `x-forwarded-for`
- **取数唯一出口**：`src/server/admin-api.ts` 的 `adminApi()` = `createNextAdminApiClient()`（`@tokenlens/api-client/next`，每请求新建）；路径白名单 `/v1/*`，禁止页面裸 fetch 直连 admin-api
- **守卫**：`(main)` layout `requireAdmin()`（`GET /v1/me`），失败重定向 `/login`
- 页面路由与 v1 逐条一致：`/dashboard` 总览 + users/providers/channels/models/rate-cards/rate-limits/settings/plans/subscriptions/channel-funds/marketing/referrals/payment-orders/model-market/redeem-batches/notifications/billing-operations/tracing(+topology)/logs/usage-logs/audit-logs；全部 `force-dynamic`
- i18n（next-intl 无路由模式，`messages/{en,zh}.json`）；金额一律字符串（零 IEEE-754）；列表 URL 查询参数持有分页/筛选；server action 返回 `{error?}` 不 throw；链路图 dagre/xyflow 纯前端布局

## 目录结构（src/）

```
app/          # 路由与页面装配（薄壳：取数 + 组 features；含 api/vouchers/:key 内部端点）
features/     # 业务域组件（users/channels/models/billing/tracing/auth/settings/notifications/dashboard）
server/       # BFF adapters 与 server actions（admin-api.ts 唯一调用点、get-admin.ts 守卫、*-actions.ts 按域一文件）
components/   # app 壳与 app-owned 组合件
config/       # app-config / i18n request / 主题 / 侧栏词表
lib/          # 纯前端工具（list-query / money-tone 等）
```

## 配置与端口

- dev 端口 `3002`（`bun x next dev -p 3002`）；生产 `next start -p 3002`，`output: 'standalone'`
- BFF 侧 env（读自 `@tokenlens/api-client/next` 装配层）：

| 变量 | 缺省 | 说明 |
|---|---|---|
| `ADMIN_API_BASE` | `http://localhost:8082` | admin-api 基地址（生产由部署显式注入） |
| `TRUSTED_PROXY_HOPS` | `0` | 反代跳数（解出用户 IP 才回传 `x-forwarded-for`） |
| `SESSION_TTL_SECONDS` | `86400` | `ag_admin_session` cookie 寿命 |

- 协议/厂商词表：providers 页经 admin-api `/v1/vendor-catalog` 消费（单一事实源 = `@tokenlens/ai` 根出口；后端 zod 仍是最终防线）

## 装配与依赖（BFF 模式）

- 运行时能力依赖仅 `@tokenlens/api-client`（wire DTO 手写快照 + `./next` 装配）与 `@tokenlens/ui`（设计系统）；不 import 任何 `@tokenlens/{ai,inference,db,http,runtime,identity,accounts,billing,control-plane,notifications,observability}`
- 业务规则/事务/SQL 全部在 admin-api 身后的能力包；前端只做 wire 调用、表单前置校验与展示

## 本地运行

```bash
bun dev          # 仓库根（turbo 并行；本 app 为 next dev -p 3002）
# 需先起 admin-api（默认 http://localhost:8082，可用 ADMIN_API_BASE 覆盖）
```

## 测试

```bash
cd apps/admin
bun run typecheck && bun run lint && bun run test
bun run test:coverage
```
