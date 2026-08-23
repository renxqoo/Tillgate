# @tokenlens/admin-api 施工图

> 状态：实施中（2026-08-23）；设计基线见 [DESIGN.md](./DESIGN.md)，v1 行为规格映射见 [MIGRATION.md](./MIGRATION.md)。
> 施工纪律：本波只创建 `apps/admin-api/**` + 修改 `.env.example`；`packages/*` 与根文件带并行
> gateway 波未提交改动（铁律 15），一律不碰；bun.lock 不入本波提交。

## 0. 与目标树的偏差

- 目录 = 目标树 `src/{index,config,assembly,app,shutdown}.ts + src/http/{contracts,routes,middleware,presenters}/ + error-face.ts`。
- 测试按铁律 14 落包根 `__test__/` 平铺（目标树草图 `test/{contract,integration}` 由铁律 14 统一，
  trace-receiver 先例已记录）。
- 增设 `src/adapters/{upstream-probe,funding-resolver,accounts-bridges}.ts`：装配面桥接件（gateway DESIGN
  同口径，计入 assembly 面——仅 assembly.ts 可引用，architecture 测试锁定；accounts-bridges = D9/D10/G1 三桥）。

## 1. 逐文件裁决表（旧 → 新）

| v1（ai-getway/apps/admin-api/src） | v2（apps/admin-api/src） | 裁决 |
| --- | --- | --- |
| `index.ts` | `index.ts` | 平移：config→assembly→app→serve→信号接线 |
| `config.ts` | `config.ts` | 重写：zod v4 + secretSchema + control-plane/fx/billing 旋钮 + DB 池常量 |
| `assembly.ts`（19 个 service 直组） | `assembly.ts` + `adapters/*` | 重写：能力包 facade 装配 + 审计桥（G1）+ capabilities/probe 注入 |
| `shutdown.ts` | `shutdown.ts` | 形态化：组装 `runtime.createShutdown` 参数（目标树显式文件） |
| `app.ts`（路由挂载 + v1 错误映射表） | `app.ts` + `http/error-face.ts` | 拆分：路由挂载留 app；错误面入 v2 目录体系（composeErrorCatalogs，无 instanceof 翻译表） |
| `middleware/session.ts` | `http/middleware/session.ts` | 平移：Bearer → `identity.sessions.validate('admin')`；属主回查 P2 |
| `middleware/protocol.ts` | `http/middleware/protocol.ts` | 消费货架：`@tokenlens/http` requestId/securityHeaders/cors/bodyLimit |
| `http/error-map.ts` | 删除 | 病灶 E1/E3（instanceof 翻译表）→ errors 目录体系 |
| `http/list-query.ts` | 消费 `@tokenlens/http` listQuerySchema + 各 contracts 白名单校验 | 白名单 400 语义由 contracts 层保持 |
| `http/money-schema.ts` | `http/contracts/common.ts` | 平移（金额 = 十进制字符串，禁 IEEE-754） |
| `routes/users.ts` | `http/routes/users.ts` + `users-funds.ts` + `contracts/users.ts` + `presenters/users.ts` | 拆分；PATCH 的 creditLimit 拆给 wallet.setCreditLimit（app 组合） |
| `routes/keys.ts` | `http/routes/keys.ts` + `contracts/keys.ts` + `presenters/keys.ts` | 平移（D3 偏差见 DESIGN §5） |
| `routes/providers.ts` / `channels.ts` / `models.ts` / `rate-cards.ts` / `fx.ts` / `catalog.ts` | `http/routes/*.ts` 同名 + contracts/presenters | 平移（zod 契约原样收口；service 层删——control-plane 承接） |
| `routes/channel-funds.ts` | `http/routes/channel-funds.ts` | 平移（control-plane recharge/adjust/listRecharges） |
| `routes/subscriptions.ts` | `http/routes/subscriptions.ts` | 动词平移；`GET /v1/subscriptions` P1（D7） |
| `routes/tracing.ts` | `http/routes/tracing.ts` | 平移（observability.traces 信封已吸收 v1 service，S1/B8 已修） |
| `routes/ops.ts`（logs/audit 子集） | `http/routes/ops-logs.ts` | 子集平移；usage/stats/orders/tasks 族 P4 |
| `routes/auth.ts`/`me.ts`/`marketing.ts`/`referrals.ts`/`vouchers.ts`/`notifications.ts`/`redeem.ts`/`plans.ts`/`billing-operations.ts` | — | P2/P3/P1/P5（见 §3） |
| `services/*.service.ts`（21 个） | — | 业务已在 P4 能力包承接；跨包编排（funds）入 users-funds 路由 |
| `domain/{catalog,model-pricing}.ts` | — | control-plane 领域层承接 |
| `routes/ctx.ts`（adminCtxOf） | `http/middleware/session.ts` 导出 `controlContextOf` | 形状转换归中间件层 |

