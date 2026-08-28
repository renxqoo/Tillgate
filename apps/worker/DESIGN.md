# apps/worker — 设计基线（DESIGN）

> 后台任务、调度与生命周期应用（总纲 §3 目标树 L86–96；§9 P4.3/P5）。
> 施工图见 [IMPLEMENTATION.md](./IMPLEMENTATION.md)；迁移记录见 [MIGRATION.md](./MIGRATION.md)。
> 基线：v1 `ai-getway/apps/worker`（八循环 + BullMQ 唤醒 + 健康端点 + 优雅停机）。
> **2026-08-26 增量**：结算环改 BullMQ 调度（毒账单进程隔离，方案见
> IMPLEMENTATION.md「增量：BullMQ 结算调度」节）——worker 不再零 Redis，
> 调度契约见 §2.4/§3.3/§4 修订；其余六 job 节奏模型不变。

## 1. 问题域

**处理**（本 app 是「节奏与生命周期壳」，业务全部来自能力包 facade）：

- 定时驱动七类后台 job（对位 v1 八循环——trace/request_logs 分区两循环
  同节奏同变量，v2 合并为单一 job 双动作）：结算 sweep 入队、滞留恢复、
  生成任务轮询、佣金日结、告警投递、周期对账、分区维护。
- 结算调度（BullMQ）：`LISTEN settle-wake` → 入队；sweep 周期扫描 due 行
  入队（兜 Redis 丢任务/丢通知）；BullMQ Worker 按 jobId=requestId 消费，
  单条结算管线（claim 定向认领 → processClaim）——**进程级毒账单隔离**
  （单条失败绝不杀 worker）与瞬时失败退避重试由 BullMQ 承担。
- 进程健康端点（`/livez` `/readyz` `/health`）与优雅停机（停收批次 →
  在途宽限 → 归还本副本认领 → 连接收口）。

**不处理**（归属）：

- 结算/恢复/对账核验的业务规则 → `@tillgate/billing`（`./settlement` 窄子入口）。
- 生成任务状态机推进与信号顺序不变量 → `@tillgate/inference`
  （`createGenerationPollUseCase`）；worker 只提供节奏与 billing signal 桥。
- 通知单轮投递算法 → `@tillgate/notifications`（`dispatchOnce`）。
- 分区 DDL 与 advisory lock → `@tillgate/observability`（`partitions.*`）。
- 佣金费率/幂等键词表 → `@tillgate/accounts` domain（`getMarketingSettings` /
  `commissionRefId`）；聚合 SQL 与入账 → `@tillgate/billing`。
- HTTP 业务面、鉴权、限流 → gateway / client-api（本 app 无业务 HTTP）。
- TPM 回填 → gateway（inference MIGRATION §5 挂账口径，不迁）。

## 2. 外部契约

### 2.1 消费的能力面（单向 apps → packages）

