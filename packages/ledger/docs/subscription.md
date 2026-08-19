# subscription —— 套餐与额度域

> 出口：`@ai-gateway/ledger/subscription`
> 源码：`src/subscription/{types,period,proration,eligibility,purchase,renew,change,cancel,pack,quota,index}.ts` + 23 例测试

## 1. 职责与边界

套餐全生命周期：购买/续费/升档变更/取消/加油包，外加**额度原语**
（预留/核销/释放——billing 的订阅计费路径调用）。**域内零余额读写**：
资金动作全部 `wallet.transfer(user → platform_revenue, allowCredit: false, tx)`
——现金口径锁内守卫（禁透支购买），幂等走 platform 幂等执行器
（kinds：`subscription.purchase/renew/change/cancel` + `pack.grant`）。

表归属：`plans / user_subscriptions / organizations / org_members` 留在 db 包（业务表）。

## 2. 领域模型

`plans`：kind（subscription/pack）、sortOrder（层级）、price、periodDays、
quotaAmount、allowSeats（团队席位）。
`user_subscriptions`：快照（quotaAmount/price 按 `档 × 席位`）、usedAmount/reservedAmount
（额度消费与在途）、quantity（席位）、orgId（组织订阅）、status（0 有效/1 到期/2 取消）。
DB 硬不变量：每用户/每组织至多一条 active（部分唯一索引）；
`used + reserved ≤ quota` 且二者非负（check）。

## 3. 纯函数层（独立可测的公式单一真相）

| 文件 | 函数 | 公式 |
|---|---|---|
| period.ts | `renewalStart(oldEnd, now)` | 未到期续费从旧 end 顺延；到期后从 now 起 |
| | `periodEnd(start, periodDays)` | start + N 天 |
| proration.ts | `remainingQuota(snap)` | 总额度 − 已用 − 在途 |
| | `remainingValue(snap)` | 总价 × 剩余额度/总额度（线性折旧；总额度 ≤ 0 → 0） |
| | `changeDiff(newTotal, remaining)` | max(0, 新总价 − 剩余价值)（≤0 免费升级） |
| eligibility.ts | `assertChangeEligibility` | 只升不降（层级不降、席位不缩容）且至少一项变化；无变化 = already_subscribed |
| | `assertSeatsAllowed` | qty>1 需 allowSeats；allowSeats 套餐需企业账户（即使 qty=1，防绕过开共享池） |

## 4. 动词层（每动词一文件）

所有动词经 `createSubscriptionDomain({ db, wallet, effects?, clock? })` 装配，
回执 `SubscribeResult`（幂等重放返回首次存档）。

### purchase / renew（共用核心 `applySubscriptionCore`）
事务内顺序：
1. **renew**：锁有效订阅（status=0）→ 归属校验 → 继承（席位/套餐/org/顺延起点）→
   CAS 旧订阅转到期（0 行 = 并发改态 → `no_subscription`）。
   **purchase**：数量校验 → 惰性翻转「已自然到期但 status=0」的行（不翻则新购撞
   one_active_uq 死锁）→ active 检查 → `already_subscribed`。
2. 用户存在性 + plan 闸（存在/上架/正价——零价套餐是免费额度印刷机，资金侧最后防线/
   是订阅不是加油包/席位能力 + 企业门槛）。
3. 团队套餐 `ensureOrg`：**组织在账本事务内创建**（与订阅同生共死；路由层预建会在
   购买失败留孤儿 org，重放时新 org 改指纹 → 409 幂等失效）。
4. **资金**：`chargeCash` = wallet.transfer → platform_revenue（allowCredit:false）；
   现金不足抛 wallet `InsufficientCashError`（402 语义）。
5. 新订阅行（快照落库）+ renew 凭证改绑（apiKeys/apps 指向新订阅，续费不打断现有 Key）。
6. 唯一索引并发兜底：one_active_uq 冲突 → `already_subscribed`（事务回滚，幂等键随事务回退可安全重试）。

### change（升档）
FOR UPDATE 锁订阅行拿**新鲜快照**（F2：无锁读会与并发结算竞态 → 剩余价值被低估 →
多收）→ 纯函数判资格与折算 → CAS 旧订阅转到期（0 行拒绝）→ diff>0 才收款
（免费升级零资金变动，回执余额快照 null）→ 新行 + 凭证改绑。

### cancel
CAS status 0→2，不涉钱（剩余额度作废不退款）。重复取消 → `no_subscription`。

### pack（加油包）
加油包加的是**订阅额度**：FOR UPDATE 选有效订阅（无锁读会与并发取消竞态 →
钱进死行）→ 现金收款 → 额度累加带 status=0 守卫并校验 returning（0 行 =
`subscription_inactive`，P1-3 不变量下沉）。

## 5. quota 原语（billing 订阅路径的写入口）

额度不是钱、不进 wallet（复杂度不值，plan Q5 拍板）；不变量下沉在
**守卫 UPDATE 单语句原子判定** + DB check 兜底：

| 函数 | 语义 | 0 行命中的语义分流 |
|---|---|---|
| `reserveQuota(tx, {subscriptionId, userId, amount})` | `reserved += amount`（WHERE status=0 且剩余额度足够） | 订阅失效 → `SubscriptionRequiredError`；额度不足 → `SubscriptionQuotaExhaustedError`（402） |
| `settleQuota(tx, {subscriptionId, reserved, consumed})` | 释放预占 + 核销消费（WHERE reserved 足额 且 used+consumed+reserved_after ≤ quota） | `BillingInvariantError('subscription_quota_invariant')`（账单与额度事实脱节 → dead 人工） |
| `releaseQuota(tx, {subscriptionId, reserved})` | `reserved -= reserved`（失败/取消/回收路径） | `BillingInvariantError('subscription_reservation_invariant')` |

成员日限 a / 成员配额 b / 订阅有效性防御在 billing 的来源闸
（`billing/gates/source.ts`）——**拒绝语义在闸、写入在原语**，两层共享同一额度公式。

## 6. 测试（23 例）

- `domain-math.test.ts` 10 例：窗口顺延/线性折旧/免费钳 0/只升不降/无变化/席位门槛。
- `verbs.test.ts` 11 例：购买扣 wallet+订阅行+同键重放不双扣/禁透支（授信在场也拒绝，
  零残留）/C4 惰性翻转/续费顺延与继承/已取消不得复活/折算差价（按已用折旧）/
  降级与无变化拒绝/同档加座/pack 额度累加与无订阅拒绝。
- `quota.test.ts` 4 例：预留守卫与语义分流/核销守卫/释放守卫/invariant 红灯。
