# apps/worker — 施工图（IMPLEMENTATION）

> 依据 [DESIGN.md](./DESIGN.md)；迁移对照见 [MIGRATION.md](./MIGRATION.md)。
> 顺序：包侧缺口补齐（billing/inference/control-plane）→ app 骨架 → jobs → 唤醒 → 测试。

## 1. 旧实现审计（v1 `apps/worker`）

### 1.1 真 bug / 隐患（B#）

- **B-W1 BullMQ 固定 jobId 吞唤醒**：批次运行期间新唤醒在 Redis 侧被固定
  jobId 去重吞掉，不 drain 则积压吞吐塌到 0.67 张/秒——v1 以 drain()
  补偿。v2 PG NOTIFY 无去重语义，唤醒天然到达；drain 改以认领计数判定，
  语义保留、依赖消失。
- **B-W2 Redis 硬依赖**：`assertRedisReachable` 使 worker 在 Redis 故障时
  拒绝启动，而结算账务本不依赖 Redis。v2 三用途全部消失（见 §1.3 D#）。
- **B-W3 deep health 过薄**：`/health` 只报 `{owner, running}`，无法排障。
  v2 增强 per-job 快照（DESIGN §5）。

### 1.2 契约缺口

- 结算/死信入箱事件名（billing `billing.settled`/`billing.dead` 点分）与
  notifications 封闭词表（`billing_dead` 下划线）不匹配——v2 包侧缺陷，
  桥接处会 `unknown_event` 回滚结算事务。本波修复：`billing.dead` →
  `billing_dead`；`billing.settled` 移出入箱（无告警消费场景，v1 同款不入箱）。
- db schema `generation_tasks` 注释「先 CAS 任务终态再发 signal」与 v1 实现
  （succeeded 先信号后终态——防漏收费不变量）相反。以 v1 实现为准，
  注释随本波校正。
- db schema `billing-requests.ts` 注释通道名 `settle_wake` 与 gateway DESIGN
  定稿 `settle-wake`（连字符）不一致。以 gateway DESIGN 为准，注释校正；
  常量单一真相 = `@tillgate/billing` 根导出 `SETTLE_WAKE_CHANNEL`。

### 1.3 重复/依赖清理（D#）

- **D-W1 BullMQ/Redis 移除**：唤醒 → PG LISTEN/NOTIFY（`.env.example` L19
  方向）；TPM 回填 → gateway（挂账）；ai 熔断存储 → `createMemoryHealthStore`
  （v1 注释明确 worker 任务查询不进熔断主路径；单副本语义）。
- **D-W2 wallet 直连清除**（总纲 L43/L917）：对账走 `billing.settlement.
verifyInvariants` facade；差异写表走 billing `recordReconcileDiscrepancies`
  用例——app 不出现 SQL/`Db` 类型（P5 红线）。

## 2. 逐模块裁决表

