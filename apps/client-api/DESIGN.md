# client-api 设计基线（DESIGN）

> 状态：定稿
> 定位：用户控制台 REST API——P5「收紧 apps」wave（总纲 §3 target tree L98-111、§9 P5）
> 旧实现：ai-getway 仓 `apps/client-api`（65 文件 / ~4.5k 生产行 / 51 路由 / 20 测试文件 ~214 用例）
> 关联：`docs/project-structure-refactoring.md` §3/§5/§9 P5 · AGENT.md §0/§11 · IMPLEMENTATION.md · MIGRATION.md

## 1. 外部契约（wire）

- 框架 Hono v4，`@hono/node-server` 承载，默认端口 8081（`CLIENT_API_PORT`）。
- 错误信封统一 `{ error: { code, message, context? } }`；`x-request-id` 服务端生成回显。
- **错误码演进（契约变化，唯一一处系统性变更）**：v1 裸码（`email_taken`）→ 命名空间码
  （`accounts.email_taken` / `identity.invalid_credentials` / `billing.invalid_code` …）。
  依据 ADR-0001（业务错误定义归能力包、app face 装配）与 gateway 同款裁决；新控制台
  （apps/client 尚不存在）按新码消费，api-client DTO 快照不含错误码，无存量消费者受影响。
  状态码语义保持 v1（410/502 等特例经 FaceOverride 表固定，见 IMPLEMENTATION §4）。
- 分页：**用户面钉死 `page`/`limit`**（strict zod——非法值 400，limit 1..100 默认 20）。
  不复用 `@tokenlens/http` 的 `paginationQuerySchema`（page_size 词表 + catch 容错，
  语义不同）；仅复用其上限常量口径（100）。
- 金额一律 JSON 字符串（numeric 全精度）；token 计数为 number；时间 ISO 字符串。
- 列表信封：`{ rows, total, page, limit }`；游标分页（wallet statement）`{ rows, nextCursor? }`。

### 1.1 路由清单（51 条，与 v1 逐条对齐）

| 域 | 路由 | 会话 | 后端对接 |
|---|---|---|---|
| auth | GET /v1/auth/capabilities；POST /v1/auth/{register,register/verify,login,login/verify,logout,password} | 仅 logout/password | identity + accounts 编排（§4） |
| me | GET /v1/me；PATCH /v1/me/display-name | ✓ | accounts.getProfile + wallet.accounts / updateDisplayName |
| keys | GET/POST /v1/keys；PATCH /v1/keys/:id；POST /v1/keys/:id/rotate；DELETE /v1/keys/:id | ✓ | accounts keys 动词 |
| apps | GET/POST /v1/apps；POST /v1/apps/:id/{disable,rotate} | ✓ | accounts apps 动词 |
| orgs | GET /v1/orgs；GET /v1/orgs/:id；POST /v1/orgs/:id/invitations[/:iid/revoke]；POST /v1/orgs/invitations/accept；PATCH /v1/orgs/:id/members/:uid；DELETE …/members/:uid | ✓ | accounts org 动词 |
| wallet | GET /v1/wallet/{accounts,statement} | ✓ | billing.wallet |
| redeem | POST /v1/redeem；GET /v1/redeem/history | ✓ | billing redemption |
| payments | POST/GET /v1/payments/orders[/:id]；GET /v1/payments/channels；POST /v1/payments/notify/:provider | 列表/详情/下单 | billing payments（回调公开） |
| subscriptions | GET /v1/plans（公开）；GET /v1/subscriptions；POST /v1/subscriptions[/:id/{change,renew}] | 除 plans | billing subscriptions + §5 读适配器 |
| usage | GET /v1/usage{,/by-model,/summary,/rate} | ✓ | §5 usage 读适配器 |
| oauth | GET /v1/oauth/providers；GET /v1/oauth/:p/{authorize,callback} | 公开 | identity oauth + accounts 编排 |
| pricing | GET /v1/pricing（公开）；GET /v1/pricing/personal | personal ✓ | §5 pricing 读适配器 |
| referrals | GET /v1/referrals{,/config} | ✓ | accounts.referralOverview + §5 佣金和 |
| health | GET /healthz | 公开 | db ping + redis ping |

