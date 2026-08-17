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

// 退款（余额守卫）与余额查询
await wallet.refund({ userId, amount: '59.00', refType: 'topup_refund', refId: tradeNo });
await wallet.balance(userId);

// worker 周期调用：超时冻结转 expired 并归还在途
await wallet.releaseExpired(new Date(), 100);
```

## 不变量（代码 + DB check 双保险）

- 每笔冻结必达终态（settled / released / expired），settle 与 release 经 CAS 互斥
- 流水链恒等：`balance_after = balance_before + amount`（DB check 兜底）
- `balance`、`in_flight` 恒非负；settle 不得超过冻结额
- 同一业务键同一动作至多一条流水：`(ref_type, ref_id, kind)` 唯一索引

## 业务约定

- 金额恒为字符串（Decimal 全精度，永不 round；1e-18 级不丢不进科学计数法）
- 调用方只带 `userId + 金额 + 幂等键（refType/refId）`，资金安全全部由本包承担
- 金额字符串格式：`≤20 位整数 + ≤18 位小数`（numeric(38,18) 落库前防御）

## 设计边界（消费方须知，刻意为之）

1. **单币种**：无 currency 列；多币种 = 每币种独立账户（未来可迁移 (user_id, currency) 主键，属破坏性变更）
2. **预付模型**：balance ≥ 0 恒成立；账期/后付款（应收账款）模式不适用
3. **一个冻结单次结算**：分次扣款应建模为多次独立 authorize
4. **幂等键全局唯一**：(ref_type, ref_id) 不含 user 维度；跨账户顶撞抛 `RefKeyConflictError`（键设计责任在调用方，此错误是串号事故的最后闸门）

## 表（本包私有三表）

`wallet_accounts`（balance + in_flight）/ `wallet_authorizations`（冻结单状态机）/
`wallet_transactions`（有符号流水，链式不变量）。测试 beforeAll 建 / afterAll 删，
不碰业务表。

## 测试

16 组契约测试打真 PG：幂等（顺序重放/并发竞态）、部分结算、超扣拒绝、
状态机互斥、余额守卫、超时释放、流水链恒等、全精度。`pnpm --filter @ai-gateway/wallet test`。
