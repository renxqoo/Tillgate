# @ai-gateway/ledger —— 账本领域包（单包六域 + platform）

> **钱包是唯一资金事实源**：本包不做任何余额/在途/流水的直接读写，
> 一切资金动作通过 `@ai-gateway/wallet` 契约完成（transfer/authorize/settle/release/credit/refund）。
> 本包承载的是「业务账本」：计价、套餐、渠道运营资金、请求计费状态机、结算编排。

## 域地图与文档索引

| 域 | 目录 | 一句话职责 | 详细文档 |
|---|---|---|---|
| **platform** | `src/platform/` | 域公共底座：错误单一家谱、HTTP 映射、ledger-core 幂等执行器 | [docs/platform.md](docs/platform.md) |
| **rating** | `src/rating/` | 计价：报价最坏费用推导、费率卡系数、结算双口径实费、收据验收 | [docs/rating.md](docs/rating.md) |
| **subscription** | `src/subscription/` | 套餐生命周期（购/续/变/取消/加油包）+ 额度预留/核销/释放原语 | [docs/subscription.md](docs/subscription.md) |
| **channel-budget** | `src/channel-budget/` | 渠道运营资金：进货/调账、上游敞口硬闸、结算成本扣减与熔断 | [docs/channel-budget.md](docs/channel-budget.md) |
| **billing** | `src/billing/` | 请求计费状态机（8 态）：授权预扣管线、四事件、结算编排、死单复核 | [docs/billing.md](docs/billing.md) |
| **settlement** | `src/settlement/` | worker 结算编排：SKIP LOCKED 认领、租约保活、失败分类重试、滞留恢复 | [docs/settlement.md](docs/settlement.md) |
| **migration** | `src/migration/` | 开账迁移：旧资金模型 → wallet（幂等 + 全量相等性门禁） | [docs/migration.md](docs/migration.md) |
| 总体架构 | — | 分层、依赖铁律、事务/幂等/并发统一模式 | [docs/architecture.md](docs/architecture.md) |

## 快速装配

```ts
import { createWallet } from '@ai-gateway/wallet';
import { createBillingDomain } from '@ai-gateway/ledger/billing';
import { createSettlementProcessor } from '@ai-gateway/ledger/settlement';

// 一个 app 内通常只建一个 wallet（refTypes 白名单按 app 的资金动词域声明）
const wallet = createWallet(db, {
  accounts: [],
  refTypes: ['billing', 'topup'],   // fail-closed：未声明的业务域一律拒绝
  currencies: ['CNY'],
});

// 网关侧：授权/事件/渠道敞口/结算/死单复核
const billing = createBillingDomain({ db, wallet });

// worker 侧：结算处理器（认领 → 结算 → 重试/恢复）
const processor = createSettlementProcessor({ db, wallet, options: { ... } });
```

子导出一览：`@ai-gateway/ledger/{platform,rating,subscription,channel-budget,billing,settlement}`；
根出口 `@ai-gateway/ledger` 再导出全部装配工厂与跨域类型。

## 端到端流程图

### 1. 装配与分层（谁在用哪些域）

```
gateway ──────┬─ billing.authorize / reserveChannel / signal     （请求管线）
worker ───────┼─ settlement.runOnce / recoverOnce / inventory     （结算泵）
              ├─ billing.review()（dead 人工复核）
admin-api ────┼─ subscription.*（管理端代办）
              ├─ channelBudget.recharge/adjust（进货/调账）
client-api ───┴─ subscription.purchase/renew/change（用户自助）

═══════════ 依赖铁律（architecture.test.ts 机械强制）═══════════

 settlement ──▶ billing ──▶ { subscription · rating · channel-budget } ──▶ { wallet · ledger-core }
                                    platform（错误家谱 + HTTP 映射 + DomainTx/幂等装配）为根
```

### 2. 主生命周期：一次 PAYG/订阅请求的完整资金流

