# billing —— 请求计费状态机域（钱包之上）

> 出口：`@ai-gateway/ledger/billing`（装配在 `src/billing/domain.ts`）
> 源码：`src/billing/{state,gates/*,authorize,signal,settle,release-reservations,dead,lease,review-errors,types,domain}.ts` + 6 例核心流测试

## 1. 职责与边界

一次推理请求的**资金生命周期编排**：授权预扣 → 上游起租 → 成功收据/失败释放 →
worker 结算 → 死单人工复核。billing_requests 保留 8 态业务状态机，**不持有资金**——
PAYG 资金在 wallet 冻结单（refType `'billing'`，refId = requestId），订阅额度在
subscription.quota，渠道敞口在 channel-budget。

铁律：冻结单**不设 expiresAt**——生命周期由本域显式 release/settle 管理
（recover 兜底滞留），与 wallet 自身的超时释放是两套互不干扰的系统，避免双超时打架。

## 2. 装配

```ts
createBillingDomain({ db, wallet, clock?, admission? }): BillingDomain
// authorize / reserveChannel / signal / settleClaim / review()
```
wallet 的 refTypes 白名单须含 `'billing'`。admission 传 `{maxPending, maxOldestAgeMs, cacheMs}`
启用积压准入闸（可选）。

## 3. authorize 管线（`gates/ + authorize.ts`）

```
准入闸（backlog 自我保护，短缓存 + 探针合并）
→ 金额推导 rating.calculateRequired（最坏费用 → 单请求上限）
→ db.transaction {
    pg_advisory_xact_lock(user)                    // F4：SUM 类限额串行化
    → 每日限额 + 来源解析（gates/daily-limit）
    → INSERT billing_requests（ON CONFLICT 幂等占位；同指纹重放返回现状，异指纹 409）
    → 0 元 fast-path（免费模型不预留，行只作链路观测）
    → 订阅来源：gates/source（有效性/owner-org 防御/成员日限 a/成员配额 b/额度硬顶）
                + subscription.reserveQuota（写入）
       PAYG：wallet.authorize（守卫 = balance + credit_limit − in_flight ≥ amount，
            锁内原子；无 expiresAt）
  }
→ 回执余额口径读 wallet.accounts（提交后一致快照）
```

关键设计：
- **advisory lock 只为 SUM 口径**：已结算（usage_logs 按结算时间归属窗口）+ 在途
  （billing_requests **不按创建时间过滤**——跨窗口边界仍在途的请求结算时落进新窗口，
  两侧口径必须对称，否则限额可跨日叠加突破）+ 本次 ≤ 上限。
- **来源以凭证绑定为准，不信任调用方传参**：apiKeyId → apiKeys.subscription_id，
  appId → apps.subscription_id（单一查询兼顾 Key 级日限与来源解析）。
- 幂等重放**先于**守卫：重放不该被余额守卫误伤（INSERT 冲突即读回）。

## 4. signal 四事件（`signal.ts`）

| 事件 | 迁移 | 要点 |
|---|---|---|
| `upstream.started` | authorized → in_flight | 起租约（覆盖整个请求预算）；重发幂等 |
| `lease.renewed` | in_flight 续租 | owner 校验（只有租约持有者能续） |
| `request.succeeded` | → settlement_pending | 收据验收链：requestId 一致 → 同指纹重放幂等 → 状态必须 authorized/in_flight → **rating.validateReceipt**（用户一致/usage 自洽/估算归属 G1/价格快照命中授权候选）→ 条件 UPDATE 落收据（竞态输家按指纹判幂等/冲突） |
| `request.failed` | → released | **释放不扣**：三路预扣同事务归还（release-reservations 唯一实现）；`amountReleased` 是链路「未扣费」证据 |

## 5. settle 结算编排（`settle.ts`）

认领复验（claim 三元组 + 租约 + status=processing）→ 幂等回查（usage_logs 已有 →
already_settled；认领失效 → claim_lost）→ 归属校验（userId/估算归属 G1/渠道一致）→
金额（rating.computeAmounts）→ 分路：

**PAYG（subscriptionId == null）**：
- actual ≤ hold → `wallet.settle`（结算即收入确认，counter-leg = platform_revenue）
- **actual > hold → §4 补充授权结算**（同一事务三步）：
  `wallet.authorize(refId: ${requestId}#over, delta)` → `wallet.settle(#over, delta)` →
  `wallet.settle(原单, hold)`。补充授权的可用额判定含授信——不通过整体拒绝，
  等价旧「信用地板」语义；statement 呈现两笔结算，复式守恒、审计可追。

**订阅**：`subscription.settleQuota`（释放预占 + 核销实际消费，单语句守卫；
溢出 = invariant → dead 人工——旧逻辑 planCharge=min(calc, remaining) 的等价收敛）。

随后：`recordUsage`（**record-usage.ts**，usage_logs 落库，requestId 唯一幂等；估算标记合取收口：
reason 只属于 estimated=true 的行）→ `channel-budget.releaseExposure` →
CAS settled（revision + claim 三元组）→ `deductBudget`（真实成本扣减 + 熔断判定）。

资金流水不再写旧 transactions——wallet statement（`wallet_legs.balance_after` 逐条
余额历史）就是流水。

## 6. release-reservations（三路释放唯一实现）

一个请求的预扣落在三处：**wallet 冻结单**（PAYG 部分 = reserved − plan 部分）、
**订阅额度在途**、**渠道在途敞口**。释放必须三路同步，任何遗漏都是永久冻结（R1 教训）。
消费方：signal(request.failed) / settlement recover / dead(abandon)。
settle 的「释放+核销」是合并语义，不经此处。

## 7. dead 死单复核（`dead.ts` + `review-errors.ts`）

`createBillingReview({db, wallet})`（由 domain.review() 惰性创建）：
- `listCases/countCases`：金额优先排序的复核队列；
- `retryDead`：CAS dead → retry_wait（清 attempts/失败类，立即重结）；
- `abandonDead`：CAS dead → released + 三路释放预扣。
幂等走 ledger-core（kinds `billing.retry_dead/abandon_dead`）+ audit_logs 审计；
`BillingOperationError`（not_found/state_conflict/idempotency_conflict/invalid_receipt）
→ 管理端 409/404。

## 8. 状态机（真相在 CAS 守卫）

8 态状态机没有独立的迁移表——**每条迁移就是一条条件 UPDATE（CAS）的
`WHERE status in (...)`**，散布在 signal（succeeded/failed）、claim（认领）、
settle（settled 收尾）、failure（retry/dead）、recover（三类滞留）、dead
（人工 retry/abandon）六个文件里，与资金动作同事务。终态只有 settled/released；
全量迁移图见 docs/architecture.md §7（按真实生产者绘制）。

## 9. 测试（6 例核心流）

PAYG 闭环（授权冻结→重放→起租→收据→认领结算实扣 0.6、在途归零）、
补充授权结算（actual 3 > hold 2：余额 −3、statement 两笔结算）、
失败释放（在途归还余额不动）、余额不足零残留、
订阅路径（授权占额度不占 wallet、结算核销 used、wallet 零动作）、
免费模型 fast-path（0 元无预占）。
