# `@tokenlens/notifications`

通知能力包（总纲 §3/P4.1）：渠道 CRUD、事务性 outbox 入箱/认领/投递与告警模板。
「何时告警、payload 语义」归各业务能力，本包只管「怎么送达」。

设计基线 [DESIGN.md](./DESIGN.md) · 施工图 [IMPLEMENTATION.md](./IMPLEMENTATION.md) · 迁移核销 [MIGRATION.md](./MIGRATION.md)

## 核心能力

- **渠道管理**：webhook / email 渠道 CRUD 与订阅词表校验；webhook secret 经 `SecretCipher` 加密落库（enc:v1，与渠道 apiKeyEnc 同口径）
- **事务性发件箱**（notify_outbox）：`enqueue` 按 dedupe_key 唯一幂等入箱；多副本原子认领（`FOR UPDATE SKIP LOCKED` + 租约 fencing 三列）；指数退避 `min(cap, base×2^attempts)`，达上限终态化 failed
- **投递**：按渠道订阅过滤后并行投递；webhook POST + HMAC-SHA256 签名头（`x-notify-signature`，`${timestamp}.${body}`，秒级 timestamp 防重放锚点）/ SMTP 告警文本邮件；部分失败记录渠道进度（jsonb 追加），重试只补失败渠道
- **模板**：告警邮件 subject/text 渲染（品牌注入）
- 事件词表封闭（单一真相 `domain/events.ts`）：`channel_disabled | reconcile_discrepancy | billing_dead | balance_low | context_overflow`

## 入口

| 入口                                   | 内容                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `@tokenlens/notifications`             | facade `createNotifications`（`channels.{list,create,patch,remove,test}` / `enqueue` / `dispatchOnce`）、错误目录 `notifications.*`、领域词表与纯函数（退避/签名/掩码） |
| `@tokenlens/notifications/composition` | `outboxWithinTx(tx)`——业务侧同事务入箱桥（DbTx 不进根出口，仅装配层引用）                          |

## 目录结构（src/）

```
domain/          # 词表 + 渠道形状校验/掩码 + 退避公式/HMAC 签名（零 I/O）
application/     # 用例：enqueue / dispatchOnce / 渠道 CRUD / 逐渠道投递
adapters/        # postgres（notify-store，SQL 与 v1 逐字对齐）/ smtp（nodemailer）/ webhook（SSRF 断言+签名+POST）
ports/           # NotifyStore / EmailSender / WebhookDeliverer / SecretCipher / UrlGuard
templates/       # 告警邮件渲染
composition.ts   # 事务参与桥子入口
```

## 装配与依赖

- facade 参数平铺、全必填注入（铁律 3）：`db` / `cipher`（注入 `runtime.createCipher(key)` 产物）/ `urlGuard`（注入 `ai.assertSafeUrl`——本包禁依赖 ai）/ `logger` / `emailSender?`（缺省 = email 渠道 fail-closed）/ `config`（租约/重试/批量/超时/退避/品牌）
- 编译依赖白名单：`@tokenlens/db`、`@tokenlens/errors`、drizzle-orm（仅 postgres adapter）、nodemailer（仅 smtp adapter）；**禁止**依赖 `ai`、`runtime` 与一切业务能力包（防环，SSRF/cipher 经 port 注入）
- 消费方：入箱 = billing / inference 装配方（gateway/worker 同事务或旁路）；渠道管理路由 = apps/admin-api；投递调度循环 = apps/worker
- 不处理：SMTP 登录验证码邮件（归 identity）、管理端 wire schema（归 admin-api）、审计持久化（随 observability 由装配补）

## 测试

```bash
cd packages/notifications
bun run typecheck && bun run lint && bun run test
bun run test:real       # __test__/postgres.real.test.ts：真实 PG（根 .env 的 DATABASE_URL；不可达整组跳过）
bun run test:coverage   # 阈值 90/85
```