| v1 文件                                                          | 裁决                                           | v2 落点                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `index.ts`（八定时器+装配+停机）                                 | 重构                                           | `scheduler.ts` + `assembly.ts` + `shutdown.ts` + `index.ts`                                                             |
| `config.ts`（37 env）                                            | 重构                                           | `config.ts`（zod，删 REDIS_URL/BullMQ；补 WORKER_GENERATION_DEADLINE_MS/WORKER_REFERRAL_BACKFILL_DAYS）                 |
| `run-once.ts`（结算批次）                                        | 重写                                           | `jobs/settlement.ts`（claim→保活→processClaim；业务在 billing facade）                                                  |
| `generation-adapter.ts` + `service/generation/poll.ts`（212 行） | 重构                                           | inference `application/generation-poll.ts` + `adapters/upstream-ai.ts` 扩 `queryTask` + worker `jobs/poll.ts`（驱动壳） |
| `wakeup.ts`（BullMQ 消费端）                                     | 重写                                           | `wakeup/postgres-notify.ts`（LISTEN + coalescing + drain + 重连）                                                       |
| `tasks/reconcile.ts`                                             | 重构                                           | `jobs/reconcile.ts` + billing `record-discrepancies` 用例 + notifications enqueue                                       |
| `tasks/notify-dispatch.ts`                                       | 不移植（已被 notifications dispatchOnce 吸收） | `jobs/notify.ts`（单行驱动）                                                                                            |
| `tasks/partition-maintenance.ts`                                 | 不移植（已被 observability 吸收）              | `jobs/partition.ts`（两个 facade 调用）                                                                                 |
| `tasks/referral-commission.ts`                                   | 重构                                           | billing `application/referral-commission.ts`（聚合 port + credit）+ worker `jobs/referral.ts`                           |
| `health.ts`                                                      | 重构                                           | `health.ts`（v1 对位 + per-job 快照增强）                                                                               |
| `ai-storages.ts`（内存熔断存储）                                 | 不移植                                         | inference `createMemoryHealthStore` 已有                                                                                |
| onSettled 钩子（TPM 回填 + balance_low）                         | 拆分                                           | TPM → gateway 挂账不迁；balance_low → assembly 钩子（worker 内）                                                        |
| `__tests__/`（10 文件）                                          | 选择性迁移                                     | 见 MIGRATION §5 测试矩阵                                                                                                |

## 3. 目标目录

```text
apps/worker/
├── DESIGN.md / IMPLEMENTATION.md / MIGRATION.md
├── package.json / tsconfig.json / vitest.config.ts
├── src/
│   ├── index.ts            # 进程入口（test 守卫不自动启动）
│   ├── config.ts           # zod env（fail-closed；缺省显式持有）
│   ├── assembly.ts         # 唯一装配根（唯一可引 ./composition 的文件）
│   ├── bridge-mappers.ts   # 装配桥接纯映射（billing 信号/渠道行形状;oxlint 规模上限拆出）
│   ├── scheduler.ts        # 循环注册/interval/inFlight/stop
│   ├── jobs/
│   │   ├── settlement.ts   # runSettlementBatch + runRecovery
│   │   ├── poll.ts         # pollGeneration 驱动
│   │   ├── reconcile.ts    # advisoryLock + verifyInvariants + 差异表 + 告警
│   │   ├── notify.ts       # dispatchOnce 驱动
│   │   ├── partition.ts    # traces/requestLogs 分区维护
│   │   └── referral.ts     # 佣金日结驱动
│   ├── wakeup/postgres-notify.ts
│   ├── health.ts           # /livez /readyz /health(token)
│   └── shutdown.ts         # createShutdown 组装（closeables 编排）
└── __test__/               # 平铺；*.real.test.ts 单列
```

## 4. 关键实现口径（防漂移）

1. **jobs 不持 Db 类型**：job 函数签名只出现 facade 动词与纯类型；
   `architecture.test.ts` 断言 `Db/DbTx/drizzle` 只出现在
   `assembly.ts/config.ts/index.ts/shutdown.ts`（装配面）。
2. **生成任务终态顺序不变量**（v1 语义，inference poll 用例内）：
   succeeded = 先 signal 后 CAS 终态（信号失败保留任务行重试——宁可晚交付
   不可漏收费；billing 已 settlement_pending/settled 时跳过信号直接终态化
   = 崩溃窗口自愈）；failed/expired = 先 CAS 后 signal（信号失败仅日志，
   recover 兜底）。
3. **renewLease 锚定**：`graceMs = max(expiresAt − now + 30s, leaseMs)`，
   leaseOwner = requestId（防 settlement recover 误释放存活任务）。
4. **佣金幂等**：refType `'referral'` + refId `referral-commission:{inviterId}:{yyyyMMdd}`
   自然键；`credit().replayed === true` 不计入 credited；rate ≤ 0 直接返回；
   非法 rate 记错误跳过本轮（下轮自愈）。
5. **对账差异表口径**：v2 violation 无数值（`{kind,key,detail}`），expected/
   actual/diff 记 `'0'`，detail 存 JSON 序列化（数值化挂账后续增强）；
   advisory lock 保留 v1 键 `ai-gateway:billing-reconcile`（会话级
   `pg_try_advisory_lock`，专用连接——与分区锁同口径防重叠部署互斥）。
