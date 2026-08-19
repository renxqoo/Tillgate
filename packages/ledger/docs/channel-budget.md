# channel-budget —— 渠道运营资金域（自治）

> 出口：`@ai-gateway/ledger/channel-budget`
> 源码：`src/channel-budget/{types,recharge,exposure,closeout,index}.ts` + 7 例测试

## 1. 职责与边界

渠道「进货额度」的全生命周期：管理端入货/调账、路由选渠前的上游成本敞口硬闸、
结算后的真实成本扣减与熔断。

**自治决策（plan §7 / Q3 拍板）**：渠道采购预算是**公司运营资金**，与用户资金永不混账；
`channels.upstream_budget/upstream_reserved` 留业务表，域内自带守卫，**不进 wallet**。
熔断（status=3）是运营语义不是资金不变量。已预留进总账路径：
`platform_revenue → channel_cost` 的 wallet.transfer 结转（本期不启用）。

## 2. 领域模型（channels 表相关列）

| 列 | 语义 |
|---|---|
| `upstream_budget` | 当前余额（元）。入货 +、调账 ±、结算按真实上游成本原子扣减。余额可为负（历史/在途超支），≤ 阈值即熔断 |
| `upstream_threshold` | 熔断阈值（NULL=0，耗尽才熔断） |
| `upstream_reserved` | 在途上游成本敞口。路由时原子累加，结算/释放时原子扣减 |
| `status=3` | 熔断（软闸）：worker bump 路由缓存，入货自动复活为 0 |

`channel_recharges` 表承载进货/调账流水（含 balance_after 快照与凭证引用）。

## 3. 对外 API

### recharge.ts —— 管理端资金动词
`createChannelBudget({ db, clock? })` 装配（内部建 `['channel.recharge','channel.adjust']`
幂等实例）；凭证截图的 base64 校验与 storage 是 **app 表现层职责**，域收已落储的
`voucherKey`（指纹只含 hasVoucher 布尔，不含 20MB 内容）。

| 动词 | 语义 |
|---|---|
| `recharge({operationId, channelId, amount>0, orderNo?, voucherKey?, remark?, adminId})` | budget += amount；**入货复活熔断渠道**（status 3→0）；流水落库；同键重放返回首次结果 |
| `adjust({…, amount≠0 可负})` | budget ± amount；WHERE 内联守卫「不得调负」→ `ChannelBudgetError('insufficient_budget')` |
| `adjustWouldBeNegative(current, amount)` | 路由预校验（事务内仍以 WHERE 兜底） |

### exposure.ts —— 敞口硬闸
`reserveExposure(db, clock, {requestId, channelId, amount})`：
路由选渠前为本次上游成本预估（官方价口径、系数=1）原子预留在途敞口。
**全部守卫内联 UPDATE WHERE（R4：check-then-act 并发超扣在结构上不存在）**，
变更顺序不变量（换渠道路径）：

```
① 守卫预留新渠道（预算-敞口 ≥ 金额，0 行 = 零变更拒绝 allowed:false）
② 预留成功后释放旧渠道敞口（失败 → 抛错回滚新预留，不留孤儿）
③ CAS 认领账单行（status ∈ {authorized,in_flight} + channelId/channelReservedAmount
   等于读到的旧值；输家整体回滚）
```

早退（拒绝）发生在零变更状态——「先释放后预留」的旧顺序在守卫输掉并发时会提交
孤儿释放（敞口少记 + 结算二次释放偷走他人敞口），竞态红测修正后固化为此序。

**同渠道补足（F3）**：主模型预估 ¥5 全失败 → fallback 预估 ¥8 路由回同一渠道，
敞口按差额 5→8 补足（预算不足则拒绝，调用方换渠道）。

### closeout.ts —— 结算收尾
| 函数 | 语义 |
|---|---|
| `releaseExposure(tx, {channelId, channelReservedAmount})` | 结算/释放前归还本单敞口；0 行 = `BillingInvariantError`（敞口事实脱节） |
| `deductBudget(tx, channelId, upstreamCost)` | 结算后按**真实**成本扣减 budget；余额 ≤ 阈值 → 熔断 status=3（返回 true，worker 清路由缓存） |

## 4. 技术架构

- **幂等**：ledger-core kinds `channel.recharge/adjust`；预算只动一次。
- **并发**：预算闸是单语句条件 UPDATE（`WHERE upstream_budget - upstream_reserved ≥ amount`），
  认领是渠道投影 CAS——多网关副本并发换渠无双账。
- **口径分离**：敞口/扣减用官方价（upstreamCost），用户侧费率（coefficient）不掺入
  ——渠道毛利 = 用户实扣 − 进货扣减，结构上可对账。
- **错误**：`ChannelBudgetError`（HTTP 404/422）+ invariant 红灯交结算分类。

## 5. 测试（7 例）

入货累加/熔断复活/同键重放/404、调账正负与不得调负、预算内预留与预算外零变更拒绝、
F3 同渠道差额补足、换渠原子替换（新预留+旧释放+账单投影改绑）、结算释放+扣减+阈值熔断、
释放守卫 invariant。