## 2. 施工顺序（本波）

1. 脚手架（package.json/tsconfig/vitest.config）→ 2. config → 3. adapters →
4. assembly（含审计桥）→ 5. error-face/中间件 → 6. contracts → 7. presenters →
8. routes → 9. app/shutdown/index → 10. architecture/config/assembly/session 测试 →
11. 按域契约测试 → 12. real 冒烟 → 13. 四门禁 + boundaries → 14. .env.example + 提交。

## 3. Pending 清单（后续波次，等并行 gateway 波提交后可立即开工）

| # | 事项 | 依赖/接缝 |
| --- | --- | --- |
| P1 | billing 四接缝 + 路由：plans CRUD（`/v1/plans`）、订阅管理列表（`GET /v1/subscriptions`）、兑换批次族（`/v1/redeem-batches*`）、死信单笔复审（`GET /v1/billing-operations?status=dead` + `retry/abandon`，expectedRevision 乐观锁） | 改 `packages/billing/{package.json,src/index.ts}` 等带未提交改动文件（碰撞） |
| P2 | 登录面：`POST /v1/auth/login`（含 2FA 邮箱码）/`login/verify`/`logout`、`GET /v1/me`、`POST /v1/me/password`、`POST /v1/me/two-factor`、`POST /v1/users/:id/set-password`（D6） | identity W2 编排 + control-plane G2 `application/admins` + Redis 爆破件 + 属主回查 W3 |
| P3 | marketing/referrals 路由（accounts 动词已齐） | 本包无接缝，纯路由波 |
| P4 | ops 读侧：usage-logs/stats×3/channel-ttft/generation-tasks/payment-orders(+close) | billing/inference 读侧接缝（observability IMPLEMENTATION §7 记档） |
| P5 | vouchers/notifications 路由 | control-plane voucherStorage 读出口 / `@tokenlens/notifications` |
| P6 | `ai` 根出口补 `vendorProfileNames`（1 行）→ capabilities 全词表 + `/v1/vendor-catalog`（D1） | `packages/ai/src/index.ts` 带未提交改动（碰撞） |
| P7 | e2e 五旅程搬迁（`e2e/admin-journey`、`e2e/billing-recovery`）与 OpenAPI→api-client 生成链 | 全 app 就位 + 总纲 P3/P6 |

## 4. 门禁记录

| 门禁 | 命令 | 结果（2026-08-23） |
| --- | --- | --- |
| typecheck | `bun x tsc --noEmit` | ✅ 0 错 |
| lint | `bun x oxlint` | ✅ 0-0 |
| test（含覆盖率 90/85） | `bun x vitest run --exclude "__test__/*.real.test.ts" --coverage` | ✅ 69/69；lines 97.95 / statements 97.98 / functions 94.81 / branches 92.37 |
| build | `bun run build` | ✅ 37 modules → dist（65KB + sourcemap） |
| real 冒烟 | `bun x vitest run admin-api.real.test.ts`（.env 注入） | ✅ 1/1（真实 PG 装配 + readyz + 401） |
| boundaries | `bun scripts/check-package-boundaries.ts` | ✅ 19 workspace 无深导入/越界 |
| format | `bun x oxfmt --check src __test__ *.ts` | ✅ |
