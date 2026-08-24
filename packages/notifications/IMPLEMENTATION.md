# notifications 施工图（IMPLEMENTATION.md）

> 状态：已完成
> 设计基线：DESIGN.md（外部契约/问题域/并发预算——彼处定义，此处不重复）
> 行为规格来源：MIGRATION.md §1（旧测试清单）

---

## 1. 旧实现审计（v1 /Users/wrr/work/ai-getway）

审计范围：`packages/repository/src/notification.repo.ts`（248 行）、`apps/worker/src/tasks/notify-dispatch.ts`（169 行）、`apps/admin-api/src/services/notifications.service.ts`（174 行）、`apps/admin-api/src/routes/notifications.ts`（78 行）、`apps/gateway/src/ai/overflow-alert.ts`（76 行）、worker index/reconcile 的入箱调用、`scripts/encrypt-notification-secrets.ts`。四条标准（正确性/契约符合/实现质量/依赖方向）逐文件过：

### 1.1 真 bug / 缺陷（B#）

| #   | 位置                                                                                                    | 级别 | 结论                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | service.patch 的 `assertChannelInput`：config 与 type 不同时出现时跳过跨校验                            | 低   | **非缺陷，属分层口径分裂**：路由 zod 的 configSchema.refine 保证了「config 必须形如 url+secret 或 recipients」与 type 无关。v2 收口：domain 校验同时保留两层语义（config 形状独立校验 + type 在场时跨校验），见 §2 裁决 |
| B2  | service.test 的 dedupeKey `test:{id}:{Date.now()}`：同毫秒两次点击第二次被 onConflictDoNothing 静默吞掉 | 低   | **接受（by design 单发不重）**：管理台连点是噪声不是告警丢失；文档留档不改                                                                                                                                              |
| B3  | notify-dispatch email 投递 `Promise.all` 单收件人抛错整体 false                                         | 低   | **接受**：外层 `.catch(() => false)` 兜底；语义 = 该渠道本轮失败可重试，不丢终态                                                                                                                                        |
| B4  | webhook timestamp 无接收方新鲜窗口约定                                                                  | 信息 | **文档化**（DESIGN §2.4）：接收方自管窗口；发送侧不猜                                                                                                                                                                   |
| B5  | v1 词表真相在 admin service，worker/网关侧直接 `db.insert(notifyOutbox)` 绕过词表（合成测试事件直插）   | 中   | **v2 收口**：enqueue 动词统一校验词表；测试合成事件走 store 层（与 v1 测试同等能力，不破坏词表门）；DB 层不加 event CHECK（保留合成事件能力，DDL 不动）                                                                 |

**实测确认**：B1/B2/B3 由代码路径逐行核对；无资金/丢失级缺陷——outbox 写路径经 dedupe 唯一索引 + 同事务入箱，认领/终态 CAS 无窗口。

### 1.2 重复与提取（D#）

| #   | v1 现状                                                                                               | v2 提取                                                                    |
| --- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| D1  | SSRF 断言经 `@ai-gateway/ai` 直依赖                                                                   | `UrlGuard` port 注入（本包禁依赖 ai；真相仍在 ai）                         |
| D2  | encrypt/decrypt 经 `@ai-gateway/core`                                                                 | `SecretCipher` port 注入（真相在 runtime.createCipher，enc:v1 逐字节兼容） |
| D3  | outbox 写入散落 5 处（repo.insertOutboxEvent / gateway overflow×2 / worker index×2 / reconcile 直插） | 统一 `enqueue` 用例 + `./composition` 事务参与 bridge（业务侧单一入口）    |
| D4  | RepoContext 形状（db+requestId+actor）每仓自造                                                        | `DbLike` 参数型（@tillgate/db 收敛，v2 已有）                             |

### 1.3 契约缺口（演进决策）

- 渠道 config 的 zod 细则（url 长度 ≤255/secret 16..255/recipients ≤20、邮箱格式）属 wire 契约，随 admin-api 波次迁其 `http/contracts`；本包 domain 承形状与词表校验（无 zod 依赖）。
- 渠道管理操作无审计行（v1 现状）——G1：随 observability/admin-api 波次由装配补 audit sink（本包 verbs 已带 ctx 锚）。

## 2. 逐模块裁决表

| v1 文件                                                        | 裁决      | 审计状态              | 动作                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | --------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| repository/notification.repo.ts                                | 复制+微修 | 通过（B5 相关行见上） | SQL 逐字迁 `adapters/postgres/notify-store.ts`；RepoContext→DbLike；行类型改 `ChannelRecord/ClaimedNotification`（不泄 db 行类型）                                                                                                                     |
| worker/tasks/notify-dispatch.ts                                | 重构      | 通过                  | 循环算法逐语义迁 `application/dispatch-once.ts`；`deliver()` 拆分：解密→application（cipher port）、SSRF+签名+POST→`adapters/webhook/http-deliverer.ts`、签名纯函数→domain；硬编码 3/50/10s/15s/300s/60s→config 必填注入（铁律 3）；邮件渲染→templates |
| admin-api services/notifications.service.ts                    | 重构      | 通过（B1/B2 见上）    | 校验沉 `domain/channel.ts`；掩码（****+尾4，密文口径）沉 domain；23505→`channel_exists`；AppError→错误目录                                                                                                                                             |
| admin-api routes/notifications.ts                              | 不移植    | —                     | wire 契约归未来 admin-api（§1.3）                                                                                                                                                                                                                      |
| gateway overflow-alert.ts 两个 wirer                           | 不移植    | —                     | 消费方装配（gateway/worker 波次经 facade/composition 入箱）；行为规格在 MIGRATION §8 留档                                                                                                                                                              |
| worker index 的 balance_low/billing_dead 钩子与 reconcile 入箱 | 不移植    | —                     | 同上（billing/worker 波次）                                                                                                                                                                                                                            |
| scripts/encrypt-notification-secrets.ts                        | 不移植    | —                     | 一次性运维脚本留旧仓（DESIGN §1）                                                                                                                                                                                                                      |
| identity/mailer.ts 的 send() 通用面                            | 复制+微修 | 通过                  | `adapters/smtp/nodemailer-sender.ts` 仅承 `send(to,subject,text)`（验证码渲染归 identity）                                                                                                                                                             |

