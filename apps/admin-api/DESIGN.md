# @tokenlens/admin-api 设计基线

> 状态：定稿（2026-08-23；admin-api 迁移波 = 重构方案 §3 目标树 `apps/admin-api` + P5 第三个 app）
> 旧实现：`/Users/wrr/work/ai-getway/apps/admin-api`（app 层约 6.8k 行 + 27 个测试文件；
> 21 个 service 的业务规则已由 P4 波次 `@tokenlens/{accounts,control-plane,billing,observability,identity}` 承接）
> 施工图见 [IMPLEMENTATION.md](./IMPLEMENTATION.md)；行为规格与偏差核销见 [MIGRATION.md](./MIGRATION.md)。

---

## 1. 定位与迁移单元

管理控制面 REST API（端口沿用 v1 `8082`）：管理员经会话 JWT 鉴权，对用户/Key、
Provider/Channel/Model/RateCard/fx/目录、订阅资金与链路观测做管理读写。
**业务规则零重写**——全部经能力包 facade（P5：app 只保留 config、assembly、协议路由、
中间件、presenter 与生命周期），唯一例外是 v1 funds/keys 等跨能力编排，按 §5 裁决在
路由层组合 facade（组合不是第二套业务规则）。

本波迁移单元（垂直用例）：「管理员持有效 admin-realm 会话，完成六域读写——
users/keys（accounts + billing 钱包读侧）、providers/channels/channel-funds（control-plane）、
models/rate-cards/fx/catalog（control-plane）、billing 订阅动词 + 用户资金动词（billing）、
tracing/audit/logs（observability）」。

**本波范围边界（重要）**：因并行 gateway 波在 `packages/*` 带未提交改动（铁律 15），
本波只落零接缝部分；billing 四接缝（plans CRUD/订阅管理列表/兑换批次/死信单笔复审）、
登录面（auth/me）、marketing/vouchers/notifications、ops-stats/payments 读侧延后，
见 IMPLEMENTATION.md §3 pending 清单 P1–P7。

## 2. 外部契约

### 2.1 HTTP 面（v1 逐路径等价；⭐ = 本波落地）

| 路径 | 说明 | 数据来源 |
| --- | --- | --- |
| ⭐ `GET /v1/users`、`GET /v1/users/:id`、`PATCH /v1/users/:id` | 用户列表（钱包富化）/资料/补丁（封禁语义；creditLimit 另走 wallet.setCreditLimit） | `accounts.admin*` + `billing.wallet.accounts/setCreditLimit` |
| ⭐ `POST /v1/users/:id/adjust`、`POST /v1/users/:id/gift` | 调账（可负）/赠送；幂等键 + 同事务审计 | `billing` operations + `wallet.credit/transfer` + observability `writeAudit`（装配闭包注入） |
| ⭐ `GET /v1/users/:id/transactions`、`GET /v1/users/:id/audit-logs` | 钱包流水/用户审计 | `wallet.statement` / `observability.audit.listByTarget` |
| ⭐ `GET /v1/admin-keys`、`PATCH /v1/admin-keys/:id` | Key 全量列表/补丁 | `accounts.adminListKeys/adminPatchKey` |
| ⭐ `GET|POST /v1/providers`、`PATCH|DELETE /v1/providers/:id` | 供应商 CRUD/软退役 | `controlPlane.providers.*` |
| ⭐ `GET|POST /v1/channels`、`PATCH|DELETE /v1/channels/:id` | 渠道 CRUD（apiKey 加密落库）/软退役 | `controlPlane.channels.*` |
| ⭐ `POST /v1/channels/import`（≤1000）、`POST /v1/channels/:id/test` | 批量导入/连通性探针 | `channels.import/probe` |
| ⭐ `GET /v1/channel-funds`、`POST /v1/channel-funds/recharge`、`POST /v1/channel-funds/adjust` | 渠道资金流水/进货/调账 | `channels.listRecharges/recharge/adjust` |
| ⭐ `GET|POST /v1/models`、`PATCH|DELETE /v1/models/:id`、`POST /v1/models/:id/channels`（≤500）、`POST /v1/models/:id/test` | 模型映射 CRUD/绑定/探针 | `controlPlane.models.*` |
| ⭐ `GET|POST /v1/rate-cards`、`PATCH|DELETE /v1/rate-cards/:id`、`GET /v1/rate-cards/:id/users`、`GET /v1/rate-cards/:id/health` | 费率卡族 | `controlPlane.rates.*` |
| ⭐ `GET /v1/fx/catalog`、`POST /v1/fx/catalog/refresh`、`PUT|DELETE /v1/fx/catalog/override`、`PUT /v1/fx/catalog/buffer` | 汇率状态/动作 | `controlPlane.fx.*` |
| ⭐ `GET /v1/model-catalog/sources|price-history|:sourceId`、`POST /v1/model-catalog/import` | 目录源/比对/导入 | `controlPlane.catalog.*` |
| ⭐ `POST /v1/subscriptions/:id/renew|change|cancel|grant` | 订阅管理动词（`userId:null` 管理面直续） | `billing.subscriptions.*` |
| ⭐ `GET /v1/tracing/recent|traces/:traceId|by-request/:requestId|topology|stats` | 链路五查询 | `observability.traces.*` |
| ⭐ `GET /v1/audit-logs`、`GET /v1/logs` | 审计/请求日志列表 | `observability.audit/requestLogs` |
| `/healthz /livez /readyz` | 探针（healthz/readyz 查 DB；livez 纯 200） | `pingDb` 闭包 |
| P2–P7 | auth/me/login、plans、订阅列表、redeem 批次、billing-operations、marketing/referrals/vouchers/notifications、usage-logs/stats/generation-tasks/payment-orders | 见 IMPLEMENTATION §3 |

