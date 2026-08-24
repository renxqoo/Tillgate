# notifications 迁移文档（MIGRATION.md）

> 状态：已核销
> 迁移单元：通知能力（渠道 CRUD + 事务 outbox 入箱/认领/投递 + 模板）——一个可观察业务行为族
> 旧实现：/Users/wrr/work/ai-getway（repository/notification.repo.ts、worker/tasks/notify-dispatch.ts、admin-api notifications 服务+路由、gateway overflow-alert、worker/reconcile 入箱调用；~0.9k 行源）
> 目标位置：packages/notifications
> 关联：DESIGN.md（契约基线）/ IMPLEMENTATION.md（审计 B#/D# 与裁决表）

## 0. 测试迁移总矩阵（旧文件 → 新去处）

| 旧测试（用例数）                                                  | 新去处                                                         | 动作                                                                                                             |
| ----------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| worker `__tests__/notify-concurrency.test.ts` (2)                 | `__test__/concurrency.test.ts`                                 | 改写：fake repo→内存 store；dispatch 入参换 config 注入                                                          |
| worker `__tests__/parity-loops.test.ts` ①④ (3)                    | `__test__/dispatch.test.ts` + `__test__/postgres.real.test.ts` | 拆分：HMAC 签名口径/无订阅终态化/退避上限入默认门禁（内存 store）；真实 SQL 语义（SKIP LOCKED/dedupe）入 real 门 |
| gateway `__tests__/overflow-alert.test.ts` (2)                    | 不迁                                                           | 消费方装配行为（gateway 波次经 facade 入箱后在其 e2e 承接）；入箱幂等语义由 enqueue.test.ts 承担                 |
| admin-api `ops.test.ts` notifications (1)                         | `__test__/channels.test.ts`                                    | 改写：HTTP 断言→facade 断言（400/409/404 语义经错误目录）                                                        |
| admin-api `ops-coverage.test.ts` 通知 email 渠道 (1)              | `__test__/channels.test.ts`                                    | 改写：未知事件 400/miss 404/email 渠道形状                                                                       |
| worker `reconcile.test.ts` / `units.test.ts` / `ops.test.ts` 其余 | 不迁                                                           | 非通知能力（billing/对账波次）                                                                                   |

**删除的旧用例**：无（通知域行为全部有落位）。**新增门禁**：词表封闭快照、错误目录快照、架构分层门禁、真实 PG fencing/并发（v1 无直测、SQL 语义原先靠 parity 真库间接覆盖）。

## 1. 行为规格基线（等价判定标准）

**渠道管理**：email 渠道缺 recipients → invalid_input；webhook 需 url+secret；事件词表外 → invalid_input；创建 201 语义（含密文落库、返回掩码）；重名 → conflict（channel_exists）；PATCH status/events/config 生效（config 整体替换、secret 重加密、type 不可改）；patch/remove/test miss → not_found；test 入箱行存在（dedupeKey `test:{id}:%` 前缀、payload.test=true）；删除后行不存在；列表 secret 恒掩码。

**投递**：webhook POST 带 `x-notify-signature` = HMAC-SHA256(secret, `${timestamp}.${body}`)；无订阅渠道事件终态化（sent_at 置位不再扫描）；投递失败 attempts+1 + 退避（`min(300s, 15s×2^attempts)`）；达上限（3）终态 failed（sent_at 置位 + last_error）；同事件多渠道并行、部分失败只重试失败渠道（deliveredChannelIds 进度，已成功渠道不重发）；租约过期时进度/终态 CAS 零效果（不计数、等待重领）。

**并发**：两 worker 同时扫描同一事件只有一次外部副作用（原子认领）；认领一次一行；单轮上限 50 行。

**入箱**：dedupe_key 唯一幂等（balance-low 按用户×日一行的 v1 语义由调用方键设计保证，机制=onConflictDoNothing）；事件词表外拒绝；入箱为旁路不反噬调用方（fire-and-forget 由调用方持有）。

**fail-closed 链**：webhook url 空/SSRF 拦截/secret 非 enc:/解密失败/响应非 2xx → 该渠道本轮 false；email recipients 空/邮件器缺省 → false。

## 2. 审计结论

引用 IMPLEMENTATION.md §1：B1（patch 跨校验分裂→domain 收口）、B2（test 同毫秒 dedupe 吞并→接受留档）、B3（email 单收件人抛错整体 false→接受）、B4（接收方新鲜窗口→文档化）、B5（词表绕过→enqueue 统一门）；D1 SSRF/D2 cipher→注入 port、D3 outbox 写入散落→enqueue+composition 单一入口。

## 3. 逐模块裁决表

见 IMPLEMENTATION.md §2（复制+微修/重构/不移植逐文件，含理由）。

## 4. API 对照

