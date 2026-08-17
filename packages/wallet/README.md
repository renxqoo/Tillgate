# @ai-gateway/wallet

通用资金钱包：**业务无关**的两阶段账本。不依赖本仓任何其他包（仅
decimal.js / drizzle-orm / zod），可整体目录拎出独立仓复用——电商订单
（冻结→实扣/取消）、内容平台（打赏/按次付费）与 AI 网关（推理预扣→结算）
在它眼里是同一套动词。

## API（4+2 个动词）

```ts
import { createWallet, provision } from '@ai-gateway/wallet';

const wallet = createWallet(db);   // drizzle 实例（node-postgres）
await provision(db);               // 一次性建表（幂等）

// 充值入账（幂等：回调重放/并发只入一次账）
await wallet.credit({ userId, amount: '99.00', refType: 'topup', refId: tradeNo });

// 下单冻结（两阶段第一步；expiresAt 到点由 releaseExpired 释放）
const hold = await wallet.authorize({ userId, amount: '259.00', refType: 'order', refId: orderId, expiresAt });

// 支付成功实扣（可少于冻结额，余量自动归还）；或取消释放
await wallet.settle({ refType: 'order', refId: orderId, amount: '259.00' });
await wallet.release({ refType: 'order', refId: orderId, reason: 'user_cancel' });

// 退款（授信地板守卫）与余额查询
await wallet.refund({ userId, amount: '59.00', refType: 'topup_refund', refId: tradeNo });
await wallet.balance(userId);

// 多币种（缺省 CNY；一币一账互不净额）
await wallet.credit({ userId, currency: 'USD', amount: '14.99', refType: 'topup', refId: stripeId });

// 授信地板（缺省 0 = 纯预付）：可用 = balance + credit_limit − in_flight
await wallet.setCreditLimit({ userId, amount: '50', refType: 'credit_line', refId: grantId });
const summaries = await wallet.accounts(userId);   // 全部币种账户摘要

// worker 周期调用：超时冻结转 expired 并归还在途
await wallet.releaseExpired(new Date(), 100);
```

## 不变量（代码 + DB check 双保险）

- 每笔冻结必达终态（settled / released / expired），settle 与 release 经 CAS 互斥
- 流水链恒等：`balance_after = balance_before + amount`（DB check 兜底）
- `balance ≥ −credit_limit`、`in_flight`、`credit_limit` 恒非负；settle 不得超过冻结额
- 同一业务键同一动作至多一条流水：`(ref_type, ref_id, kind)` 唯一索引（键不含币种维度）

## 业务约定

- 金额恒为字符串（Decimal 全精度，永不 round；1e-18 级不丢不进科学计数法）
- 调用方只带 `userId + 金额 + 幂等键（refType/refId）`，资金安全全部由本包承担
- 金额字符串格式：`≤20 位整数 + ≤18 位小数`（numeric(38,18) 落库前防御）

## 设计边界（消费方须知，刻意为之）

1. ~~单币种~~ → **已支持多币种**：`(user_id, currency)` 一币一账互不净额；动词可选传 currency（缺省 CNY，单币种业务零感知）；幂等键与币种无关（同键跨币顶撞报错）；跨币换汇是业务的两腿操作（汇率是策略，不进底层）
2. ~~纯预付~~ → **已支持授信地板**：`credit_limit`（缺省 0 = 纯预付），可用口径 = balance + credit_limit − in_flight，balance 可至 −credit_limit；`setCreditLimit` 幂等（授多少是业务策略，地板机制在底层）。真账期（发票/催收）是单据系统，不属钱包
3. **一个冻结单次结算**：分次扣款 = 多次独立 authorize（分次结算 installment 维度已设计、挂起——等真实分期业务，避免为想象需求付并发模型复杂度）
4. **幂等键全局唯一**：(ref_type, ref_id) 不含 user/币种维度；跨账户/跨币种顶撞抛 `RefKeyConflictError`（键设计责任在调用方，此错误是串号事故的最后闸门）

## 表（本包私有三表）

`wallet_accounts`（balance + in_flight）/ `wallet_authorizations`（冻结单状态机）/
`wallet_transactions`（有符号流水，链式不变量）。测试 beforeAll 建 / afterAll 删，
不碰业务表。

## 测试

16 组契约测试打真 PG：幂等（顺序重放/并发竞态）、部分结算、超扣拒绝、
状态机互斥、余额守卫、超时释放、流水链恒等、全精度。`pnpm --filter @ai-gateway/wallet test`。