| 消费面                                         | 用途                                                                                                                                                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@tillgate/billing/settlement` + `composition` | `createSettlementApi`（claim/renew/processClaim/recover/abandonOwnedClaims/verifyInvariants/currentStatus）、`createPostgresWalletStore/BillingStore`、佣金日结用例、对账差异写入用例、`SETTLE_WAKE_CHANNEL` |
| `@tillgate/billing`（根）                      | `createBillingApi` 的 `signal` 四事件（生成任务终态信号桥）、`createWalletApi`（balance_low 钩子读余额、佣金入账）                                                                                           |
| `@tillgate/notifications`                      | `dispatchOnce`（单轮投递）、`enqueue`（reconcile/balance_low 告警入箱）、`composition.outboxWithinTx`（billing 同事务入箱桥）                                                                                |
| `@tillgate/inference`                          | `createGenerationPollUseCase`（超时扫描/查询推进/代执行）、`createUpstreamAi`、`createPostgresGenerationTaskStore`、`createMemoryHealthStore`                                                                |
| `@tillgate/control-plane/composition`          | `postgresChannelStore.findTaskChannel`（按 id 取渠道连接信息——轮询/代执行的上游凭据源）                                                                                                                      |
| `@tillgate/observability`                      | `partitions.traces()/requestLogs()`、OTel 装配                                                                                                                                                               |
| `@tillgate/runtime`                            | `createShutdown`、`createLogger`、`createCipher`、`strictBooleanSchema/secretSchema`                                                                                                                         |
| `@tillgate/db`                                 | `createDb/closeDb/advisoryLock/runTx`、`$client.connect()`（LISTEN 专用连接）                                                                                                                                |

### 2.2 定时器词表（v1 八循环对位、v2 七 job；缺省值 = config 层唯一真相）

| #   | 循环       | 节奏 env                        | 缺省      | 动作                                                                                                                                                                                       |
| --- | ---------- | ------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | settle     | `WORKER_SETTLE_INTERVAL_MS`     | 30_000    | `runSettlementSweep`（扫描 due 行 → BullMQ 入队；不直接结算）                                                                                                                              |
| 2   | recover    | `WORKER_RECOVER_INTERVAL_MS`    | 15_000    | `settlement.recover({batchSize})`（回收行由 settle sweep 周期兜底入队）                                                                                                                    |
| 3   | generation | `WORKER_GENERATION_INTERVAL_MS` | 5_000     | `pollGeneration()`                                                                                                                                                                         |
| 4   | referral   | `WORKER_REFERRAL_INTERVAL_MS`   | 3_600_000 | 佣金日结（7 日窗口回补）                                                                                                                                                                   |
| 5   | notify     | `WORKER_NOTIFY_INTERVAL_MS`     | 15_000    | `dispatchOnce`（`WORKER_NOTIFY_ENABLED=false` 时不挂载）                                                                                                                                   |
| 6   | reconcile  | `WORKER_RECONCILE_INTERVAL_MS`  | 3_600_000 | advisory lock + `verifyInvariants` → 差异表 + 告警入箱                                                                                                                                     |
| 7   | partitions | `WORKER_PARTITION_INTERVAL_MS`  | 3_600_000 | `partitions.traces({retentionDays: TRACE_RETENTION_DAYS})` + `requestLogs({retentionDays: REQUEST_LOG_RETENTION_DAYS})`（v1 两个独立循环同节奏同变量——v2 合并为单一 job 双动作，快照一条） |

完整 env 词表（含批量/租约/退避/令牌/逃生门）以 `src/config.ts` 的 zod schema 为准。

### 2.3 唤醒通道

- 通道名 = `SETTLE_WAKE_CHANNEL`（`@tillgate/billing` 根导出，值 `'settle-wake'`；
  gateway 生产端同值）。worker 是 PG `LISTEN` 消费端，专用连接取自
  `db.$client.connect()`（不进池循环，停机时 release）。
- `WORKER_SETTLE_WAKE=false` 可整体关闭（多测试进程互偷门铃的隔离开关，v1 同款）。

### 2.4 Redis / BullMQ 面（2026-08-26 增量——原「worker 零 Redis」口径废止）

- Redis 连接：`WORKER_REDIS_URL`（缺省回落 `REDIS_URL`），专用 ioredis 实例
  （BullMQ 要求 `maxRetriesPerRequest: null`——不复用 runtime 通用客户端的
  `maxRetriesPerRequest: 1` 形态）。
- 队列：`settlement`（BullMQ Queue，prefix = `WORKER_BULLMQ_PREFIX`，缺省
  `{bull}`；测试/隔离世界注入独立前缀防互踩）。jobId = requestId（天然入队
  去重），无业务 payload——**Redis 不存任何资金状态，PG 是唯一事实源**
  （BullMQ 只承担触发、进程隔离与瞬时失败退避时序）。
- 消费：BullMQ Worker `concurrency = WORKER_SETTLE_CONCURRENCY`（缺省 8）；
  job attempts 上限 = `WORKER_SETTLE_MAX_ATTEMPTS`（缺省 10，保险丝——
  业务死信判定真相仍在 PG `settlement_attempts` + billing 失败策略）。
  failed set 出现结算 job = 缺陷信号（error 日志；不自动处理，sweep 兜底）。

## 3. 调度与生命周期模型

### 3.1 scheduler

- `setInterval` + `timer.unref()`；每 tick 包错误隔离（job 抛错记 error 不崩进程）。
- **无重入保护**（v1 刻意设计）：上一轮未完成时新一轮照常触发——正确性完全
  下沉到 DB（认领 SKIP LOCKED + 租约 + CAS）。本 app 不在进程内加互斥。
- 在途 Promise 用 `Set` 登记（多循环并发时单变量会互相覆盖——v1 教训），
  仅供停机等待。
- `stop()`：拒新批次 → clear 全部 timer → `Promise.race([allSettled(inFlight), 宽限])`。

### 3.2 停机顺序（v1 语义，经 runtime `createShutdown` 收口）

```
SIGTERM/SIGINT → healthServer.close → otel.shutdown
  → closeables: [scheduler.stop（在途宽限）, settleWorker.close（BullMQ 消费端，
                  等在途 job 收口）, settleQueue.close, wakeup.close（LISTEN 连接）,
                  settlement.abandonOwnedClaims（本副本 processing 归还 retry_wait，
                  不等租约自然到期）]
  → redis（BullMQ 专用连接）disconnect → db.end → exit(0)；宽限耗尽 exit(1)
