# notifications 设计基线（DESIGN.md）

> 状态：定稿
> 迁移单元：通知能力（渠道 CRUD + 事务 outbox 入箱/认领/投递 + 模板）——总纲 §3/P4.1「事件与身份基础」波次
> 旧实现：/Users/wrr/work/ai-getway（repository/notification.repo.ts + worker/tasks/notify-dispatch.ts + admin-api notifications 服务/路由 + gateway/worker 侧入箱调用，约 0.9k 行源 / 11 个旧测试用例）
> 目标位置：packages/notifications
> 关联：IMPLEMENTATION.md（审计 B#/D# 与逐模块裁决）、MIGRATION.md（行为规格与测试矩阵）

---

## 1. 问题域

**处理**：

1. **通知渠道管理**：webhook / email 两类渠道的 CRUD 与订阅词表校验；webhook secret 落库加密（enc:v1 单 key 单格式，与渠道 apiKeyEnc 同口径）。
2. **事务性发件箱（notify_outbox）**：事件入箱（dedupe_key 唯一幂等）、多副本原子认领（FOR UPDATE SKIP LOCKED + 租约 fencing 三列）、指数退避重试、达上限终态化。
3. **投递**：按渠道订阅事件过滤 → webhook POST + HMAC-SHA256 签名头（时间戳防重放）/ SMTP 邮件；部分失败记录渠道进度，重试只补失败渠道。
4. **模板**：告警邮件的 subject/text 渲染（品牌注入）。

**不处理**（写清归属，不留白）：

- **何时触发及 payload 语义**：归各业务能力（billing 的 balance_low/billing_dead/reconcile_discrepancy、inference/gateway 装配的 channel_disabled/context_overflow）。业务侧在同一事务经 `./composition` bridge 或 facade `enqueue` 入箱（总纲 §5.4）。
- **管理端 HTTP 路由与 wire schema**：归未来 apps/admin-api（zod 契约在其 http/contracts）。
- **轮询调度循环与 env 装配**：归未来 apps/worker（interval/enabled/SSRF 双门 env 在装配层）。
- **SMTP 登录验证码邮件**：归 identity 包；本包 EmailSender 只承运维告警文本邮件。
- **审计持久化**：v1 通知用例无审计行；管理操作审计随 observability 波次由 admin-api 装配补（见 MIGRATION §8 待办）。
- **存量明文 secret 回填脚本**：v1 scripts/encrypt-notification-secrets.ts 是一次性运维脚本，留在旧仓（v2 无存量行；新写入恒加密）。

## 2. 外部契约

### 2.1 facade（createNotifications）

参数平铺、结果不嵌套 Db/DbTx/adapter 类型：

```ts
createNotifications({
  db,                                   // Db（内部组装 postgres store，可覆盖 store 用于测试）
  cipher,                               // SecretCipher（装配注入 runtime.createCipher 产物）
  emailSender?,                         // 缺省 = email 渠道 fail-closed（v1 mailer 缺省语义）
  urlGuard,                             // SSRF 断言（装配注入 ai.assertSafeUrl——本包禁依赖 ai）
  logger,                               // warn 面（SSRF 拦截/租约过期/投递失败）
  webhookAllowLocalUrl,                 // 逃生门结果值（装配层双门：env 允许且非生产）
  config: {                             // 铁律 3：全部必填注入，不藏默认
    claimLeaseMs, maxAttempts, loopBatchLimit,
    webhookTimeoutMs, backoffBaseMs, backoffCapMs, emailBrand,
  },
}) => {
  channels: { list / create / patch / remove / test },
  enqueue({ event, payload, dedupeKey }),   // 旁路动词（无 ctx——fire-and-forget 归调用方）
  dispatchOnce({ ctx?, ownerId? }) → { sent, failed },
}
```

### 2.2 事件词表（封闭，单一真相 = 本包 domain/events.ts）

`channel_disabled | reconcile_discrepancy | billing_dead | balance_low | context_overflow`

入箱（enqueue/test）校验词表；渠道订阅校验词表子集。词表封闭性由测试快照锁死；新增事件 = 契约变更，须同步本节。

### 2.3 错误目录（`notifications.*`，AGENT.md §11）

| 码                      | category      | 语义                                                     |
| ----------------------- | ------------- | -------------------------------------------------------- |
| `invalid_channel_input` | invalid_input | 渠道参数不合法（名称长度/类型词表/config 形状/事件词表） |
| `channel_exists`        | conflict      | 渠道重名（PG 23505 结构兜底翻译）                        |
| `channel_not_found`     | not_found     | 渠道 miss（patch/remove/test）                           |
| `unknown_event`         | invalid_input | 事件不在词表内                                           |
| `invalid_outbox_input`  | invalid_input | 入箱参数不合法（dedupeKey 空或超 128）                   |

