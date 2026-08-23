# U6：管理读侧面四接缝（plans 目录管理 / 订阅管理列表 / 兑换批次管理 / 死信单笔复审）迁移文档

> 状态：已核销（2026-08-23；代码/测试/门禁全绿——plans、redemption-batches、settlement-review
> 三套件随全仓 turbo test 通过；admin-api P1 契约面已装配。核销注记：工作区在途波，
> git 提交动作随 admin-api P1 波收口时一并完成）
> 迁移单元：管理员维护套餐目录、查看订阅管理列表、管理兑换码批次、对死信结算单做单笔复审（retry/abandon）
> 旧实现：`ai-getway/apps/admin-api/src/services/{plans,subscriptions(list 部分),redeem,billing-review}.service.ts` + 对应 routes
> 目标位置：`packages/billing`（用例 + store 口 + pg/内存适配 + facade 组）
> 关联：DESIGN.md §2.2、IMPLEMENTATION.md §7、apps/admin-api/{DESIGN,IMPLEMENTATION,MIGRATION}.md

## 1. 行为规格基线（v1 测试）

- `plans.test.ts`：kind×周期一致性（包月 1..3650/加油包恒 0）、kind 不可变（strict 拒未知键）、
  删除守卫（含历史订阅引用 → 409 plan_in_use）、审计行。
- `subscriptions.test.ts`（list 部分）：user/plan join 富化 + 剩余额度投影 + planId/userId/status 过滤。
- `redeem.test.ts`：明文码仅创建时一次返回（库内只落 SHA-256 唯一索引）、批次列表/详情、
  批内码列表（codeMasked 脱敏）、单码作废 CAS 0→2（已用/已废/不存在统一 404 不泄漏状态差异）。
- `e2e-money.test.ts`（billing-review 部分）：retry CAS dead→retry_wait 清失败态、
  abandon CAS dead→released + 三路归还（钱包授权/订阅配额/渠道敞口），expectedRevision
  乐观锁不符 → 409；复核幂等（operations 同键同参重放）+ 审计与业务同事务。

## 2. 语义裁决

- 明文码生成器与哈希经依赖注入（app 装配传 `@tokenlens/http` generateRedeemCode 与本包 sha256Hex）；
  本包不 import http（分层防环）。
- plans/redeem 审计归 **app 装配层后置写入**（v1 recordAudit 同为提交后旁路）；死信复核审计为
  **同事务注入 port**（资金关键——与 v1 billing-review.auditInTx 同口径），缺省丢弃（测试缝）。
- 死信 abandon 的三路归还复用 U3 `createReleaseAllReservations`（与 recover①② 同一实现）。
- 订阅管理列表 join users/plans 在 SQL 物理层完成（不引 accounts 依赖）。

## 3. API 对照（v1 → v2）

| v1                                                                                                         | v2                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `plans.service` list/create/patch/remove                                                                   | `Billing.plans.{list,create,update,remove}`（facade 组）                                                                                      |
| `subscriptions.service.list`                                                                               | `SubscriptionsApi.adminList`                                                                                                                  |
| `redeem.service` createBatch/list/detail/listCodes/revokeCode                                              | `createRedeemBatchApi({codes,generateCode})`（root 出口；store 取自 composition）                                                             |
| `billing-review.service` list/retry/abandon                                                                | `SettlementApi.review.{listDead,retryDead,abandonDead}`                                                                                       |
| 裸码 `invalid_period_days/plan_in_use/redeem_batch_not_found/redeem_code_not_found/billing_state_conflict` | 目录码 `billing.{invalid_period_days,plan_in_use,redeem_batch_not_found,redeem_code_not_found,state_conflict}`（state_conflict 已存在，复用） |

## 4. 测试迁移矩阵

| v1 测试                          | 去处                                                                  |
| -------------------------------- | --------------------------------------------------------------------- |
| plans.test.ts                    | `__test__/plans.test.ts`（内存 stand-in）                             |
| redeem.test.ts                   | `__test__/redemption-batches.test.ts`                                 |
| e2e-money.test.ts（review 部分） | `__test__/settlement-review.test.ts`（内存 stand-in + registry 替身） |
| subscriptions.test.ts（list）    | `__test__/subscriptions.test.ts` 增补                                 |

## 5. 回滚方案

加法变更（端口方法/用例/facade 组均为新增，无既有动词改动）；revert 单提交即回滚。

## 6. 验收

四门全绿 + 上述行为规格用例全绿 + admin-api 契约测试（apps 侧矩阵见其 MIGRATION §1）。
