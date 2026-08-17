# @ai-gateway/ledger-core — 通用幂等资金操作内核

业务无关的操作编排层：**operationId 幂等键 + canonical 参数指纹 + 回执重放**。
与 `@ai-gateway/wallet` 分工明确——wallet 是钱的真相（账户/流水/冻结），本包是
「业务操作」的真相：回调重放、重试风暴、崩溃恢复下，同一操作**至多一次已提交的执行**，
首次回执原样归还（结构一致；jsonb 不保键序）。

## 一句话心智模型

> **wallet 记「钱动了多少」，ledger-core 记「这件事做没做过」。**
> 支付回调重放第三次到达时：wallet 需要知道「这笔入账早已发生」——这个事实的
> 载体就是本包的操作档案：`(operationId, fingerprint) → receipt`。

旧 `@ai-gateway/ledger` 的 `fund_operations` 模式（同一段 40 行幂等样板重复 10 次）
在此收敛为一个动词。旧包零改动，gateway 未接线。

## 快速开始

```ts
import { createLedger, provision } from '@ai-gateway/ledger-core';

await provision(db); // 一次性建表（幂等）；或 provisionSql() 收进你的迁移管线

const ledger = createLedger(db, {
  kinds: ['payment.credit', 'order.place', 'order.settle', 'order.cancel'], // 必填白名单
  effects: {
    committed: async (e) => invalidateBalanceCache(e), // 提交后触发（含重放，replayed 区分）
    audit: async (e) => auditLog.write(e),             // 尽力而为
  },
});
```

## 3 个动词（一动词一事）

```
run        幂等执行：首执行 → INSERT 占位 → execute(tx) → 回执落档（同一事务）
           重放 → INSERT 0 行 → 读回核对指纹 → 原回执归还（execute 不再执行）
           冲突 → 指纹/类型与存档不符 → OperationConflictError（串号事故的闸）
operation  单条查询（管理端/对账）
operations 游标分页（id 倒序，kind 过滤）——管理端操作流水读侧
```

## 使用示例

### 例 1 · 支付回调（与 wallet 组合——回调重放只入账一次）

```ts
const result = await ledger.run({
  operationId: `payment.credit:epay:${providerOrderId}`, // 幂等键：支付域自然键
  kind: 'payment.credit',
  fingerprint: { userId, creditAmount },  // 参与指纹的业务参数（金额用字符串！）
  execute: async (tx) => {
    await markOrderCredited(tx, paymentOrderId);        // 你的订单状态机
    const w = await wallet.credit({                     // 钱动作——tx 注入同一事务
      tx, userId, amount: creditAmount,
      refType: 'topup', refId: providerOrderId,
    });
    return { transactionId: w.transactionId, balanceAfter: w.balanceAfter }; // 回执
  },
});
// 回调第三次重放到达：result.replayed === true，execute 未执行，回执与首档结构一致
```

### 例 2 · 电商三步（同一内核三种 kind）

```ts
await ledger.run({ // 下单：订单行 + 冻结
  operationId: `order.place:${orderId}`, kind: 'order.place',
  fingerprint: { orderId, total },
  execute: async (tx) => {
    await insertOrder(tx, orderId, total);
    await wallet.authorize({ tx, userId, amount: total, refType: 'order', refId: orderId, expiresAt });
    return { orderId };
  },
});
await ledger.run({ // 支付成功：实扣（可少于冻结额，余量自动归还）
  operationId: `order.settle:${orderId}`, kind: 'order.settle',
  fingerprint: { orderId, actual },
  execute: async (tx) => {
    await markOrderPaid(tx, orderId);
    await wallet.settle({ tx, refType: 'order', refId: orderId, amount: actual });
    return { orderId, actual };
  },
});
// 取消走 order.cancel + wallet.release，同构
```

### 例 3 · 纯业务幂等（不碰钱的操作同样需要「至多一次+回执」）

```ts
await ledger.run({
  operationId: `subscription.cancel:${subscriptionId}`,
  kind: 'subscription.cancel',
  fingerprint: { subscriptionId },
  execute: async (tx) => {
    const row = await expireSubscription(tx, subscriptionId);
    return { endAt: row.endAt.toISOString() };
  },
});
```

## 核心流程图

### 流程 1：run 三态判定（每一条 run 的完整决策路径）