统一列表契约（v1 §4 等价）：`?page=&page_size≤100&q&sort_by&order`；信封 `{rows,total,page,pageSize}`；
`sort_by` 白名单外 → 400（`admin.invalid_sort_field`）；分页参数非法值容错回退不 400。

### 2.2 鉴权（admin realm 会话；validate-only）

`Authorization: Bearer <JWT>` → `identity.sessions.validate(token,'admin')`（HS256 验签 +
issuer/realm 比对 + jti 吊销 + 锚点线）。通过则注入 `adminId`；失败统一 401 不区分原因
（不泄漏管理账号状态）。**属主回查（admins.status）为 identity W3 pending**——本波会话
验证语义 = identity 现行契约（验签 + jti + 锚点线），落 P2。探针路径豁免鉴权。
无 Cookie 无 CSRF（管理台自持 Bearer）。

### 2.3 错误信封与码表

- 信封 `{"error":{"code","message"}}`，message 英文（铁律 18），`context` 仅必要提示携带。
- 目录合成：`composeErrorCatalogs(HttpErrors, AccountsErrors, controlPlaneErrors, BillingErrors,
  observabilityErrors, identityErrors, AdminErrors)` + `pgSqlState` 注入（error-face.ts）。
- app 自有目录 `AdminErrors`（`admin.*`）：`invalid_param`(400)、`invalid_sort_field`(400)、
  `user_not_found`(404)、`catalog_source_not_found`(404)。
- v1 裸码 → v2 命名空间码映射逐条核销于 MIGRATION §3（如 `user_not_found` →
  `accounts.user_not_found` 或 `admin.user_not_found`，按首个抛出者归属）。

### 2.4 装配形态

- DB 池常量居 config（管理面低流量写多读少：poolMax 10）；`DATABASE_URL` 必填（零缺省）。
- 秘密三件：`ADMIN_JWT_SECRET`（admin realm HS256，secretSchema ≥32）、`ENCRYPTION_KEY`
  （渠道上游 Key AES-256-GCM，经 `runtime.createCipher`）、`IDENTITY_CODE_PEPPER`
  （identity 挑战/恢复码 HMAC pepper，≥16——identity 配置必填项，本波不触发挑战但形状必须合法）。
- Redis 本波不装配（validate-only 会话无需共享吊销面;`REDIS_URL`/`TRUSTED_PROXY_HOPS` 键随 P2
  登录波引入——无消费方不进配置面,铁律 4）。
- OTel `off|otlp`（缺省开发 memory / 生产 off，显式配置优先；otlp 缺端点启动期 fail-fast）。
- control-plane 装配：`capabilities.protocols = ai.SUPPORTED_PROTOCOLS`；
  `probe` = app `src/adapters/upstream-probe.ts`（每次探针新建 `ai.createAi()` 实例——内存态隔离）；
  目录源 = `@tokenlens/control-plane/composition` 内置 `modelsDevSource` + `createOpenRouterSource`
  （composition 子入口仅 assembly.ts 引用）；fx 拉取源 URL/TTL/超时经 config 注入（ECB/frankfurter 公共源）。
- identity 配置：realms `['admin']`；identifiers `['email']`；providers `['github']`（词表占位，
  无凭据——oauth 动词本波不可达）；challengeKinds `['admin_login_code']`（登录波 P2 消费）。
- billing 装配：`createPostgresBilling`（composition）；`guards = {refTypes:['billing','topup','admin'],
  currencies:['CNY'], internalAccounts:['outside','platform_revenue']}`；`resolver` = 显式红灯
  （admin 面无推理授权链，见 §5 裁决 D2）；`onError` = logger。
- 审计桥（observability G1，落点即本波 assembly）：`writeAudit`/`createBestEffortAuditSink`
  → accounts `auditSink` 与 control-plane `env.audit`（best-effort 运营审计）。