6. **wakeup drain 判定**：`claimed === batchSize` 满批续跑；guard 1000。
7. **哨兵 resolver**：worker 建 `createBillingApi` 时 resolver 传
   `() => { throw DefectError(...) }`——authorize 在 worker 结构性不可达。
8. **per-job 健康快照**：scheduler 维护 `lastStartedAt/lastResult`（结果为
   JSON-safe 摘要，金额与计数，不含 payload）。

## 5. 测试计划（先于实现定稿）

| 文件                      | 覆盖                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `architecture.test.ts`    | src 文件集合快照；Db/DbTx/drizzle 只在装配面；`composition` 子入口只在 assembly；禁深导入                    |
| `config.test.ts`          | 缺省全显式；布尔双形态（'true'/'false'）；非法值 fail-closed；生产强校验；`WORKER_NOTIFY_ENABLED=false` 静音 |
| `scheduler.test.ts`       | tick 错误隔离；stop 拒新批次；inFlight 宽限等待；unref                                                       |
| `wakeup.test.ts`          | coalescing 纯语义（3 次并发 ≤ 2 次执行）；drain 满批续跑/非满批停；重连退避（假定时器）                      |
| `jobs-settlement.test.ts` | 批次闭环计数（in-memory settlement api）；0 认领早退                                                         |
| `jobs-poll.test.ts`       | 驱动壳透传（poll 用例本体单测在 inference 包）                                                               |
| `jobs-reconcile.test.ts`  | 锁未获跳过；violations → 差异行 + 告警入箱（enqueue dedupeKey）                                              |
| `jobs-referral.test.ts`   | rate≤0 短路；桥接注入透传（用例本体单测在 billing 包）                                                       |
| `jobs-partition.test.ts`  | 两个 facade 调用透传 + 结果日志                                                                              |
| `health.test.ts`          | livez/readyz 开放；/health 无 token 403 / 有 token 200                                                       |
| `worker.real.test.ts`     | 真 PG：NOTIFY→LISTEN 唤醒触发批次；settle 批次闭环；recover；佣金同日重跑幂等；对账破坏→差异表+入箱          |

## 6. 实施顺序（每步四门全绿）

1. billing：入箱事件名对齐（含 outbox-atomicity 测试同步）→ `SETTLE_WAKE_CHANNEL`
   → SettlementApi 补 `currentStatus` → 佣金用例+port+adapter → 差异写入用例
   → `MIGRATION-U6.md` + README §2.2 增补。
2. inference：`GenerationTaskStore` 扩轮询四动词（port+pg adapter+memory
   adapter）→ `UpstreamPort.queryTask`（upstream-ai 适配）→ poll 用例 →
   单测 → MIGRATION §5 挂账核销。
3. control-plane：`ChannelStore.findTaskChannel`（by-id 连接信息，v1 同名）。
4. app：config/assembly/scheduler/health/shutdown/index + architecture 测试。
5. wakeup/postgres-notify + 六个 job + balance_low 钩子 + 全部单测。
6. `worker.real.test.ts` + `.env.example` 补 WORKER_* 段 + accounts MIGRATION
   挂账核销 + 全仓四门。

---

## 增量：SSRF 装配收口（2026-08-25 审计复核）

config 新增 `WORKER_UPSTREAM_ALLOWED_HOSTS`（逗号分隔；生产必填），
assembly 生产形态给 `createAi` 注入 `guardUrl = assertSafeUrl(url,
{ allowedHosts })`（与 gateway 同款——生成任务轮询的上游寻址此前同样
只跑机械基线）。webhook 投递 guard 维持无白名单：目标 URL 由通知渠道
配置任意指定，防线 = 机械基线 + 不跟随重定向（notifications §7）。

## 增量：出口信任回归运营面（2026-08-25 ADR-0010）