| 旧签名                                                                                                                 | 新签名                                                                                                      | 变化理由                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `NotificationRepository.listActive/list/findById/insert/patch/remove(c: RepoContext, …)`                               | `NotifyStore.listChannels/findChannel/insertChannel/patchChannel/removeChannel(db: DbLike, …)`              | D4 参数型；行类型不泄 db 形状                                                                                         |
| `NotificationRepository.claimPending/recordDeliveredChannels/completeClaim/failClaim`                                  | 同名（NotifyStore 成员）                                                                                    | SQL 逐字保留（CTE/CAS/退避表达式）                                                                                    |
| `runNotifyDispatchOnce(db, logger, mailer?, {encryptionKey, webhookAllowLocalUrl, ownerId, claimLeaseMs, repository})` | `notifications.dispatchOnce({ ctx, ownerId? })`（facade 持 config/ports）                                   | 依赖全装配注入；硬编码 3/50/10s/15s/300s → config 必填（铁律 3）；encryptionKey→SecretCipher；SSRF bool→UrlGuard 注入 |
| `deliver(deliveryId, type, config, event, payload, …)`（导出供直测）                                                   | `WebhookDeliverer.deliver({url, secret, event, payload, deliveryId})` + application 内 email 分支           | 解密沉 application、SSRF/签名/POST 沉 adapter（§2 裁决）                                                              |
| `createNotificationsService({encryptionKey, db, repos?})` → `{list,create,patch,remove,test}`                          | `createNotifications(…)` → `channels.{list,create,patch,remove,test}`                                       | AppError→错误目录；zod 细则归 admin-api 契约                                                                          |
| `NOTIFY_EVENTS`（admin service 导出）                                                                                  | `domain/events.ts` `NOTIFY_EVENTS`                                                                          | 词表单一真相随能力包（B5）                                                                                            |
| gateway/worker/reconcile 直插 `db.insert(notifyOutbox)`                                                                | `notifications.enqueue({ctx,event,payload,dedupeKey})`；同事务场景经 `@tillgate/notifications/composition` | D3 单一入口                                                                                                           |

## 5. 测试迁移矩阵

见 §0（旧→新逐行，动作含改写要点）。

## 6. 回滚方案

- 本包为新增（旧仓只读不动），revert 即整体还原；无 DDL 变更（notification_channels/notify_outbox 迁移已在 @tillgate/db 先行合入）。
- bun.lock 为多会话共写文件：nodemailer/@types 依赖条目落 lock 但不随本波提交（ironlaw 15——与 control-plane 波同口径，协调后收口）。

## 7. 验收（核销记录，2026-08-23）

- 四门全绿：typecheck ✓ / oxlint 0 err ✓ / build ✓ / test 默认门禁 **89/89** + 真实 PG 门禁 **10/10**。
- 覆盖率（v8，排除口径见 vitest.config.ts 注释）：**statements 97.79 / branches 94.89 / functions 100 / lines 98.73**（阈值 90/85/90/90）。
- §1 行为规格逐项核销：
  - 渠道管理：email 缺 recipients 400 语义（invalid_channel_input）✓ channels.test；webhook url+secret ✓；词表外事件 400 ✓；重名 409 语义（channel_exists，PG 23505 结构兜底）✓ channels+real；PATCH status/events/config（整体替换+重加密+掩码、type 不可改）✓；miss 404 族（patch/remove/test）✓；test 入箱形状（`test:{id}:{ts}`、payload.test、首事件）✓ channels+real；删除后行不存在 ✓；列表 secret 恒掩码 ✓。
  - 投递：HMAC 签名口径（`${ts}.${body}` 自洽验签）✓ domain+webhook-deliverer；无订阅终态化 ✓；退避 `min(300s,15s×2^attempts)` ✓（公式表 + 失败路径实测）；上限 3 终态 failed（sent_at+last_error）✓ dispatch+real；多渠道并行、部分失败只重试失败渠道 ✓ concurrency；租约过期 CAS 零效果不计数 ✓ dispatch+real；认领一次一行、单轮上限 ✓ dispatch。
  - 并发：双 worker 单副作用 ✓ concurrency；真实 PG SKIP LOCKED 单赢家 ✓ real。
  - 入箱：dedupe 幂等（同键一行）✓ enqueue+real；词表外拒绝 ✓；旁路语义由调用方持有（composition 文档化）✓。
  - fail-closed 链：url 空/SSRF 拦截/secret 非 enc:/解密失败/响应非 2xx/网络异常 ✓ dispatch+webhook-deliverer；email recipients 空/邮件器缺省/非字符串过滤 ✓ dispatch。
- B# 处置：B1 domain 收口（校验矩阵表驱动锁定）✓；B2/B3 接受留档（IMPLEMENTATION §1.1）✓；B4 文档化（DESIGN §2.4）✓；B5 enqueue/composition 统一词表门 ✓。
- 回归用例：无 v1 真 bug 需回归（审计结论无资金/丢失级缺陷）；新增门禁 4 项（词表/目录/架构/真实 PG fencing）。

## 8. 待办（后续波次，非本单元缺口）

1. 消费方接线：gateway（context_overflow/channel_disabled 经 AiEvent 订阅入箱）、worker/billing（balance_low/billing_dead/reconcile_discrepancy 同事务入箱）——各自波次经 facade/composition。
2. admin-api 通知路由与 zod 契约（wire 层）。
3. worker 轮询调度装配（interval/enabled/SSRF 双门 env）。
4. 渠道管理审计行（observability 波次，verbs 已带 ctx）。
5. v1 存量明文 secret 回填（运维脚本，旧仓持有）。