```
 run({ operationId, kind, fingerprint, execute })
   │
   ├─ 守卫（先于任何写）：kind ∈ 白名单？operationId 形状？fingerprint 可 canonical？
   │      └─ 否 → 拒绝，execute 零调用（fail-closed，库零痕迹）
   │
   └─→ 事务开始
        ├─ INSERT ledger_operations (operationId, fingerprint) ON CONFLICT DO NOTHING
        │
        ├─ 插入成功（首个到达者）
        │      └─→ execute(tx)
        │            ├─ 业务状态机写 + wallet 动词（同事务）
        │            ├─ 抛错？→ 整体回滚：档案随业务写一起消失（=「没做过」）
        │            ↓
        │         回执校验（≤16KB 纯对象）→ receipt 落档 → 提交
        │            └─ 提交后：effects.committed(replayed: false)
        │
        └─ 插入 0 行（键已存在）→ 读回存档核对
               ├─ kind 不符   → OperationConflictError (kind_mismatch)
               ├─ 指纹不符    → OperationConflictError (fingerprint_mismatch) ← 串号事故的闸
               └─ 完全一致    → 返回存档 receipt，replayed: true（execute 不执行）
                                └─ 提交后：effects.committed(replayed: true)
```

### 流程 2：支付回调全链路（与 wallet 组合，回调重放只入账一次）

```
 支付网关          ledger-core                     wallet               DB 事务边界
    │                 │                             │                      │
    ├─ 回调 #1 ─────→ run('payment.credit:epay:9527')                      │
    │                 ├─ INSERT 档案占位 ─────────────────────────────────→ │ ┐
    │                 ├─ execute(tx)：                                   │ │
    │                 │    ├─ 订单 created → credited ──────────────────→ │ │ 同一事务
    │                 │    └─ wallet.credit(tx, 100.00) ──→ 入账 100 ───→ │ │
    │                 ├─ receipt 落档 {transactionId, balanceAfter} ────→ │ ┘
    │                 └─ 提交 → effects.committed(replayed: false)        │
    │ ←── 200 ────────┤                                                   │
    │                 │                                                   │
    ├─ 回调 #2 重放 → run（同 operationId、同 fingerprint）                │
    │                 ├─ INSERT 0 行 → 读回核对一致                        │
    │                 └─ 返回存档回执 replayed: true（execute 未执行，钱包零变动）
    │ ←── 200 ────────┤                                                   │
    │                 │                                                   │
    ├─ 回调 #3 篡改 → run（同键，amount 改 1000）── 指纹漂移                │
    │                 └─ OperationConflictError（409）                     │
    │                     ——绝不把 100 元的存档回执当 1000 元的结果归还     │
```

跟着档案与账走一遍（充值 100）：

| 到达 | fingerprint | execute | 档案 | 钱包余额 | 结果 |
| --- | --- | --- | --- | --- | --- |
| 回调 #1 | `{userId, '100.00'}` | 执行 1 次 | 建立+回执落档 | **+100.00** | `replayed: false` |
| 回调 #2 网关重发 | 同 #1 | 不执行 | 读回原回执 | 不变 | `replayed: true` |
| 回调 #3 金额篡改 | `{userId, '1000.00'}` | 不执行 | 不动 | 不变 | **409 冲突** |
| #1 执行中途宕机后重试 | 同 #1 | 回滚→接棒 1 次 | 重建 | +100.00（恰一次） | `replayed: false` |

### 流程 3：并发同键——唯一索引定序（无锁设计的正确性来源）

```
 事务 A                                 事务 B（同时开始）
    │                                      │
    ├─ INSERT 档案 ✓（占住唯一键）           ├─ INSERT 档案 ……阻塞……
    ├─ execute：订单状态机 + 入账            │   （等在唯一索引上，不轮询、无超时竞态）
    └─ COMMIT ─────────────────────────────→ B 的 INSERT 惊醒：撞键 → 0 行
                                           ├─ 读回 A 的存档，指纹一致
                                           └─ 返回 A 的回执，replayed: true
                                               ——不存在读到 A 半成品数据的窗口

 事务 A 中途失败时：
    ├─ INSERT ✓ → execute 抛错 → ROLLBACK（档案与业务写一起消失）
    └─ B 的 INSERT 惊醒：键位空出 → 插入成功 → B 接棒 execute
        ——「回滚 = 没做过」，下一个到达者顶上
```

