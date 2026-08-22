# U4 订阅生命周期迁移文档

> 状态：已核销（默认门禁 214 用例；验收数字见 §7）
> 迁移单元：订阅购买/续费/变更/取消/加油包 + 幂等操作档案（ledger_operations）
> 旧实现：`domain/src/subscription/{rules,errors}.ts` + `service/src/subscription/index.ts` + `service/src/shared/operations.ts` + `repository/src/{plan,subscription(生命周期方法),operations}.repo.ts` + `repository/src/{user,org,credential}.repo.ts`（跨域方法子集）
> 目标位置：`domain/subscription/rules.ts` + `application/{operations,subscriptions}` + ports 扩展 + `ports/account-context.ts` + adapters
> 关联：IMPLEMENTATION §1.4 D7/D8 / §2 U4、ADR-0003

## 1. 行为规格基线

旧测试：domain/subscription rules.test（11 例）+ service operations.test + service 订阅主干
—— 全部以新测试锁定（文件映射见 §5）。

## 2. 审计结论引用

- D7（operationId 契约两套）：词表归 billing domain（`assertOperationId`，
  invalid_ref/invalid_operation_id）。
- D8（幂等 run 引擎两套）：迁活路径 service 版语义；吸收 ledger-core 的 16KB 回执上限
  （超限 = DefectError——回执是重放凭据不是数据仓库）；严格指纹（undefined/NaN 拒绝）。
- 「单有效订阅」部分唯一索引并发兜底（cause 链找 user_subscriptions_one_active_uq/
  one_org_uq → already_subscribed）原样保留。

## 3. 逐模块裁决表

| 旧模块 | 裁决 | 动作 |
| --- | --- | --- |
| domain/subscription/rules | 复制+微修 | domain/subscription/rules（SubscriptionDomainError 13 码 → 目录 7 键 + context.reason） |
| service/shared/operations.ts | 重写 | application/operations.ts（D8 收敛；16KB 上限吸收） |
| service/subscription/index.ts（5 动词） | 重写 | application/subscriptions/subscriptions.ts（RunContext 移除；资金经 wallet.transfer TxChannel 同事务） |
| repository/{plan.findPlan, subscription 生命周期方法, operations.repo} | 重写 | ports/billing-store 扩展 + postgres adapter（行锁/CAS/惰性翻转语义原样） |
| repository/{user.userExists/isEnterprise, org.insertOrgWithOwner, credential.rebindCredentials} | port 化（跨能力事实） | ports/account-context.ts——app assembly 桥接 accounts 或 adapter 直读（总纲 §5.2；adapter 直读实现已备） |

## 4. 契约演进

1. 订阅域 13 个错误码收敛为目录 7 键（plan_not_found/plan_disabled/plan_not_purchasable/
   not_a_pack/user_not_found/subscription_state/subscription_rule），细分 reason 入 context
   ——消费方按 category 分派，reason 保留旧码词汇（MIGRATION 记录映射）。
2. operations 指纹改严格 canonical（B4 家族：undefined 不再静默丢弃——旧宽松版语义）。

## 5. 测试迁移矩阵

| 旧测试 | 新去处 | 动作 |
| --- | --- | --- |
| domain/subscription rules.test | subscriptions.test（规则经动词间接）+ 目录码断言 | 改写 |
| service operations.test | subscriptions.test（operations 组） | 改写（+超限红灯） |
| service 订阅主干（purchase/renew/change/cancel/grantPack） | subscriptions.test | 改写（含免费升级、管理面续费、企业席位、惰性翻转、单有效订阅、零价印刷机防线） |

真实 PG（唯一索引竞态/行锁/凭证改绑 SQL）随 U5 收口套件统一（plans/user_subscriptions/
organizations/api_keys/apps 种子一次性搭起）。

## 6. 回滚方案

单提交可 revert；零 DDL。

## 7. 验收（已核销 2026-08-23）

- 默认门禁 214 用例，覆盖率 93.08/85.08/97.62/95.11；四门全绿。
- 行为对照：购买（现金禁透支/快照 × 席位/团队组织同事务）、续费（顺延+改绑+旧单到期）、
  变更（线性折旧补差/免费升级/降档与无变化拒绝）、取消（无退款）、加油包（印刷机防线）、
  operations 档案（重放/冲突/kind 隔离/词表/超限）。
