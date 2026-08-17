# @ai-gateway/wallet

通用企业级钱包：**复式账本** + 业务无关两阶段扣费。零 workspace 依赖（仅
decimal.js / drizzle-orm / zod），可整目录拎出独立仓——电商/AI/订阅同构复用。

下面按「跟着钱走一遍」的方式讲清楚全部业务逻辑，不需要会计背景。

---

## 一、30 秒理解：钱包里只有三个数字

每个用户每个币种一行账户，只有三个数字在变：

```
┌──────────────────────────────────────────────────┐
│ 账户（张三 / 人民币）                              │
│                                                  │
│  balance 余额 300     ← 完全属于你的钱            │
│  in_flight 在途  0    ← 被冻结单"押着"的部分      │
│  credit_limit 授信 0  ← 允许欠款的地板（0=不许欠） │
│                                                  │
│  能花的钱 = 余额 + 授信 − 在途 = 300              │
└──────────────────────────────────────────────────┘
```

**冻结就像酒店押金**：下单时押 259（钱还在你账上，但花不了了）；支付成功才真扣；
取消就解押。这「押 → 扣 / 解」就是整个钱包的核心节奏。

## 二、每笔交易都是"一进一出"（复式记账）

钱永远不凭空出现或消失——**每笔交易至少两条腿，一进一出，合计为零**：

```
充值 99 元：

   用户张三          外部世界(outside)
  ┌───────┐        ┌───────┐
  │ +99   │  ←───  │ −99   │     钱从外部来
  └───────┘        └───────┘
   腿1: +99    +    腿2: −99   =  0  ✓ 有借必有贷
```

`外部世界`、`平台收入` 这些叫**内部科目**——它们是钱的"来处"和"去处"的账本位置。
最有用的是 `platform_revenue`（平台收入）：**每笔结算自动记一笔收入**，
分账、对账、算佣金都从这里读。

## 三、核心业务流程图

### 流程 1：电商下单（最常用）

```
 用户                 钱包                          说明
  │                   │
  ├── 下单 259 元 ──→ authorize ──→ 押住 259         在途 +259（余额没动！）
  │                   │
  │        ┌──────────┴───────────┬──────────────────┐
  │        ↓ 15 分钟内支付         ↓ 超时没付          ↓ 用户取消
  │   支付回调到 ──→ settle 259   releaseExpired    release
  │   实扣 + 记收入  │             自动解押           手动解押
  │                 ↓
  │             交易完成
```

跟着账本数字走一遍（先充值 300）：

| 步骤 | 动作 | 余额 | 在途 | 还能花 | 平台收入 |
|---|---|---|---|---|---|
| 充值 | credit 300 | **300** | 0 | 300 | — |
| 下单 | authorize 259 | 300 | **259** | 41 | — |
| 支付成功 | settle 259 | **41** | 0 | 41 | **+259** |
| *改价只付 249* | *settle 249* | *51* | *0* | *51* | *+249（差额 10 自动归还）* |
| *用户取消* | *release* | *300* | *0* | *300* | *0（分文未动）* |

### 流程 2：AI 按量计费（预估多押、实际少扣）

```
 用户发请求「最多花 0.8 元」
  │
  ├─→ authorize 0.8（按最大 token 敞口押）──→ 在途 +0.8
  │
  ├── 调上游成功，实际用量 0.23
  │      └─→ settle 0.23 ──→ 余额 −0.23，差额 0.57 自动归还，收入 +0.23
  │
  └── 上游失败
         └─→ release ──→ 全额归还，一分不扣
```

### 流程 3：充值与退款（原路退回）

```
充值：支付宝回调 ──→ credit 99   [用户 +99] [外部 −99]   回调重放 100 次也只入一次账
退款：渠道退款   ──→ refund 59   [用户 −59] [外部 +59]   钱离开钱包回到渠道
                                     ↑ 退款不能把余额打到低于 −授信（守卫）
```

### 流程 4：电商分账（平台抽佣）——内部科目的价值

买家付 90，平台抽佣 10，商家得 80：

```
   买家账户            平台收入(platform_revenue)        商家账户
  ┌────────┐          ┌────────────────┐              ┌────────┐
  │ settle │  −90 ──→ │     +90        │              │   0    │
  └────────┘          │  transfer 80   │ ──→ +80 ──→ │  +80   │
                      │     剩 10      │   (原子一次)  └────────┘
                      └────────────────┘
                        ↑ 剩下的 10 就是平台佣金——账本直接读出来
```

`transfer` 是原子操作：转出方减多少，转入方就加多少，**不会出现一边扣了另一边没到**。

### 流程 5：后付费 SaaS（授信）

```
 开通：setCreditLimit 50        能花的钱 = 余额 10 + 授信 50 = 60
   │
   ├─→ 消费 …余额到 −25          没击穿地板（−50），允许
   │
   └─→ 月底充值 credit 50        余额回到 +25，一切照常

 收回授信：setCreditLimit 0     新额度不能低于当前欠款（否则拒绝）
```

