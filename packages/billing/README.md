# @tillgate/billing

> 唯一资金与计费事实源：金额、钱包、双分录账本、计价、订阅、支付、兑换、结算与恢复。
> 裁决：[ADR-0003](../../docs/adr/0003-wallet-ledger-merge-into-billing.md)；
> 设计基线 [DESIGN.md](./DESIGN.md)；施工图 [IMPLEMENTATION.md](./IMPLEMENTATION.md)；
> 逐单元迁移记录 [MIGRATION-U0](./MIGRATION-U0.md) ~ [MIGRATION-U5](./MIGRATION-U5.md)。

## 1. 快速开始（app assembly）

```ts
import { createPostgresBilling } from '@tillgate/billing/composition';

const billing = createPostgresBilling(db, {
  retry: { maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20 }, // v1 等价值
  guards: {
    refTypes: ['billing', 'topup', 'admin', 'subscription', 'pack', 'redeem'],
    currencies: ['CNY'],
    internalAccounts: ['outside', 'platform_revenue'],
  },
  currency: 'CNY',
  resolver: myFundingSourceResolver, // 凭证→订阅/开关/限额（桥接 accounts/identity）
  failurePolicy: { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 60_000 },
  wake: (requestId) => settleWakeup.publish(requestId), // 纯门铃，可丢
});

// 网关授权链
const auth = await billing.billing.authorize({ requestId, userId, quote, ... });
// worker 结算
const claims = await billing.settlement.claim({ ownerId, batchSize, claimLeaseMs });
```

窄子入口（单一职责消费方）：

```ts
import { createWalletApi } from '@tillgate/billing/wallet'; // 对账/运维
import { createSettlementApi } from '@tillgate/billing/settlement'; // worker
```

## 2. 按角色的用法

### 2.1 网关（authorize / signal / reserveChannel）

- `billing.authorize`：保守预估（rating 四道保守 + B2 cacheWrite 贵价）→ 资金瀑布
  （订阅先耗、PAYG 补差、`#over` 负余额补扣）→ billing_requests + reservations 落账。
- `billing.signal`：四事件状态机（upstream.started / lease.renewed /
  request.succeeded（收据验收→settlement_pending）/ request.failed（三路释放））。
- `billing.reserveChannel`：渠道进货额度三模式（covered/topup/switch），零变更拒绝。

### 2.2 worker（settlement）

- `claim`（SKIP LOCKED）→ `processClaim`（五元组复验→双口径金额→分配→逐源核销→
  usage 投影→渠道敞口归还→CAS settled→进货扣减熔断）；失败自动分类（毒收据死信/
  瞬态退避）；`recover` 三路径滞留兜底；`verifyInvariants` 对账哨兵（只读）。
- worker 波增补消费面：`currentStatus`（生成任务轮询自愈判定）、
  `createReferralCommissionUseCase`（佣金日结——rate/refId 桥接 accounts 词表）、
  `createRecordDiscrepanciesUseCase`（对账差异落表）、`SETTLE_WAKE_CHANNEL`
  （PG NOTIFY 通道契约，gateway 生产端同值）；入箱事件名为词表成员 `billing_dead`
  （结算成功不入箱——无告警消费场景）。迁移记录见 MIGRATION-U7。

### 2.3 支付与兑换（app 按环境组合）

```ts
import { createPaymentsApi, createEpayProvider, createStripeProvider } from '@tillgate/billing';

const payments = createPaymentsApi({
  store,
  orders,
  wallet,
  providers: [createEpayProvider(env.epay)],
  currency: 'CNY',
  exchangeRate: '1',
  topupMin: '1',
  topupMax: '1000',
  orderTtlMs: 600_000,
});
```

资损不变量（实现保证，消费方勿绕）：creditAmount 创建定死；验签+金额双闸；
markPaid→credit→markCredited 单事务；先落库再调渠道；过期单复活；兑换核销与入账同事务。

### 2.4 错误处理（AGENTS.md §11）

全部业务拒绝经 `BillingErrors` 目录（48 码；捕获按 nature/category，不做跨包
instanceof）：

```ts
catch (e) {
  if (isBusinessError(e) && e.category === 'quota_exhausted') { /* 提示充值/换档 */ }
  else throw e;
}
```

## 3. 金额与指纹契约（全包硬约束）

- 金额一律字符串（元），`Decimal`（precision 40）运算，账本永不 round，
  禁科学计数法落库；构造入口 `parsePositiveAmount`/`parseNonNegativeAmount`。
- 命令指纹严格 canonical（码点键序；undefined/NaN/类实例拒绝）；
  幂等键 = 业务自然键 `(refType, refId)`，重放回授首笔事实。

## 4. 测试与门禁

- 默认门禁：`bun run test`（内存 stand-in）；覆盖率阈值 90/85/90/90。
- 真实 PG：`DB_TEST_URL=... bun run test:real`——钱包并发/不变量、结算全链
  （完整迁移链空库升级 + SKIP LOCKED 认领 + 渠道熔断 + 恢复 + 对账零漂移）。
- adapters 只由真 PG 语义覆盖（默认覆盖率分母排除——与 accounts 包同约定）。

## 5. 边界（不处理，归属见他包）

通知投递（notifications）、费率卡/汇率管理（control-plane）、用户/组织/凭证资料
（accounts/identity）、渠道熔断健康消费（inference）、HTTP/队列协议（apps）、
表 DDL（@tillgate/db）。
