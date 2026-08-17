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

## 八、数据模型：四张表逐字段讲清

### 表间总览（ER）

```
                ┌───────────────────────────┐
                │      wallet_accounts      │  账户：钱的「家」
                │  用户账户 + 内部科目账户     │
                └──────┬───────────┬────────┘
              1:N ↑    │           │    ↑ 1:N
      （押了谁的钱）    │           │    （哪条腿动了这个账户）
        ┌─────────────┴──┐   ┌────┴──────────────┐
        │ wallet_        │   │    wallet_legs    │  腿：一进一出的每一边
        │ authorizations │   │  每腿带前后余额链   │
        │ （冻结单）       │   └────┬──────────────┘
        └────────────────┘        │ N:1
                            ┌─────┴─────────────────┐
                            │ wallet_transactions   │  批头：幂等键
                            └───────────────────────┘
```

四条关系（三条外键 + 一条逻辑关联）：

| 关系 | 类型 | 说明 |
|---|---|---|
| `legs.transaction_id → transactions.id` | FK | 一笔交易 ≥2 条腿（credit_line/freeze 零额审计单腿） |
| `legs.account_id → accounts.id` | FK | 每条腿记在且仅记在一个账户上 |
| `authorizations.account_id → accounts.id` | FK | 冻结单押的是哪个账户（在途记在该账户上） |
| `authorizations ↔ transactions` | **逻辑关联**（同业务键） | 无外键：authorize 建冻结单、settle 按**同一个** `(ref_type, ref_id)` 落交易——两表靠业务键对上，这也是 settle 寻址冻结单的方式 |

### wallet_accounts —— 账户表（钱的「家」）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | 账户全局标识；腿和冻结单都引用它 |
| `kind` | `user`/`internal` | 用户账户 或 内部科目（二选一，与下两列互斥校验） |
| `user_id` | bigint，可空 | `kind=user` 时必填：业务侧用户 ID |
| `code` | varchar(64)，可空 | `kind=internal` 时必填：科目代码（`outside`/`platform_revenue`/自定义） |
| `currency` | varchar(3) | 币种（缺省 CNY）。**一币一账**：唯一键 `(user_id, currency)` / `(code, currency)` |
| `balance` | numeric(38,18) | 余额。用户账户 ≥ −credit_limit；内部科目按语义可负（outside 镜像恒负） |
| `in_flight` | numeric(38,18) | 在途：本账户所有 **active** 冻结单押住的总额 |
| `credit_limit` | numeric(38,18) | 授信地板（仅约束用户账户；0 = 纯预付不许欠款） |
| `status` | `active`/`frozen` | 风控冻结：frozen 拒绝一切资金变动（查余额不受限） |
| `updated_at` | timestamptz | 最后变动时间 |

业务逻辑：**用户账户的可用额度 = balance + credit_limit − in_flight**（ authorize 的守卫就用它）；DB 层三条 check 兜底：身份互斥（kind 与 user_id/code 匹配）、非负（in_flight、credit_limit）、地板（`kind='internal' or balance >= -credit_limit`——内部科目豁免地板，守恒由 Σ腿=0 保证）。

### wallet_transactions —— 交易批头（「谁做了什么」）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | bigserial PK | 交易号（单调递增，天然时间序） |
| `kind` | 词表 | `credit`/`settle`/`refund`/`transfer`/`credit_line`/`freeze` |
| `ref_type` | varchar(32) | 业务域（order/topup/inference…，snake_case） |
| `ref_id` | varchar(128) | 业务单号——**与 ref_type 组成幂等键** |
| `memo` | varchar(255) | 备注（≤255，入口校验） |
| `credit_limit_after` | numeric，可空 | 仅 `credit_line` 行填：本笔生效后的授信额（重放读回依据） |
| `created_at` | timestamptz | |

业务逻辑：**这张表不存金额**——金额在腿上。批头只回答「哪个业务键做了哪种动作」，唯一索引 `(ref_type, ref_id, kind)` 即幂等承诺：同一业务键同一动作全系统至多一笔（回调重放/并发/重试全部被它拦下）。注意幂等键**不含币种和用户**——键即业务身份，顶撞立即报错。

### wallet_legs —— 腿（复式的核心）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | bigserial PK | 腿号；同账户按 id 排序 = 该账户完整余额历史 |
| `transaction_id` | bigint FK | 所属交易 |
| `account_id` | uuid FK | 记在哪本账上 |
| `currency` | varchar(3) | 冗余币种（审计维度，随交易落） |
| `amount` | numeric(38,18) | **有符号**：正=入（贷），负=出（借） |
| `balance_before` | numeric(38,18) | 本腿落账前余额 |
| `balance_after` | numeric(38,18) | 本腿落账后余额 |

业务逻辑：两条铁律——① **同交易各腿合计恒为 0**（有借必有贷，钱不凭空生灭；credit_line/freeze 的零额审计单腿 amount=0 平凡成立）；② **每腿 `after = before + amount`**（DB check）。推论：任一账户按腿序折叠即可复算任意时点余额，任一交易的腿一眼看出钱的来处与去处。

### wallet_authorizations —— 冻结单（押注状态机）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | uuid PK | 冻结单号 |
| `account_id` | uuid FK | 押的哪个账户（在途累计在该账户） |
| `ref_type` / `ref_id` | varchar | 业务键（唯一——同键至多一张冻结单） |
| `amount` | numeric | 押注金额（>0） |
| `status` | 词表 | `active` → `settled` / `released` / `expired` |
| `settled_amount` | numeric，可空 | 实扣额（≤amount；与 amount 之差即结算时自动归还的余量） |
| `release_reason` | varchar(64)，可空 | released/expired 的原因（user_cancel/expired…审计在此，不落交易） |
| `expires_at` | timestamptz，可空 | 超时权威时间：到点由 releaseExpired 扫描转 expired |
| `created_at` / `updated_at` | timestamptz | |

业务逻辑：**CAS 互斥终态迁移**（`UPDATE ... WHERE status='active'`，并发恰好一方成功）；settled 与 released/expired 互斥不可逆；押注不动余额（不产生交易/腿），只加 in_flight；每张单必达终态（业务方 settle/release 或超时扫描兜底）。

### 一笔交易落库实例：`credit 99`（用户张三首次充值）

```
wallet_accounts 新增 2 行：
  (id=A, kind=user,    user_id=张三, CNY, balance=99,  in_flight=0)
  (id=B, kind=internal, code='outside', CNY, balance=-99)   ← 外部镜像

wallet_transactions 新增 1 行：
  (id=1, kind='credit', ref_type='topup', ref_id='支付宝单号xxx')

wallet_legs 新增 2 行（合计 = 99 + (−99) = 0 ✓）：
  (transaction_id=1, account_id=A, amount=+99, before=0,   after=99)
  (transaction_id=1, account_id=B, amount=−99, before=0,   after=−99)
```

后续 `settle 30`（同一订单键）：authorizations 那张 active 单 CAS 成 settled(30)、账户 A 在途 −amount；transactions 落 `kind='settle'` 批头；legs 两条：A −30、platform_revenue +30。**释放则一张单据都不落**——只在冻结单上改状态。

## 九、测试

32 组契约测试打真 PG：`pnpm --filter @ai-gateway/wallet test`。
覆盖复式守恒与对账、科目累积、两阶段全场景、并发竞态（双结算/双入账恰好一次）、
授信地板、多币种隔离、transfer 全家（分账/同账户/跨币/守卫/重放）、freeze、1e-18 精度。