## 2. 内部问题域（处理 / 不处理）

**处理**：环境配置与 fail-fast、进程装配、HTTP 协议（契约校验/会话/安全件/错误信封/呈现）、
跨能力只读面组合（§5）、无共享事务的 facade 动词编排（§4）。

**不处理**（归属能力包）：
- 业务规则/事务/SQL → identity/accounts/billing/control-plane 的 domain/application/adapters；
- 资金不变量与结算 → billing（app 永不触 DbTx，facade 不泄漏 Db）；
- 管理面 CRUD → admin-api（另一 app）；
- 跨进程 E2E → 根 `e2e/`（本 app 只留单元/契约/集成测试）。

## 3. 依赖方向

```
apps/client-api（assembly）
 ├─ @tokenlens/http      协议件：errorHandler/securityHeaders/corsPreflight/bodyParserLimit/
 │                       requestIdMiddleware/网络提取/本地化
 ├─ @tokenlens/runtime   logger/cipher/redis/守卫/shutdown/env-schema
 ├─ @tokenlens/observability  initOtel
 ├─ @tokenlens/identity       facade（凭据/挑战/会话/OAuth/吊销）+ 密码纯函数 + 邮件渲染
 ├─ @tokenlens/accounts       facade（资料/Key/App/org/邀请/referral/营销参数）
 ├─ @tokenlens/billing        facade（wallet 读/subscriptions/payments/redemption）
 │                             + Decimal/pickCoefficient 纯函数 + ./composition（仅 assembly/adapters）
 ├─ @tokenlens/control-plane  ./composition 只读目录与费率卡 store（仅 adapters）
 ├─ @tokenlens/db             createDb/ping/closeDb/TxRetryPolicy/pgSqlState（assembly face 专用）
 └─ @tokenlens/errors         目录合成与守卫
```

硬边界（architecture.test.ts 机器执行）：
- `./composition` 只允许出现在 `src/assembly.ts` 与 `src/adapters/*`；
- `@tokenlens/db` 与 `Db|DbTx` 类型只允许在 `{index,config,assembly}` ∪ `adapters/*`；
- `src/http/**` 禁止 import `@tokenlens/{db,billing/composition,…}` 与任何 adapter 内部；
- 跨包 import 只走显式 exports，禁止 `*/src` 深导入。

## 4. 认证编排（跨能力、无共享事务——app face 组合）

- **注册两步制**（v1 语义）：register = 开关闸 → IP 限频（redis 固定窗）→ captcha（缺 token
  app 判 400；其余交 identity.captcha.verify）→ email 占用预检（§5 account-read）→
  `assertPasswordPolicy`（identity 导出纯函数）→ **密码以装配 cipher 封装后存入挑战载荷**
  （挑战库永不落明文，v1「载荷只存哈希」语义的等价保持；verify 时解密走
  `credentials.register` 单次哈希）→ `challenges.begin(email_code)`。
  verify = `challenges.verify` → `accounts.provisionLocalAccount`（409 email_taken）→
  `identity.credentials.register` → `accounts.completeAccountOnboarding`（赠送/归因，best-effort
  不阻断）→ `sessions.sign`。
- **登录**：per-邮箱+IP 爆破锁与 per-IP 失败闸（runtime 守卫，键 `sha256(email:ip)` / ip）包住
  `identity.passwords.authenticate`（内部防枚举统一 invalid_credentials）→ 账户状态读
  （§5）→ 两级登录开关：`challenges.begin` 或 `sessions.sign`（+ lastLogin 落库，§5）。
