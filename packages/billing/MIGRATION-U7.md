# U7 worker 消费面（事件名对齐 / 佣金日结 / 对账差异落表 / 唤醒通道常量 / currentStatus）迁移文档

> 状态：已核销（worker 波 apps/worker；验收数字见 §7）
> 迁移单元：结算入箱事件名对齐 notifications 词表、邀请佣金日结用例、对账差异
> 落表用例、`SETTLE_WAKE_CHANNEL` 通道契约常量、`SettlementApi.currentStatus`。
> 旧实现：`ai-getway/apps/worker/src/tasks/{referral-commission,reconcile}.ts` +
> `repository/src/{referral,marketing}.repo.ts` + `wallet/src/maintenance.ts`
> 目标位置：`application/{referral-commission,settlement/record-discrepancies}` +
> `ports/{commission-stats,reconcile-store}` + `adapters/postgres/{commission-stats,reconcile-discrepancy-store}` +
> `domain/billing/settle-wake.ts`
> 关联：apps/worker/{DESIGN,IMPLEMENTATION,MIGRATION}.md、ADR-0003

## 1. 行为规格基线（v1 测试）

- v1 `worker/__tests__/referral.test.ts`：昨日消费×比例入账 + 同日重跑幂等；
  窗口边界（今日不计）；排除口径；rate=0 零查询零入账。
- v1 `worker/__tests__/reconcile.test.ts`：净账本零违规零告警；破坏 in_flight →
  违规捕获 + 告警入箱；advisory lock 独占。
- v1 结算入箱（service settlement 域）：死信事实同事务入箱；settled 事实 v1 不存在
  （v2 自行发明的点分名未对齐词表——见 §2 缺陷修复）。

## 2. 逐模块裁决表

| 旧模块                                                 | 裁决 | 动作                                                                                                                                                                          |
| ------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| referral-commission.ts（编排+聚合+入账）               | 重构 | `application/referral-commission.ts`（窗口/幂等/防御语义原样；rate 与 refIdOf 改装配注入——词表单一真相在 accounts domain）                                                    |
| referral.repo sumInviteeSpendByInviter / inviterActive | 重构 | `ports/commission-stats.ts` + pg 适配（inviterActive 并入聚合 join——重跑自动补齐语义等价）                                                                                    |
| reconcile.ts（锁+核验+入箱）                           | 拆分 | 核验已在 U1（verifyInvariants）；本单元补差异落表 `record-discrepancies`（v2 增强：db schema reconcile_discrepancies 表的预设写入方）；锁与告警入箱归 worker app              |
| 死信入箱事件名 `'billing.dead'`                        | 修复 | → `'billing_dead'`（notifications NOTIFY_EVENTS 成员；点分名在消费方 enqueue 词表门抛 unknown_event 回滚死信处置——桥接前不可见，本波接入时暴露即修）                          |
| 结算成功入箱 `'billing.settled'`                       | 删除 | 无告警消费场景（v1 不入箱）；outbox port 保留（死信路径消费）                                                                                                                 |
| ——（新增）                                             | 新增 | `SETTLE_WAKE_CHANNEL='settle-wake'`（gateway 生产端 DESIGN C-G8 同值；db schema 注释同步连字符）；`SettlementApi.currentStatus`（生成任务轮询 succeeded 自愈路径，worker 桥） |

## 3. 关键口径（防漂移）

- 佣金金额 = Decimal(合计)×rate 全精度（账本永不 round）；幂等 = wallet 自然键
  `referral:{referral-commission:{inviter}:{yyyyMMdd(UTC)}}`（accounts commissionRefId）。
- 差异表数值口径挂账：v2 核验是布尔不变量（violation 无 expected/actual 数值），
  三列记 '0'、真相在 detail JSON；数值化是后续增强。
- `SETTLE_WAKE_CHANNEL` 生产端 = gateway `pg_notify`；消费端 = worker LISTEN
  （通道名含连字符——LISTEN 语句需标识符双引号，见 worker.real 门回归锁）。

## 4. API 对照

| v1                                        | v2                                                                                              |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `runReferralCommissionOnce(deps)`         | `createReferralCommissionUseCase(deps)`（stats/wallet/rate/refIdOf/backfillDays/clock/onError） |
| `repos.referral.sumInviteeSpendByInviter` | `CommissionStatsStore.sumInviteeSpendByInviter`                                                 |
| reconcile 直插 notifyOutbox               | worker `notifications.enqueue('reconcile_discrepancy')`（小时级 dedupeKey）                     |
| ——                                        | `createRecordDiscrepanciesUseCase`、`SETTLE_WAKE_CHANNEL`、`SettlementApi.currentStatus`        |

## 5. 测试迁移矩阵

| v1                       | v2                                                                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| worker referral.test.ts  | billing `__test__/referral-commission.test.ts`（8 用例）+ worker real 门幂等锚（余额翻倍断言）  |
| worker reconcile.test.ts | 差异落表 `__test__/record-discrepancies.test.ts` + worker `jobs-reconcile` 单测 + real 门锁互斥 |
| ——（入箱事件名）         | `outbox-atomicity.test.ts` 三处改写（词表成员断言 + 结算不入箱回归锁）                          |

## 6. 回滚方案

全加法面（新文件 + 导出）；事件名对齐是行为修正（修正前桥接结构性不可用），
revert 本单元即回到「worker 未接入」状态。无数据回滚需求。

## 7. 验收

- 默认门禁 267 用例（原 257 + 佣金 8 + 差异落表 2）；real 门 settlement-lifecycle
  4 用例通过（结算/死信链路与事件名对齐兼容）；typecheck/lint/build 全绿。
- 消费方 apps/worker 装配（composition 导出两 pg 工厂）。
