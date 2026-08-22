# U3 结算与恢复迁移文档

> 状态：已核销（默认门禁 199 用例 + 真 PG 17 用例；验收数字见 §7）
> 迁移单元：结算认领/落定/失败处置/滞留恢复 + usage 投影 + 对账核验（worker 侧资金安全网）
> 旧实现：`service/src/settlement/`（6 文件）+ `repository/src/{billing-request(结算方法族),usage-log}.repo.ts` + `wallet/src/maintenance.ts`（verifyInvariants——D9 唯一存活者）+ `service/src/channel-budget/{release-exposure,deduct-budget}.ts`
> 目标位置：`application/settlement/*` + `ports/billing-store`（扩展）+ `adapters/postgres` + `wallet-store.verifyInvariants`
> 关联：DESIGN §4、IMPLEMENTATION §1.2 / §2 U3、ADR-0003 决策 2

## 1. 行为规格基线

旧测试：service settlement/settlement-failure（真实 PG）——主干移植；引擎不变量清单在
真实 PG 对账断言重现（assertLedgerCoherent + verifyInvariants 三类漂移）。

## 2. 审计结论引用

- B8：对账核验保持只读；差异告警入箱归 worker 消费方（本单元只交付 verifyInvariants）。
- B14（迁移中新发现，已修）：旧装配形态下 signal(failed) 的渠道敞口归还依赖可选注入，
  新装配初版漏接 channels——契约测试当场抓获（`signal` 未带 channels 时失败释放不还
  渠道敞口）；已修复并在真实 PG 验证。
- 五元组 CAS / SKIP LOCKED / 租约保活 / 毒行逐单隔离语义逐条平移（IMPLEMENTATION §3.6）。

## 3. 逐模块裁决表

| 旧模块                                                                                                                                                                                                     | 裁决                | 动作                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| settlement/{claim,failure,process,settle,recover,usage-projection}                                                                                                                                         | 重写                | application/settlement/*（RunContext 移除；渠道收尾经 ChannelExposureStore）                       |
| channel-budget/{release-exposure,deduct-budget}                                                                                                                                                            | 重构并入            | settle/reserve/signal 内联消费（tryDecreaseReserved / deductBudgetAndMaybeBreak）                  |
| billing-request.repo 结算方法族（claimPending/renewClaims/casFinalizeSettled/casToRetryOrDead/findProcessingForClaim/listExpiredForRecovery/recoverOneToReleased/requeueExpiredClaims/abandonOwnedClaims） | 重写                | ports/billing-store 扩展 + postgres adapter（SQL 语义原样：CTE+SKIP LOCKED、clock_timestamp 租约） |
| usage-log.repo（insertUsageLog/findAmount）                                                                                                                                                                | 重写                | billing-store（requestId 唯一约束幂等）                                                            |
| wallet/src/maintenance.ts verifyInvariants                                                                                                                                                                 | 重构迁入（D9 例外） | wallet-store.verifyInvariants + reconcile 用例（只读哨兵；告警入箱归 worker）                      |

## 4. 契约演进

1. 死信家族按三性/目录码判定（U2a 已定）；结算不变量红灯以 `DefectError`
   （`billing.billing_invariant` / `billing.channel_exposure_invariant`）表达。
2. `usage-projection` 的 billedBy/subscriptionId 口径原样保留（防
   billedBy='plan'&&subscriptionId=null 矛盾行漏算日限——旧仓 2026-08-19 终审修复语义）。
3. 真实 PG 全链测试应用**完整迁移链**（0000→0075）+ 容错跨链缺表（42P01——P0 审计
   「四条迁移链叠加」的已知缺口，identity-core provision 等建的表不在 db 链）；
   空库升级收口是 P3 待办，本测试记录该事实而不掩盖。

## 5. 测试迁移矩阵

| 旧测试                                         | 新去处                                                                     | 动作                                                             |
| ---------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| service settlement.test.ts 主干                | `settlement.test.ts`（内存）+ `settlement-lifecycle.real.test.ts`（真 PG） | 改写：全链/部分结算/零额/毒收据死信/退避重试/恢复三路径/优雅停机 |
| settlement-failure.test.ts                     | settlement.test.ts（瞬态直驱）+ billing-rules（策略）                      | 改写                                                             |
| 引擎不变量（Σ腿/链/在途投影/append-only/冻结） | wallet-*.real + lifecycle verifyInvariants                                 | 已在 U1 重现；lifecycle 再验                                     |
| （新增）                                       | lifecycle：并发双 worker 认领恰好一方、渠道熔断真实触发                    | 新增                                                             |

## 6. 回滚方案

单提交可 revert；零 DDL。

## 7. 验收（已核销 2026-08-23）

- 默认门禁 199 用例，覆盖率 92.81/85.2/96.44/94.86；四门全绿。
- 真 PG 17 用例（wallet 13 + lifecycle 4）：全链落定（钱包/账单/usage 投影/渠道敞口与
  预算/对账零漂移）、SKIP LOCKED 并发认领恰好一方、毒收据死信（预扣保留）、
  过期授权真实 CAS 归还。
- B14 回归：signal.failed 渠道敞口归还（内存 + 真 PG 双验）。