```
客户端请求
   │
   ▼
① 授权预扣 ──────────────────────────── billing/authorize.ts
   │  admission 准入闸（settlement 积压过深 → 503 拒新请求）
   │  rating.calculateRequired：候选链取最坏费用（系数生效）；explicitlyFree → 0
   │  ┌─ 事务（pg_advisory_xact_lock per user）────────────────────┐
   │  │ 每日限额（用户级+Key级：已结算 usage_logs + 六态在途 + 本次）│
   │  │ 来源解析：Key/App 凭证绑定的 subscriptionId（不信任传参）   │
   │  │ gateSubscription（订阅来源）：有效性→归属→成员日限/子配额→  │
   │  │   套餐剩余额度硬顶（不中 → 402/403）                        │
   │  │ INSERT billing_requests{authorized}（requestId 幂等重放：   │
   │  │   同指纹+同金额→replayed；异指纹→409）                      │
   │  │ ├ 金额=0 ─ fast-path 返回（不预留，行仅供观测）             │
   │  │ ├ PAYG ──▶ wallet.authorize（冻结 balance→inFlight，        │
   │  │ │            refId=requestId，无 expiresAt——生命周期归 billing）│
   │  │ └ 订阅 ──▶ reserveQuota（守卫单语句：套餐 reserved += amount）│
   │  └─────────────────────────────────────────────────────────────┘
   ▼
② 渠道敞口预留 ──────────────────────── channel-budget/exposure.ts
   │  事务：守卫 UPDATE channels.upstreamReserved += 官方价敞口
   │  同渠道更大预估 → 补足差额（F3）；换渠道 → 先留新→释放旧→CAS 认领
   │  预算不足 → allowed:false，路由换下一候选渠道
   ▼
③ 发上游 ── signal upstream.started ── authorized→in_flight（租约起）
   │           （长流式期间 lease.renewed 续租）
   ▼
④ 完成 ──── signal request.succeeded ─ billing/signal.ts
   │  rating.validateReceipt：用户一致 · G1 估算归属白名单 ·
   │  usage 自洽 · 价格快照命中授权候选（违者 PoisonReceipt 拒收）
   │  CAS → settlement_pending（收据入库，清租约，立即可结算）
   │  best-effort Redis 唤醒 worker（队列不承载资金事实）
   ▼
⑤ 结算认领 ─────────────────────────── settlement/claim.ts
   │  SKIP LOCKED 批量领 settlement_pending/retry_wait → processing
   │  写 claim 三元组（owner/token/until）+ 续租心跳防 recover 抢单
   ▼
⑥ 结算 ─────────────────────────────── billing/settle.ts（单事务）
   │  ┌─────────────────────────────────────────────────────────────┐
   │  │ 五元组复验（claim CAS + 租约未过期）                         │
   │  │  失效 → usage_logs 已有 → already_settled；否则 claim_lost   │
   │  │ computeAmounts（rating/amounts.ts）                          │
   │  │   calculated = tokens×价×系数（用户实扣）                    │
   │  │   upstreamCost = 官方价口径（系数=1，渠道进货按此扣）        │
   │  │ ├ 订阅：settleQuota（reserved−= + used+=；溢出→invariant）   │
   │  │ └ PAYG：                                                      │
   │  │    actual ≤ hold → wallet.settle(actual)（差额自动解冻）      │
   │  │    actual > hold → §4 settleOverHold（同事务三步）：          │
   │  │        authorize#over(delta) → settle#over(delta)            │
   │  │        → settle(原单, hold)    总扣款 = actual 精确           │
   │  │ recordUsage（record-usage.ts：usage_logs 投影，唯一约束幂等） │
   │  │ releaseExposure（channels.upstreamReserved −= 敞口）          │
   │  │ CAS → settled（终态；清 claim 三元组）                        │
   │  │ deductBudget（upstreamBudget −= upstreamCost；               │
   │  │   余额≤阈值 → 熔断 status=3，worker 清路由缓存）              │
   │  └─────────────────────────────────────────────────────────────┘
   ▼
⑦ 提交后效应 settlement/effects.ts（不参与资金事务，失败即吞）
      backfillTpm（Redis TPM 实际量回填）· balanceChanged（余额缓存失效）
```

### 3. 失败、恢复与死单：`authorized` 之后的全部出口