### 2.4 投递 wire 契约（webhook 接收方）

- Body：`JSON.stringify({ event, timestamp, payload })`，`timestamp` = 秒级 Unix（防重放锚点，接收方自管新鲜窗口）。
- 签名：`HMAC-SHA256(secret, `${timestamp}.${body}`)` 小写 hex，头 `x-notify-signature`；辅助头 `x-notify-delivery`（`${outboxId}:${channelId}`）/ `x-notify-event` / `x-notify-timestamp`。
- secret 是渠道配置密文解密后的明文；客户端提交值一律当明文重加密（防伪装 `enc:*` 内部格式）。

### 2.5 outbox 状态机（db 层不变量，DDL 已在 @tokenlens/db）

```
pending(sent_at NULL, claim 三列 NULL)
  ──claimPending(FOR UPDATE SKIP LOCKED, attempts<max, next_attempt_at 到期, 租约空闲)──▶ claimed(三列非空)
  ──completeClaim(CAS owner+token+租约未过期)──▶ sent(sent_at=now, claim 清空)
  ──failClaim(CAS 同上)──▶ attempts+1；未达上限：释放 claim + next_attempt_at=now+backoff；达上限：sent_at=now 终态 failed
外部副作用成功先 recordDeliveredChannels（CAS 同上，jsonb 追加）——租约随后过期也不重发已成功渠道
```

退避公式（domain 纯函数 `backoffDelayMs`，application 计算后经 `retryDelayMs` 注入 store——公式单一真相在 domain）：`min(capMs, baseMs × 2^attempts)`（v1：base 15s / cap 300s / maxAttempts 3）。

## 3. 并发与性能预算

- 认领一次一行（limit=1/事务）：避免整批排队导致后排租约未执行就过期；单轮上限 `loopBatchLimit`（v1=50）。
- 同一事件的渠道并行投递（Promise.all）：租约上界只受最慢渠道影响，不随渠道数线性累加。
- webhook POST 超时 `webhookTimeoutMs`（v1=10s）；`claimLeaseMs` 必须覆盖 webhook 超时与 SMTP 上界（装配层约束，v1=60s）。
- 入箱是旁路：业务侧 fire-and-forget 场景自行 catch（告警不反噬请求路径——v1 gateway/worker 语义，由调用方保持）。
- 无跨请求内存状态：dispatch 每轮从 DB 取事实（渠道快照在轮首取一次，v1 语义）。

## 4. 端口与适配器

| port               | 实现                                 | 说明                                                                         |
| ------------------ | ------------------------------------ | ---------------------------------------------------------------------------- |
| `NotifyStore`      | `adapters/postgres/notify-store.ts`  | 渠道 CRUD + outbox 五动词（认领 CTE / CAS UPDATE），SQL 与 v1 逐字对齐       |
| `EmailSender`      | `adapters/smtp/nodemailer-sender.ts` | `send(to, subject, text)`；装配注入；缺省 undefined = email 渠道 fail-closed |
| `WebhookDeliverer` | `adapters/webhook/http-deliverer.ts` | SSRF 断言（注入 `UrlGuard`）+ 签名 + fetch POST                              |
| `SecretCipher`     | 装配注入 `runtime.createCipher(key)` | enc:v1 格式单一真相在 runtime（本包不编译依赖 runtime）                      |
| `UrlGuard`         | 装配注入 `ai.assertSafeUrl`          | SSRF 原语单一真相在 ai（本包禁依赖 ai，总纲 §5.1 白名单）                    |

## 5. 依赖白名单

- 编译依赖：`@tokenlens/db`（schema/Db/DbLike/isUniqueViolation）、`@tokenlens/errors`、`drizzle-orm`（仅 adapters/postgres）、`nodemailer`（仅 adapters/smtp）。
- **禁止**：`ai`（SSRF 经 UrlGuard 注入）、`runtime`（cipher 经 SecretCipher 注入）、一切业务能力包（accounts/billing/inference/control-plane——防环，总纲 §5.2）。
- domain 零 I/O；application 只依赖本包 domain/ports；`./composition` 子入口只导出事务参与 bridge（业务侧同事务入箱），`DbTx` 不进根 facade。

## 6. 测试边界

- 默认门禁（无真实凭证）：domain 词表/公式/签名向量、application 用例（内存 store 模拟 CAS/租约/退避）、并发单赢家（v1 notify-concurrency 移植）、错误目录快照、架构分层门禁。
- 真实 PG（`postgres.real.test.ts`，`test:real` 显式运行）：SKIP LOCKED 并发单赢家、CAS fencing（错 token/过期租约零效果）、dedupe 唯一索引、23505 翻译、jsonb 渠道进度追加。
- 覆盖率阈值 90/85（lines/statements/functions 90、branches 85）；排除口径见 vitest.config.ts 注释。
