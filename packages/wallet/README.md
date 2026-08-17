# @ai-gateway/wallet

通用企业级钱包：**复式账本**（double-entry）+ 业务无关两阶段扣费。零 workspace 依赖
（仅 decimal.js / drizzle-orm / zod），可整目录拎出独立仓——电商/AI/订阅同构复用。

## 会计模型（复式三件套）

- **腿（legs）**：每笔资金交易 = 批头（幂等键）+ ≥2 腿，**Σ 腿 = 0**（有借必有贷）；
  每腿独立链式恒等 `after = before + amount`（DB check）
- **内部科目（chart of accounts）**：账户分 `user`（用户，按 `(user_id, currency)`）与
  `internal`（科目，按 `(code, currency)`）——`outside` 外部世界镜像、`platform_revenue`
  平台收入（结算即收入确认）、业务自定义科目（如 `marketing_expense`）按需自动建
- **原子转账（transfer）**：双腿守恒，`from/to` 可为用户或科目——分账/P2P/佣金拆分
  的结构保证；同币种限定（换汇 = 两笔独立转账）

## API

```ts
import { createWallet, provision } from '@ai-gateway/wallet';
const wallet = createWallet(db);
await provision(db);

// 充值（对手腿自动落 outside；可指定 counterparty 科目）
await wallet.credit({ userId, amount: '99.00', refType: 'topup', refId: tradeNo });

// 两阶段扣费：冻结 → 实扣（收入自动确认到 platform_revenue；可少于冻结额）→ 或释放
await wallet.authorize({ userId, amount: '259.00', refType: 'order', refId: orderId, expiresAt });
await wallet.settle({ refType: 'order', refId: orderId, amount: '249.00' });
await wallet.release({ refType: 'order', refId: orderId, reason: 'user_cancel' });

// 退款（原路退回 outside；费用承担型退款可指定 counterparty）+ 原子转账
await wallet.refund({ userId, amount: '59.00', refType: 'topup_refund', refId: tradeNo });
await wallet.transfer({ from: { code: 'platform_revenue' }, to: { userId: merchantId },
  amount: '80.00', refType: 'payout', refId: settlementId });   // 分账：佣金留收入

// 多币种（缺省 CNY，一币一账互不净额）+ 授信地板（缺省 0 = 纯预付）
await wallet.credit({ userId, currency: 'USD', amount: '14.99', refType: 'topup', refId: id });
await wallet.setCreditLimit({ userId, amount: '50', refType: 'credit_line', refId: grantId });

// 风控冻结（拒绝一切资金变动，查询不受限）+ 账户摘要 + 超时释放扫描
await wallet.freeze({ target: { userId }, frozen: true, refType: 'risk_control', refId });
const summaries = await wallet.accounts(userId);
await wallet.releaseExpired(new Date(), 100);
```

## 不变量（代码 + DB check 双保险 + 对账测试）

- 每笔资金交易 Σ 腿 = 0；每账户腿链恒等且连续；账户余额 = 腿的代数和
- 每笔冻结必达终态（settled / released / expired），settle 与 release 经 CAS 互斥
- 用户账户 `balance ≥ −credit_limit`（授信地板；内部科目按语义可负——outside 镜像）
- settle 不得超过冻结额；同一业务键同一动作至多一笔交易（`(ref_type, ref_id, kind)` 唯一）
- 冻结账户拒绝一切资金变动

## 设计边界

1. **多币种**：一币一账互不净额；跨币 = 两笔独立转账（换汇汇率是业务策略）
2. **授信地板**：覆盖「先花后充、封顶欠款」；真账期（发票/催收）是单据系统不属钱包
3. **一个冻结单次结算**：分次扣款 = 多次独立 authorize（installment 维度已设计、挂起）
4. **幂等键全局唯一**：不含 user/币种维度；跨账户/跨币种顶撞抛 `RefKeyConflictError`
5. **守卫前重放**：transfer/refund/authorize 的幂等快速路径先于余额守卫——首笔花掉余额后重放不被守卫误伤

## 表（本包私有四表）

`wallet_accounts`（user/internal 账户）/ `wallet_transactions`（批头，幂等键）/
`wallet_legs`（腿，链式恒等）/ `wallet_authorizations`（冻结单状态机，释放审计在单据）。
测试 beforeAll 建 / afterAll 删 + 全账本对账（Σ=0 / 链恒等 / 余额=代数和）。

## 测试

32 组契约测试打真 PG：复式守恒与对账、科目累积（差值断言）、两阶段全场景、
并发竞态（双结算/双入账恰好一次）、授信地板、多币种隔离、transfer 全家
（分账/同账户/跨币/守卫/重放）、freeze 风控、1e-18 精度。
`pnpm --filter @ai-gateway/wallet test`。