## 3. 目标目录

```
packages/notifications/
├── src/
│   ├── domain/events.ts          # 词表 + 守卫（封闭单一真相）
│   ├── domain/channel.ts         # 渠道形状校验/掩码/加密侧归一
│   ├── domain/delivery.ts        # 退避公式/HMAC 签名/头构造/目标渠道筛选
│   ├── application/context.ts    # NotifyContext（requestId+actor 锚）
│   ├── application/enqueue.ts    # 入箱（词表门+dedupe 幂等）
│   ├── application/dispatch-once.ts # 认领→过滤→并行投递→进度→终态（v1 算法）
│   ├── application/deliver-to-channel.ts # 单渠道投递分派（v1 deliver 类型分支；铁律 5 拆分）
│   ├── application/list-channels.ts / create-channel.ts / patch-channel.ts /
│   │   remove-channel.ts / test-channel.ts
│   ├── ports/notify-store.ts     # 渠道 CRUD + outbox 五动词（DbLike 参数型）
│   ├── ports/email-sender.ts / webhook-deliverer.ts / secret-cipher.ts / url-guard.ts
│   ├── adapters/postgres/notify-store.ts
│   ├── adapters/webhook/http-deliverer.ts
│   ├── adapters/smtp/nodemailer-sender.ts
│   ├── templates/alert-email.ts  # 告警邮件渲染（品牌注入）
│   ├── notifications.ts          # createNotifications facade
│   ├── composition.ts            # 事务参与 bridge（业务同事务入箱；DbTx 不进根出口）
│   └── index.ts
└── __test__/                     # 平铺（铁律 14）；*.real.test.ts 默认门禁排除
```

## 4. 关键实现口径（防漂移）

1. **dispatch 循环**（与 v1 逐语义对齐）：轮首取活跃渠道快照一次 → 循环 `loopBatchLimit` 次：单行认领（独立事务）→ 无行即停 → 词表+进度过滤目标渠道 → 空 = completeClaim 终态 → 并行投递 → recordDeliveredChannels（false=租约过期，warn+continue）→ 全成功 completeClaim（sent+1）/否则 failClaim（failed+1）。failClaim 的退避/终态判定在 SQL 侧（store），公式常量由 config 注入。
2. **webhook fail-closed 链**：url 非字符串/空 → false；SSRF 断言抛错 → warn+false；secret 非 `enc:` 前缀或 cipher 缺失 → false；解密抛错 → false；响应非 2xx → warn+false。
3. **email fail-closed**：recipients 过滤后为空或 emailSender 缺失 → false；否则逐收件人并行发送。
4. **渠道进度**：`recordDeliveredChannels` 空数组恒 true（无操作）；成功渠道 id jsonb 追加（CAS 保护）。
5. **create/patch 掩码口径**：落库密文，返回/列表一律 `****+尾4`（掩的是密文尾4——可辨认不可复用）；patch 不带 secret 键时 config 整体替换（v1 语义，PUT 口径）。
6. **test 动词**：事件 = 渠道首订阅事件；dedupeKey `test:{channelId}:{now-ms}`；payload `{test:true, channel:name}`。

## 5. 测试计划

| 新测试                    | 承载规格                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| domain.test.ts            | 词表封闭快照、渠道校验矩阵（表驱动）、掩码、退避公式表、HMAC 已知向量、头集合、目标渠道筛选                  |
| channels.test.ts          | CRUD 全行为（B1 口径、23505→exists、404 族、掩码、test 入箱形状、加密落库）                                  |
| enqueue.test.ts           | 词表拒绝、dedupe 幂等（同键一行）、参数域                                                                    |
| dispatch.test.ts          | 终态/退避/上限失败/租约过期中途/邮件与 webhook fail-closed 链/并行渠道/循环上限                              |
| concurrency.test.ts       | v1 notify-concurrency 两用例移植（单副作用赢家、部分失败重试不重发）                                         |
| webhook-deliverer.test.ts | http 适配器直击（stub fetch）：签名头口径、SSRF 拦截、allowLocal 透传、非 2xx/网络异常收敛、空 url           |
| facade.test.ts            | 默认装配路径（http 投递器缺省构造）、ownerId 缺省、投递器抛错收敛、未知类型兜底、非 23505 透传、空事件表回退 |
| errors.test.ts            | 目录码快照（封闭）                                                                                           |
| architecture.test.ts      | 分层 import 门禁 + 根出口不泄 Db/DbTx/adapter（accounts 同款）                                               |
| postgres.real.test.ts     | SKIP LOCKED 并发单赢家、CAS fencing、dedupe 索引、23505、jsonb 追加、渠道 SQL 行为                           |

## 6. 实施顺序

1. domain 三件 + errors → 2. ports 五件 → 3. application 七件 + templates → 4. adapters 三件 + facade + composition → 5. 测试全套 → 6. 四门 + 覆盖率核销。
