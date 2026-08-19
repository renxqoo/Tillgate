# migration —— 开账迁移（旧资金模型 → wallet）

> 源码：`src/migration/opening.ts` + CLI `scripts/migrate-opening.ts`
> 根出口：`runOpeningMigration / listUsersWithLegacyBalance / activeBillingCount / OpeningMigrationReport`
> 配套 DB 迁移：`packages/db/migrations/0058_wallet_single_money_truth.sql`

## 1. 职责

把旧资金模型（users.balance / reserved_balance / credit_limit 三列）的用户侧事实
**一次性、幂等、可验证**地搬进 wallet，作为新旧模型的切换点。已在 dev 库执行：
3312 用户余额 + 4 个授信地板迁移，**全量相等性门禁通过**。

## 2. 迁移算法（runOpeningMigration）

每用户三步，全部幂等（重跑安全）：

```
① 授信地板：credit_limit ≠ 0 → wallet.setCreditLimit（先于余额——负余额
   transfer 的可用额守卫含信用地板，授信未落任何非零负余额都会被拒）
② 期初余额：balance ≠ 0 → operations.run('migration.opening',
     operationId = `migration:opening:{userId}`)   ← 唯一幂等键
     正余额：wallet.credit（counter-leg = outside 镜像，复式两端齐全）
     负余额：wallet.transfer(user → outside, allowCredit)——可用额守卫保住地板
③ 在途重建：活跃 billing_requests（authorized/in_flight）的 PAYG 部分
   （reserved_amount − plan_reserved_amount）→ wallet.authorize（refType 'billing'，
   refId = requestId）——冻结单不设 expiresAt，生命周期归 billing 自己管
```

订阅额度在途（plan_reserved_amount）与渠道敞口**不迁**——它们本来就在业务表里，
新代码继续在同一行上读写（quota 原语 / channel-budget 守卫），无模型切换。

## 3. 全量相等性门禁

迁移后逐用户比对 `wallet 余额 == users.balance`（原生 SQL 聚合 wallet_accounts 对
迁移前快照），**不全等即报告失败列表、CLI 非零退出**——不满足门禁不得执行 0058 DROP。
dev 库首跑曾抓到 e2e 测试残留的双入账（wallet 已有 100000 又迁 100000），
清空 wallet 表重跑后全等——门禁的价值就在这。

## 4. CLI 用法

```bash
# 停机窗口执行（先跑 dry-run 看规模）
npx tsx packages/ledger/scripts/migrate-opening.ts --dry-run
npx tsx packages/ledger/scripts/migrate-opening.ts
# 输出：users=N credits=N creditLines=N authorizations=N + 门禁结果；
# 门禁失败打印前 20 条差异并 exit 1
```

配套函数：
- `listUsersWithLegacyBalance(db)`——列已退役（0058 DROP 后恒空），查询自带
  `information_schema` 存在性检查，作为「迁移已完成」的自证；
- `activeBillingCount(db)`——活跃账单规模预估；
- `resetOpeningMigration(db)`——删除 `migration:opening:%` 幂等键（回滚演练用；
  生产不删审计物）。

## 5. 0058 之后的世界

```
DROP：users.balance / reserved_balance / credit_limit（及两条 check 约束）、fund_operations
封存：旧 transactions 表（应用零读写；报表需求明确后再处理，plan §11 Q4）
```

此后资金一致性由**四组对账**承担（替代旧 reconcileUser 的余额↔流水等式）：
1. `wallet.verifyInvariants`（全账本：Σ腿=0 / 腿链恒等 / 余额=腿代数和）；
2. usage_logs ↔ billing_requests（既有核对）；
3. quota ↔ billing_requests（subscription 守卫保证）；
4. 渠道敞口 ↔ billing_requests（channel-budget 守卫保证）。

worker 的 reconcile 定时任务已切到 `wallet.verifyInvariants`（违规 → 告警入箱）。

## 6. 生产切换 runbook（浓缩）

1. 停流量（网关拒新请求、worker 停轮询）；
2. 确认活跃账单数（activeBillingCount）为 0 或接受③重建；
3. 跑 `migrate-opening.ts`，门禁全等才继续；
4. `pnpm --filter @ai-gateway/db exec drizzle-kit migrate`（0058 DROP）；
5. 起新代码（apps 已在钱包之上）；回滚 = 恢复列备份 + 旧镜像，不做在线双写。
