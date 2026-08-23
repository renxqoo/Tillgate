# apps/worker — 迁移记录（MIGRATION）

> 状态：**已核销**（2026-08-23；默认门禁 48 用例 + real 门 5 用例（通道/锁 2 +
> 端到端 3），覆盖率 lines/statements/functions/branches = 99/97.26/96.49/91；
> 验收勾选见 §7）
> 基线：v1 `ai-getway/apps/worker`（@ai-gateway/*，八循环 + BullMQ + Redis）。
> 行为规格基线与审计结论见 [IMPLEMENTATION.md](./IMPLEMENTATION.md) §1；
> 本文只记对照、矩阵与核销。

## 1. 行为规格基线

v1 worker = 「结算 worker app：认领/结算/回收循环——业务全部来自 service 的
settlement 域，本 app 只是定时驱动壳」+ BullMQ settle-wake 事件驱动 +
八定时器兜底 + 健康端点 + 优雅停机。完整行为规格（定时器表/停机顺序/
coalescing 算法/poll 状态机）见 IMPLEMENTATION §1–§2 与 DESIGN §2–§4。

## 2. 审计结论（引用不抄写）

IMPLEMENTATION §1：B-W1（jobId 吞唤醒）/ B-W2（Redis 硬依赖）/ B-W3（deep
health 薄）；跨包契约缺口三处（入箱事件名、generation_tasks 注释顺序、通道名
连字符）；D-W1（BullMQ/Redis 移除）/ D-W2（wallet 直连清除）。

## 3. 逐模块裁决表

见 IMPLEMENTATION §2（v1 12 个源文件 → v2 落点；4 项「不移植」均有吸收方）。

## 4. API 对照（v1 入口 → v2 入口）

| v1                                                                 | v2                                                                                  |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| `startWorker(rawConfig, db?)`                                      | `assembleWorker(config)` + `startWorker(handles)`（装配与启动分离，测试可只装不启） |
| `resolveWorkerConfig(input)`                                       | `loadWorkerConfig(env)`（单一入口，无内联归一化双入口）                             |
| `handles.stop()` / `hasWakeConsumer()`                             | `scheduler.stop()` + `createShutdown` 编排（`shutdown.ts`）                         |
| `createCoalescedRunner(run)`                                       | `createCoalescedRunner(run)`（纯闭包逐语义平移）                                    |
| `createSettleWakeupConsumer(redisUrl, …)`                          | `createSettleWakeListener(db, …)`（LISTEN 专用连接；无 BullMQ）                     |
| `startHealthServer(port, state, token)`                            | `startHealthServer(port, state, token)`（对位 + jobs 快照）                         |
| `runOnce(ctx)`（结算批次）                                         | `runSettlementBatch(deps)`（`jobs/settlement.ts`）                                  |
| `pollGeneration(ctx)`                                              | inference `createGenerationPollUseCase`（worker 桥 signal/channels）                |
| `runReconcileOnce(db, logger)`                                     | `jobs/reconcile.ts`（billing facade + 差异用例 + enqueue）                          |
| `runNotifyDispatchOnce(db, …)`                                     | notifications `dispatchOnce`（app 内一行驱动）                                      |
| `runTracePartitionMaintenance / runRequestLogPartitionMaintenance` | observability `partitions.traces()/requestLogs()`                                   |
| `runReferralCommissionOnce(deps)`                                  | billing `createReferralCommissionUseCase`（worker 桥 rate/refId）                   |
| `liveWorkerInstances` 登记                                         | 不移植（v1 进程自省用；v2 无消费方——无孤儿 surface）                                |

## 5. 测试迁移矩阵

| v1 `__tests__/`                             | v2 落点                                                                                                   |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `config.test.ts` + `config-resolve.test.ts` | `__test__/config.test.ts`（双入口合一后单文件）                                                           |
| `worker.test.ts`（run-once 闭环）           | billing `settlement.test.ts` 已吸收用例本体；app 侧 `jobs-settlement.test.ts` + `worker.real.test.ts`     |
| `wakeup.test.ts`（合并语义）                | `__test__/wakeup.test.ts`（coalescing 平移；真 BullMQ 全链 → real 测试的 PG NOTIFY 全链）                 |
| `wiring.test.ts`（三定时器+停机）           | `__test__/scheduler.test.ts` + `worker.real.test.ts`                                                      |
| `reconcile.test.ts`                         | `__test__/jobs-reconcile.test.ts` + real（差异表+入箱）                                                   |
| `referral.test.ts`                          | billing 包佣金用例单测 + `__test__/jobs-referral.test.ts` + real 幂等                                     |
| `notify-concurrency.test.ts`                | 已吸收于 notifications 包（concurrency.test.ts）                                                          |
| `notify-ssrf.test.ts`                       | 已吸收于 notifications 包                                                                                 |
| `parity-loops.test.ts`                      | 拆解：HMAC/无订阅 → notifications；健康端点 → `health.test.ts`；balance_low/billing_dead 钩子 → real 测试 |
| `poll 相关（v1 service/generation 测试）`   | inference 包 poll 用例单测                                                                                |

## 6. 回滚方案

- 新增 app 与包增量用例均为加法（无删除面）；billing 入箱事件名对齐是
  行为修正（修正前桥接本就不可用），回滚 = revert 对应 commit 即可恢复
  「未接入」状态。worker 未部署前无数据回滚需求。

## 7. 验收

- [x] 四门（typecheck/lint/test/build）+ 包边界门禁全绿（worker 与受改包
      billing/inference/control-plane/accounts/db）。
- [x] real-PG（5 用例，`DB_TEST_URL`/`DATABASE_URL` 不可达整组 skip）：
      通道/锁语义 2 用例（pg_notify → LISTEN → 批次触发 + 他通道不触发；会话级
      advisory try-lock 互斥）；**端到端 3 用例**（`worker.e2e.real.test.ts`，
      scratch schema 完整迁移链 + 生产拓扑）——① gateway authorize/signal +
      pg_notify 门铃 → worker LISTEN 唤醒 → 认领结算（settled + 余额实扣
      10→8 + usage_logs 投影 + balance_low 告警按用户×日幂等入箱）；② 佣金
      日结（昨日已结算消费 × marketing_settings 费率入账；同日重跑幂等零重复）；
      ③ 对账（禁用一致性触发器模拟事后漂移 → verifyInvariants 捕获 →
      reconcile_discrepancies 落表 + 告警入箱）。结算/恢复的更多 PG 语义由
      billing 包 real 门覆盖（settlement-lifecycle 4 用例——本波事件名对齐兼容）。
- [x] inference MIGRATION §5「生成任务轮询」挂账核销；accounts MIGRATION
      「佣金日结」挂账核销；billing MIGRATION-U7 登记。
- [x] `.env.example` 补 WORKER_* 段；覆盖率如实申报：
      lines 99 / statements 97.26 / functions 96.49 / branches 91
      （阈值 90/90/90/85；`src/index.ts` 进程入口与 `src/assembly.ts` 装配面
      移出默认分母——装配闭包由 real 门覆盖，口径见 vitest.config.ts）。
- [x] 真 PG 门发现并修复一处实现缺陷：LISTEN 语句通道名未按标识符转义
      （'settle-wake' 含连字符 → 裸 LISTEN 是 42601 语法错，重连循环空转）——
      修复后以语句形状断言（单测）+ 端到端（real 门）双回归锁。