```

`abandonOwnedClaims` 在 db 收口**之前**执行是账务关键步（v1 §1.6）。

### 3.3 结算调度模型（2026-08-26 增量）

- **触发面（三源，全部幂等，jobId=requestId 去重）**：
  ① `LISTEN settle-wake`（解析 payload requestId 定向入队；无载荷/解析失败
  触发一次 sweep）；② settle sweep 定时 job（扫 due 行批量入队——兜 Redis
  丢任务/丢通知/recover 回收行）；③ BullMQ 自身退避重试（瞬时失败后同
  jobId 延迟重投）。
- **处理面（单一真相）**：`processSettlementRequest(requestId)` ——
  `claim({ requestIds: [id], batchSize: 1 })` 定向认领（空认领 = 幂等完成）→
  `processClaim`（结算/失败策略/死信判定全在 billing，与调度层无关）。
  结局映射：`settled/dead/claim_lost` → job 完成；`retried`（瞬时失败，PG 已写
  retry_wait+退避）→ job 抛错交 BullMQ 退避重投；**未知异常** → job 抛错
  （BullMQ 捕获，进程不死——毒账单隔离核心）。
- **计数双真相分工**（裁决落档）：PG `settlement_attempts` = 业务死信判定
  唯一真相（billing 失败策略消费）；BullMQ attempts = 防无限循环保险丝
  （只兜 processor 分类外的逃逸，正常路径永不触及）。
- **单条结算快**（< 秒级，租约 60s）：批式保活 renewTimer 随批处理形态一并
  移除；`renewClaims` API 保留（长结算未来需要时复用）。

## 4. 唤醒消费模型（wakeup/postgres-notify.ts）

- 通知到达解析 payload requestId → 定向入队（入队廉价，无需 coalescing）；
  payload 缺失/非 UUID → 触发一次 sweep 兜底。
- **重连**：LISTEN 专用连接 error/end → 指数退避重连（封顶 30s）。通道故障
  期间结算由 sweep 周期兜底——账务不依赖消息（认领/幂等全在 DB）。
- coalescing/drain（满批排空）随批处理形态移除（BullMQ 天然逐条排空）。

## 5. 错误与可观测

- 本 app 不新建错误目录（无自有业务拒绝；job 异常 = 日志 + 下轮重试）。
- 日志 = runtime `createLogger`（pino，serviceName `worker`）。
- 健康端点（v1 对位 + 轻增强）：
  - `/livez`：进程 running 标志；`/readyz`：scheduler running 且 PG/BullMQ Redis 可达；
  - `/health`：`x-health-token`（timingSafeEqual）守卫的深度报告
    `{owner, running, jobs: {name → {lastStartedAt, lastResult}}}`——
    v1 只有 `{owner, running}`，per-job 快照是 v2 增强（运维排障）。
- balance_low 预警：`onSettled` 钩子查 `wallet.accounts(userId)`，
  余额 < `WORKER_BALANCE_LOW_THRESHOLD` → `notifications.enqueue('balance_low')`
  （dedupeKey 按用户×日幂等；catch 静默——告警不反噬结算）。
  billing_dead 走 billing 内部同事务 outbox（`billing_dead` 词表成员）。

## 6. 装配与测试策略

- `assembly.ts` 是唯一装配根：db/cipher/logger/otel/两套 wallet 实例
  （settlement guards 与 referral guards 分立——v1 同款）/settlementApi/
  signal 桥（哨兵 resolver：authorize 路径在 worker 结构性不可达，抛
  DefectError）/poll 用例/佣金用例/notifications/observability/
  BullMQ queue+worker（结算调度面，2026-08-26 增量）。
- `runners.settle` = sweep 入队 + 同步驱动本次扫到的 due 行（同一
  `processSettlementRequest` 生产函数，不经 BullMQ runtime——E2E/运维直驱
  确定性口径，与「调度只是节奏包装」同哲学）。
- 跨包词表桥接：inference `BillingSignal`（蛇形）↔ billing `BillingEvent`
  （点分）映射在 assembly（与 gateway billing-port 同款映射，两 app 各持
  一份——apps 互不依赖，共享真相是两包的类型本身）。
- rate/refId 桥接：佣金用例的 `rate = accounts.getMarketingSettings()
.referralCommissionRate`、`refIdOf = accounts.commissionRefId`——单一真相
  留在 accounts domain，billing 不依赖 accounts。
- 测试：`__test__/` 平铺；单测（config/scheduler/coalescing/jobs 用 in-memory
  依赖注入）+ `architecture.test.ts`（src 文件集合快照 + Db 类型只在装配面 +
  禁 `composition` 深引用出 assembly）+ `worker.real.test.ts`
  （`DB_TEST_URL`/`DATABASE_URL` 不可达整组 skip；LISTEN→NOTIFY 唤醒全链、
  结算批次、recover、佣金幂等、对账写差异表）。
- 覆盖率阈值 90/85（`src/index.ts` 进程入口豁免——trace-receiver 同口径）。