- **改密**：`identity.passwords.change`（同事务推进吊销线）→ 重签会话返回新 token。
- **会话中间件**：Bearer → `identity.sessions.validate(token,'user')`（验签+jti+锚线，静默
  null）→ 账户状态读（非 NORMAL → 统一 401，不泄原因）。每请求 1 次 validate + 1 次状态读，
  与 v1「属主回查」同量级。
- **OAuth**：authorize/callback 半程归 identity（state 单次存储 + 回调白名单）；cookie 双提交
  比对、`next` 归一（`/` 开头非 `//`，否则 `/dashboard`）、`#token=` fragment 回传、
  find-or-create（`provisionOAuthAccount` + 赠送）与重签会话归 app 路由。

## 5. app-face 读适配器（`src/adapters/*`，gateway adapters 先例）

跨能力只读 join 无单一包归属，先落 app 装配面，后续迁移单元再入包（MIGRATION §8 待办）：

| 适配器 | 内容 | 归属裁决 |
|---|---|---|
| account-read | emailTaken / activeUserStatus / touchLastLogin | accounts 表只读写；后迁 accounts facade |
| billing-read | sumReferralCommission（refType=referral 佣金腿求和） | billing 表读；referralOverview 注释明示「拆归 app 组合 G2」 |
| usage-read | usage 明细/按模型/按日汇总/实时速率（北京时间日桶，tz 配置注入） | usage_logs 为 billing 账本投影；用户面查询词表后迁 billing |
| pricing-read | 模型目录（enabled mappings + 价格富化，Redis 30s 共享缓存）+ 用户费率卡系数快照 | control-plane store + billing pickCoefficient 的 face join（gateway catalog-port 同款） |
| subscription-read | listPlans（公开目录）/ mySubscriptions（个人优先排序 + 剩余额度/剩余价值） | billing 表读；后迁 subscriptions facade |
| redis-rate-counter | 固定窗计数（INCR+EXPIRE NX）——billing RateCounterPort 与注册/兑换闸共用 | runtime 未提供固定窗；纯 redis 机制件 |
| redis-session-revocation / redis-oauth-state | identity 两 port 的 redis 实现（GETDEL 单次消费） | identity 只定义 port |
| smtp-login-mailer | identity Mailer（nodemailer + identity.renderLoginCodeEmail） | identity 未带 SMTP 适配器 |
| turnstile-captcha | identity Captcha（siteverify HTTP） | 同上 |

## 6. 并发与性能预算

- 无长流端点；body ≤ 8MiB（`CLIENT_BODY_LIMIT_BYTES`），content-length 快路径 + 流式计数双闸。
- 每请求同步成本上界：会话链 2 次 DB/Redis 往返 + 业务用例自身；公开 pricing 走 30s 共享缓存。
- Redis 必配 fail-closed：启动 `assertRedisReachable`，不可达拒绝启动（v1 语义）。
- 停机：`runtime.createShutdown`（server.close → otel flush → redis/db 收口，宽限上界可配）。

## 7. 配置

全部部署可变值经 zod env schema 必填或显式默认（铁律 3）：v1 全部键名保留
（DATABASE_URL/REDIS_URL/CLIENT_API_PORT/JWT_SECRET/…），新增 identity 所需
`CLIENT_CODE_PEPPER`（secret 16/32）、`CLIENT_CHALLENGE_{TTL_MS,COOLDOWN_MS,MAX_ATTEMPTS}`、
`CLIENT_PASSWORD_MIN_LENGTH`（默认 10，v1 口径）、`EPAY_PAY_TYPE`（词表校验）、
`CLIENT_USAGE_TZ`（默认 Asia/Shanghai）、`PRICING_CACHE_TTL_MS`（默认 30000）。
生产 fail-fast：SECURE_COOKIE 必开、TOPUP_MIN≤TOPUP_MAX、EPAY/STRIPE/OAUTH 组配置全-or-无。