## 3. 问题域（处理 / 不处理）

**处理**：HTTP 协议适配与入参校验（zod contracts）、admin 会话校验中间件、列表信封与排序白名单、
行 → wire DTO 的 presenter 投影、跨 facade 编排（调账/赠送幂等 + 同事务审计、creditLimit 拆分）、
装配与生命周期（config/assembly/index/shutdown）。

**不处理**（归属）：

| 不处理项 | 归属 |
| --- | --- |
| 用户/Key/组织的业务规则与持久化 | `@tokenlens/accounts` |
| Provider/Channel/Model/RateCard/fx/目录配置规则 | `@tokenlens/control-plane` |
| 钱包/订阅/结算/兑换的资金定律 | `@tokenlens/billing` |
| 凭证/会话/挑战/MFA 语义 | `@tokenlens/identity` |
| trace/审计/请求日志的存储与查询 | `@tokenlens/observability` |
| HTTP 中间件货架/错误渲染/分页解析 | `@tokenlens/http`、`@tokenlens/errors` |
| 优雅停机/日志/OTel/秘密校验 | `@tokenlens/runtime` |
| 登录编排（限流/防暴破/2FA 邮箱码/审计） | P2（identity W2 + control-plane G2） |
| 管理台前端（链路图等数据消费） | P5 后续 `apps/admin`，经本 API + `api-client` |

## 4. 测试与门禁

`__test__/` 平铺（铁律 14）：architecture（文件清单 + composition/Db 引用规则机器锁）、
config（表驱动缺省/fail-fast）、assembly（fail-fast 与桥接形状）、session（401/豁免）、
按域契约测试（fake facade + `app.request()`，断言 v1 wire 形状与错误码——行为规格源自
v1 测试文件，映射见 MIGRATION §2）、`admin-api.real.test.ts`（真实 PG 冒烟，不可达优雅跳过）、`e2e.real.test.ts`（真实进程端到端：
spawn `bun --conditions=development src/index.ts` + 真实 PG + identity 签发真 admin 令牌——六域全链、
幂等重放/409、审计桥落库、优雅停机；同样不可达优雅跳过。注：bun 运行时默认不应用 exports 的
development 条件，真实进程启动须显式 `--conditions=development` 或先构建 dist）。
覆盖率门槛 90/85（lines/statements/functions 90、branches 85）；四门禁 typecheck/lint/test/build
+ 根 boundaries 脚本。

## 5. 裁决记录（本波有意为之，非遗漏）

| # | 裁决 | 依据 |
| --- | --- | --- |
| D1 | `capabilities.vendorProfiles = []`：providers 的 `vendor` 引用本波被拒（`control_plane.invalid_vendor`）；`/v1/vendor-catalog` 端点整体延后 P6 | `ai` 根出口尚无 `vendorProfileNames` 导出（1 行接缝，文件带并行波未提交改动，铁律 15 不碰）；词表不得在 app 复制（双事实源禁令） |
| D2 | billing `resolver` 显式红灯（调用即 infra 500 语义） | resolver 唯一消费方是推理授权链（gateway 面）；admin 面无此路径。gateway 波的 accounts funding-resolver 落地后按需桥接 |
| D3 | keys 列表 `userEmail/userDisplayName` 恒 null | `accounts.listAdminKeys` 返回 `ApiKeyRecord` 无用户 join；enrichment 接缝归 accounts（P4 补充波） |
| D4 | transactions `total = offset + rows.length`（末页精确） | v1 有独立计数查询；`wallet.statement` 无 count 动词（billing 接缝，随 P1 评审） |
| D5 | 审计行 `adminSubject` 恒 null、请求日志行无 `attempts` | observability 查询行无此二列；enrichment 归 observability（G 项随 P1 记） |
| D6 | `POST /v1/users/:id/set-password` 延后 P2 | v1 语义含「绑标准费率卡 + 全网会话下线」跨包编排，归登录/凭证波一并落 |
| D7 | `GET /v1/subscriptions`（管理列表）延后 P1 | billing 接缝（AdminSubscriptionRow 需 user/plan join） |
| D8 | session 属主回查延后 P2（identity W3 现行契约 = 验签+jti+锚点线） | identity MIGRATION 已留档 |
| D9 | accounts 三桥（walletCredit 独立事务/sessionInvalidation 后置推进/审计同事务）落 `src/adapters/accounts-bridges.ts` | gateway 波 accounts composition 在途（铁律 15 不碰）;admin 面不触达赠送/推荐动词 |
| D11–D15 | wire 空值族（列表 rateCardName/渠道三列/模型两列/createdBy 恒 null;displayName 拒 null） | 逐条核销于 MIGRATION §4——列/enrichment 归属能力包,不在 app 造 join |