### 流程 4：电商三步——ledger-core 记事、wallet 记钱

```
 下单 ──→ run(order.place:X)   ── execute：建订单    + wallet.authorize 259（押住，余额没动）
 支付 ──→ run(order.settle:X)  ── execute：订单已付  + wallet.settle 249（实扣，差额 10 自动归还）
 取消 ──→ run(order.cancel:X)  ── execute：订单关闭  + wallet.release（全退，分文未动）
              │
              └─ 三个 operationId 互不相同——「同一订单的三件事」各自幂等、互不顶替；
                 每件事的重试/重放都只会落到自己的档案上
```

## 数据模型（单表，本包私有）

```
ledger_operations
  id             bigserial PK
  operation_id   varchar(128) UNIQUE   -- 幂等键（调用方设计责任，全局唯一）
  kind           varchar(32)            -- 白名单词表
  fingerprint    varchar(64)            -- canonical JSON 的 SHA-256
  receipt        jsonb                  -- 首次执行回执（重放的归还物；append-only）
  created_at / updated_at
```

操作行与业务写在**同一事务**：要么同生（执行完成且回执落档）要么同死（execute 抛错整体回滚）——
「提交了但没有回执」的中间态在结构上不存在。

## 并发语义（无锁设计的正确性来源）

两个同键 run 并发：后到者的 INSERT **阻塞在唯一索引上**直到先到者事务终结——
提交则读回重放，回滚则接棒执行。单语句定序，不存在「读到未提交半成品」的窗口。
不同操作的业务写以不同顺序触碰同一批行时可能死锁——`runTx` 重试壳（40P01/40001，
5 次指数退避）吸收；重试后要么接棒执行要么重放，语义不变。

## 防错故事（为什么长这样）

- **回调重放双入账** → `(operationId)` 全局唯一：同键第二个 INSERT 撞索引，读回重放
- **同键不同参顶替**（攻击者改金额重放回调）→ `fingerprint` 比对：参数漂移即 `OperationConflictError`，
  绝不把别人的回执当自己的结果
- **JSON 键序导致指纹漂移**（`{a,b}` vs `{b,a}` 误判冲突）→ canonical 序列化：键序递归排序，
  与调用方构造顺序无关
- **`undefined` 静默变 `null`**（`JSON.stringify` 吞值 → 不同输入同指纹）→ 非 JSON 安全值
  （undefined/NaN/Date/类实例/Symbol）一律显式拒绝
- **万层嵌套炸调用栈** → 深度上限 64、canonical 总长上限 1MB
- **execute 半途崩溃** → 操作行随事务回滚，重试接棒执行——没有「执行了但没档案」的脏状态
- **投递/缓存失效失败拖垮资金事务** → effects 全部提交后触发，失败吞掉（committed 带 replayed 区分）

## 设计边界（消费方须知，刻意为之）

- **不碰钱**：金额/入账/冻结是 wallet 的领域；本包只保证「操作至多一次+回执」
- **回执不是业务表**：≤16KB 纯对象；订阅期等富业务事实写你自己的表，回执只放「归还给重放者」的摘要
- **金额以字符串进指纹**：`'1.00'` ≠ `'1.0'`（字符串不相等即指纹不同）——调用方负责金额规范化
- **操作档案 append-only**：重放与冲突都不改写存档；生产不删（审计物）
- **kinds 白名单必填非空**（fail-closed）：词表外 kind 在任何写之前拒绝，execute 零调用
- **operationId 全局唯一是调用方的设计责任**：推荐 `domain.subject:业务键` 风格（含用户/订单隔离维度）

## 测试（42 例 / 7 文件，全部打真 PG）

独立 schema 建删（globalSetup）、文件级串行、每文件池 max 3。覆盖：
canonical 指纹（键序/类型区分/循环/深度/洪水）· 白名单与 operationId 守卫 ·
生命周期（首执行/重放/指纹漂移/回滚接棒/tx 注入/嵌套写回滚/回执约束/效应语义）·
并发（6 路同键恰一次已提交执行、互异指纹全冲突、慢执行无半成品读、回滚后接棒、
死锁重试壳）· 读侧（分页无重叠不遗漏/游标校验）· 错误契约（5 类 code 唯一）·
安全专项（守卫先于任何写/语义相近输入不顶替/深构造不爆栈/append-only）。