撤销上一节的 env 白名单形态：删除 `WORKER_UPSTREAM_ALLOWED_HOSTS`
（schema / superRefine 生产必填门禁 / `WorkerConfig.upstreamAllowedHosts` /
装配注入），`guardUrl` 回归 `assertSafeUrl(url)` 机械基线。裁决依据与
残余风险见 ADR-0010；webhook 投递防线（机械基线 + 不跟随重定向）不变。

## 增量：BullMQ 结算调度（2026-08-26 定稿，方案状态：已核销）

> 级别：中。动机 = live-fire 红队压测 F-1（`e2e/live-fire/FINDINGS.md`）：
> 单条毒账单（usage_logs 持久性插入失败等）经 `settleFailurePolicy` 算出
> NaN 退避 → `casToRetryOrDead` 的 interval 乘法 SQL 报错 → 逃逸批处理
> `Promise.all` → **worker 进程退出**（毒账单反复重领反复打崩 = 结算拒绝服务）。
> 用户裁决：采用 BullMQ 重构结算调度（进程级隔离 + 框架退避），PG 状态机保留为真相。

### 契约

- **billing 面（改动两处）**：① `settleFailurePolicy` 入参加 `Number.isFinite`
  防护——attempt/退避输入非有限数值时直接判死信（`failureClass` 带
  `_invalid_attempt` 后缀），NaN 不再流向 SQL。② settlement 面新增只读
  `listDueRequestIds({limit})`：扫 due 行（`settlement_pending/retry_wait` 且
  到期）只取 id 不认领——sweep 入队与直驱 runner 共用，候选口径与
  `claimPending` 一致（SQL 住 postgres adapter）。其余 API 零改动
  （`claim.requestIds` 定向认领为既有形态）。
- **worker 面（新）**：
  - `processSettlementRequest(requestId): Promise<'settled'|'retried'|'dead'|'claim_lost'|'unknown-failure'>`
    ——纯闭包：定向 claim（空认领=幂等完成）→ processClaim → 结局映射。
    未知异常**不外抛**（记日志返回 `unknown-failure`，由入队方决定重投）。
  - `runSettlementSweep(): Promise<number>` ——扫描 due 行（复用 claim 的
    候选查询口径但不认领，只取 request_id）→ 批量入队，返回入队数。
  - BullMQ Queue/Worker 装配：`WORKER_REDIS_URL`（回落 `REDIS_URL`）、
    `WORKER_BULLMQ_PREFIX`（缺省 `{bull}`）、`WORKER_SETTLE_CONCURRENCY`（8）、
    `WORKER_SETTLE_MAX_ATTEMPTS`（10）；ioredis 专用实例
    （`maxRetriesPerRequest: null`——BullMQ 硬性要求）。
- **错误形态**：processor 内已知结局正常返回；`retried` → job 抛错交 BullMQ
  指数退避（`backoff: { type: 'exponential', delay: baseDelayMs }`）重投；
  BullMQ failed 事件 = 缺陷信号（error 日志）。
- **事件时序**：死信判定 → PG dead + billing_dead 同事务入箱（不变，billing 内）；
  job 完成最后；一次性事件恰好一次由 PG 幂等层保证（与队列无关）。

### 问题域

- 处理：结算触发的三源入队（wake/sweep/BullMQ 重投）、单条结算驱动、
  毒账单进程隔离、瞬时失败退避时序。
- 不处理：结算业务规则与死信判定（→ `@tillgate/billing`，零变化）；
  recover 业务（→ billing，回收行由 sweep 兜底入队）；其余六 job（不动）；
  网关热路径（零改动）。

### 并发/一致性预算

- 单条结算 < 1s、租约 60s：单 job 内不需保活（批式 renewTimer 随批形态移除）。
- Worker concurrency 8 × 多副本：正确性全在 PG（claim SKIP LOCKED + revision
  CAS + lease + usage_logs unique + wallet 幂等）——队列重复投递/多源并发
  入队天然安全（空认领幂等完成）。