### 流程 6：超时自动释放（worker 兜底）

```
authorize 时带上 expiresAt（如 15 分钟后）
   │
   └─→ worker 每隔一段时间：releaseExpired()
          └─→ 到点的冻结单自动转 expired、解押在途

 为什么需要：用户关掉页面、系统崩溃——没人来 settle/release，
 冻结也不能永远吊着占用户的钱。
```

### 流程 7：风控冻结

```
 发现异常 ──→ freeze ──→ 该账户一切资金变动被拒（充值/消费/退款/转账全拦）
   │                        查余额不受限
   └─→ 人工核查完毕 ──→ unfreeze ──→ 恢复
```

## 四、上层的全部工作 = 三个填空题

不管什么业务，接入钱包只需要回答：

1. **押多少**（下单时冻结的金额怎么算——订单价 / token 敞口 / 周期价）
2. **扣多少**（结算时实际金额——支付实付 / 真实用量 / 账单）
3. **叫什么**（幂等键 refType/refId——用订单号、支付单号等天然唯一的编号）

防双扣、防重放、超时、并发、账目恒等、串号防御——全部由钱包继承，上层写不坏。

---

## 五、API 速查

```ts
import { createWallet, provision } from '@ai-gateway/wallet';
const wallet = createWallet(db);
await provision(db);

await wallet.credit({ userId, amount: '99.00', refType: 'topup', refId: tradeNo });            // 充值
await wallet.authorize({ userId, amount: '259', refType: 'order', refId: orderId, expiresAt });// 冻结
await wallet.settle({ refType: 'order', refId: orderId, amount: '249' });                      // 实扣(可少于冻结)
await wallet.release({ refType: 'order', refId: orderId, reason: 'user_cancel' });             // 解押
await wallet.refund({ userId, amount: '59', refType: 'topup_refund', refId: tradeNo });        // 退款
await wallet.transfer({ from: { code: 'platform_revenue' }, to: { userId: merchantId },
  amount: '80', refType: 'payout', refId: settlementId });                                     // 分账/P2P
await wallet.credit({ userId, currency: 'USD', amount: '14.99', refType: 'topup', refId: id });// 多币种(缺省CNY)
await wallet.setCreditLimit({ userId, amount: '50', refType: 'credit_line', refId: grantId }); // 授信
await wallet.freeze({ target: { userId }, frozen: true, refType: 'risk_control', refId });     // 风控冻结
const summaries = await wallet.accounts(userId);                                               // 账户摘要
await wallet.releaseExpired(new Date(), 100);                                                  // 超时扫描(worker)
```

## 六、不变量（钱包的安全承诺）

- 每笔交易 Σ 腿 = 0（有借必有贷）；每账户腿链恒等且连续；余额 = 腿的代数和
- 每笔冻结必达终态，settle 与 release 经数据库原子迁移互斥（并发恰好一次）
- 用户余额 ≥ −授信；settle ≤ 冻结额；同一业务键同一动作至多一笔交易（回调重放安全）
- 冻结账户拒绝一切资金变动

以上全部有 DB 约束兜底 + 32 组测试机械化验收（含全账本对账器）。

## 七、设计边界

1. **多币种**：一币一账互不净额；跨币换汇 = 两笔独立转账（汇率是业务策略）
2. **授信地板**：覆盖「先花后充、封顶欠款」；真账期（发票/催收）是单据系统不属钱包
3. **一个冻结单次结算**：分次扣款 = 多次独立 authorize（installment 维度已设计、挂起）
4. **幂等键全局唯一**：不含用户/币种维度；顶撞抛 `RefKeyConflictError`（键设计责任在调用方）
5. **守卫前重放**：transfer/refund/authorize 先查重放再过余额守卫——首笔花掉余额后重放不被误伤

## 八、表结构（本包私有四表）

| 表 | 职责 |
|---|---|
| `wallet_accounts` | 账户（user 用户 / internal 科目），余额/在途/授信/冻结状态 |
| `wallet_transactions` | 交易批头（幂等键 ref_type+ref_id+kind） |
| `wallet_legs` | 腿（Σ=0 的那条"一进一出"，每腿链式恒等） |
| `wallet_authorizations` | 冻结单状态机（active→settled/released/expired） |

测试 beforeAll 建 / afterAll 删 + 全账本对账，不碰业务表。

## 九、测试

32 组契约测试打真 PG：`pnpm --filter @ai-gateway/wallet test`。
覆盖复式守恒与对账、科目累积、两阶段全场景、并发竞态（双结算/双入账恰好一次）、
授信地板、多币种隔离、transfer 全家（分账/同账户/跨币/守卫/重放）、freeze、1e-18 精度。