```
                          ┌─────────────────────────────────────────────┐
                          │ 任意中间态的三个「不扣钱」出口（全部同事务   │
                          │ 三路释放：wallet.release + releaseQuota +   │
                          │ releaseExposure —— release-reservations.ts  │
                          │ 唯一实现，金额对不上抛 invariant）           │
                          └─────────────────────────────────────────────┘

 authorized/in_flight ──request.failed（网关判失败）──▶ released
 authorized（过期且从未发上游）──recover①──▶ released（authorization_expired_before_dispatch）
 in_flight（租约过期=网关崩溃）──recover②──▶ released（gateway_crash_released，释放不扣）

 processing（认领租约过期=worker崩溃）──recover③──▶ retry_wait（claim 清空，立即可重领）

 结算失败 ──classifyFailure（类型化，不看文案）── settlement/failure.ts
   ├ 可重试（serialization / db_transient / unknown）──▶ retry_wait
   │    指数退避 + 抖动；attempts ≥ maxAttempts 也转 dead
   └ 永久（poison_receipt / invariant_violation）──▶ dead
        └ requestDead 告警 effect（不允许静默积压）

 dead ──人工复核── billing/dead.ts（admin-api，ledger-core 幂等 + audit_logs 审计）
   ├ retryDead   dead→retry_wait（attempts 归零，重新结算）
   └ abandonDead dead→released（确认不收费 + 三路释放）

 终态：settled（已扣）· released（未扣）——再无迁移
```

### 4. 旁路业务域（与请求生命周期并行的资金动作）

```
subscription/（用户自助 + 管理代办；资金全部 wallet.transfer 现金口径禁透支）
  purchase ──▶ wallet.transfer(user→platform_revenue) + 新订阅行（额度快照×席位）
  renew ────▶ 同上；旧订阅转到期 + Key/App 凭证改绑新订阅（续费不打断现有 Key）
  change ────▶ proration：剩余价值=价×剩余额度/总额度（FOR UPDATE 新鲜快照）
               补差价=max(0, 新总价−剩余价值) → transfer + 新订阅行 + 改绑
  grantPack ─▶ transfer(加油包价) + 套餐 quotaAmount +=（FOR UPDATE + status 守卫）
  cancel ────▶ CAS status 0→2（不涉钱；额度与余额均不动）

channel-budget/（运营资金自治域：公司采购预算，与用户资金永不混账）
  recharge ──▶ upstreamBudget +=（进货）；熔断(3)自动复活为启用(0)
  adjust ────▶ upstreamBudget ±（守卫：不得调为负）
               （结算侧的敞口预留/释放/扣减熔断已在主生命周期 ②⑥ 内）

wallet 内核三动词口径（ledger 对钱的全部动作只经此三处）
  authorize：balance→inFlight（守卫 balance+creditLimit−inFlight ≥ amount）
  settle   ：inFlight→实际扣款入收入（≤hold 由内核保证）
  release  ：inFlight→balance（原路归还）
```

一句话不变量：**主生命周期 ⑥ 是唯一的扣钱路径（单事务）；失败/恢复的每个出口都三路归零、绝不留冻结；旁路域的钱只进 wallet 复式两端**——`billing_requests` 的 8 态里，钱只会停在 `settled`（已扣）或回到 `released`（未扣），不存在第三种结局。

## 三条硬规则（全包生效）

1. **资金单一事实源**——域内禁止直写余额/在途/流水；钱包动词（带 `tx` 注入）是唯一资金通道。
2. **依赖单向**——`settlement → billing → {subscription, rating, channel-budget} → {wallet, ledger-core}`；
   `platform` 被所有域引用、不依赖任何域；任何域不得反向 import。
3. **幂等一律走 ledger-core**——operationId 全局唯一 + canonical 指纹 + 回执重放；
   platform 的 `createDomainOperations` 是唯一装配点。

## 测试

域测试与实现同目录（`src/<域>/__tests__/`），共 64 例（含架构边界测试），全部跑真实 PostgreSQL。
四门（typecheck / lint / test / build）在根目录 `pnpm typecheck && pnpm lint && pnpm test && pnpm build`。