- Redis 丢任务/丢通知：sweep 周期（30s 缺省）扫 due 行重投，账务不依赖 Redis。
- 定时器个数：不变（settle interval 语义改为 sweep；无新增常驻定时器）。

### 拆分（目标位置）

| 文件 | 动作 |
| --- | --- |
| `packages/billing/src/domain/billing/settle-failure.ts` | NaN 防护（真 bug 根因修复） |
| `packages/billing/src/application/settlement/`（+ postgres adapter） | 只读 `listDueRequestIds`（due 行 id 扫描，不认领；sweep/直驱共用） |
| `apps/worker/src/queue/settlement-queue.ts` | 新增：BullMQ Queue/Worker/ioredis 装配工厂 |
| `apps/worker/src/jobs/settlement.ts` | 重写：`createSettlementProcessor`（单条驱动）+ `createSettlementSweepJob`（due 扫描入队）；`createSettlementBatchJob` 删除（铁律 8 单轨） |
| `apps/worker/src/wakeup/postgres-notify.ts` | 通知回调改定向入队；coalescing/drain 移除 |
| `apps/worker/src/config.ts` | settle 段 + bullmq 四旋钮 |
| `apps/worker/src/assembly.ts` | queue/processor/sweep 装配 + runners.settle 新语义 |
| `apps/worker/src/shutdown.ts` / `index.ts` | 停机顺序 + queue/worker close |

### 裁决（用户裁决/默认裁决）

1. **【用户裁决】** 用 BullMQ 重构（对比最小修复 ~10 行）——用户明确指定。
2. PG `settlement_attempts` = 业务死信判定唯一真相；BullMQ attempts = 保险丝。
3. `retried` 结局由 BullMQ 退避重投承担首试时序；PG `next_settlement_at`
   保留（sweep 兜底 + 可观测），两消费者语义一致（最早重试时刻），非双轨。
4. `runners.settle` = sweep + 直驱 processor（E2E 确定性；生产函数不经
   BullMQ runtime 的同一管线）。
5. recover 不返回回收 ids（既有契约零改动）——回收行由 sweep 周期兜底入队
   （recover 本身是兜底路径，多等一个 sweep 周期可接受）。

### 测试口径

- 单元（billing）：`settle-failure` NaN/Infinity/负数 attempt 矩阵 → 全部落
  死信（表驱动）；正常 attempt 退避公式不变。
- 单元（worker）：processor 结局映射（settled/retried/dead/claim_lost/未知
  异常不外抛）；sweep 只入队 due 行；wakeup payload 解析（UUID/垃圾/缺失）。
- real（worker，真 PG+Redis）：enqueue → BullMQ worker 消费 → settled；
  **毒账单回归**（F-1 症状：结算管线的 usage 插入持续失败）→ worker 进程
  存活 + 账单最终 dead + billing_dead 入箱。
- e2e：billing-recovery 旅程适配（runners.settle 新语义）全绿。
- live-fire：80 用例全量回归 + 新增 P1 毒账单用例。

### 验收清单（2026-08-26 核销）

- [x] F-1 复现场景（毒账单）worker 不崩、账单进 dead、billing_dead 入箱
      ——live-fire P1 用例（635ms 闭环：用户删行→usage FK 持续失败→重试耗尽→
      dead + 入箱，进程存活）
- [x] 结算恰好一次语义不变——billing settlement-lifecycle real 4/4；
      billing-recovery e2e 3/3（⑯a/⑯b/⑯c 真 scheduler→sweep→BullMQ 消费链）；
      live-fire 81/81（X6 worker SIGKILL 恰好一次、X10 三不变量全库核验）
- [x] 四门全绿——根 typecheck/lint/test/build（34/34/34/20 任务）；
      worker 覆盖率 97.14/90.74/97.14/99.13（阈值 90/85 不降）；
      billing 338 用例全绿（含 NaN 防护矩阵回归）
- [x] DESIGN/IMPLEMENTATION 同步（本节即修订记录；DESIGN §1/§2.2/§2.4/§3.2/§3.3/§4/§6 同步演进）
