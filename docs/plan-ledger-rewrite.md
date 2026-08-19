# 计划:ledger 解体重写——wallet 单一资金事实源

> 状态:**已完成(2026-08-18,S1–S9 全部落地并四门全绿)**。
> 取代 plan-kernel-consolidation.md 的 P4/P5。
> 前置:P1(metering)/P2(identity)/P3(ledger-core 幂等)已完成并全量回归通过。
> 终局:wallet 为唯一资金事实源——users.balance/reserved_balance/credit_limit
> 已 DROP(迁移 0058),fund_operations 已 DROP,旧 transactions 表封存待报表需求;
> 全仓生产代码零余额/在途/流水直写。

## 1. 硬规则(一切设计的前提)

> **wallet 是唯一资金事实源。任何领域不得直接读写余额、在途、资金流水。**

当前存在两套资金模型,这是比「ledger.ts 太长」严重得多的根因——只要两套并存,
组件化重构只会继续混乱,因为「余额/在途/流水以谁为准」没有唯一答案:

```
ledger 旧模型(退役)              wallet(唯一真相)
users.balance                     wallet_accounts
users.reserved_balance            wallet_authorizations
users.credit_limit                (credit_limit 列 + credit_line 动词)
transactions                      wallet_transactions + wallet_legs
```

重写完成后,全仓生产代码不得再出现对 users.balance / users.reserved_balance /
旧 transactions 的直接读写;`reconcileUser()`(余额↔流水等式)删除——资金一致性
由 wallet 复式账本 + maintenance.verifyInvariants 负责。

## 2. 领域划分(单包多文件:域是目录,不是分包)

**物理结构 = 一个包 `@ai-gateway/ledger` 原地重写**,域边界 = 目录边界 + 单向
import 铁律;不新立五个包,避免分包带来的依赖声明/版本/出口治理开销。

```
packages/ledger/src/
├─ platform/          errors 单一家谱(code 全局唯一)/ effects 类型化域事件 / HTTP 映射
├─ rating/            报价、费率卡系数、最坏费用、实际费用、收据校验(纯函数为主)
├─ subscription/      套餐购买/续费/升档折算/席位/组织/加油包/取消/额度预留与消费
├─ channel-budget/    渠道采购额度、上游敞口、实际渠道成本、熔断
├─ billing/           billing_requests 状态机与闸门管线(编排,不做钱/额度动作)
├─ settlement/        worker 编排:认领/租约/重试/恢复/dead 复核入口
└─ index.ts           每域一个子导出出口
```

**域职责表**:

| 域(目录) | 负责内容 | 状态 |
|---|---|---|
| `wallet`(外部内核,已存在) | 全部真实资金:入/退/冻/结/转/授信/冻结风控/账户/流水/对账不变量;内核哲学不变,仅加 §3 三条增量 | §3 ✅ |
| `rating/` | 报价、费率卡系数、候选链最坏费用、实际费用计算、收据校验 | ✅ S2 |
| `subscription/` | 套餐购买/续费/升档折算/席位/组织归属/加油包/取消/额度消费与预留;资金动作全部委托 wallet | |
| `billing/` | billing_requests 状态机、计费来源选择、限额政策、闸门管线;**只编排,钱与额度分别委托 wallet 与 subscription** | |
| `channel-budget/` | 渠道采购额度、上游敞口预留/释放、实际渠道成本、熔断;运营资金域,自治(见 §7) | |
| `settlement/` | BullMQ worker、认领/租约/失败重试/滞留恢复/dead 复核入口;纯编排,不含领域判定 | |

**包内依赖铁律(单向,环为零)**:

```
settlement → billing → { subscription, rating, channel-budget } → { wallet, ledger-core }
platform 被所有域引用;任何域不得 import settlement;任何域不得反向依赖 apps。
```

出口策略:每域一个子导出(`@ai-gateway/ledger/billing` 等,repo 已有 subpath 惯例),
根 index 只放装配工厂——杜绝旧版 `export *` 倾倒场。后续可用 oxlint
no-restricted-imports 把铁律固化为 lint 规则。

**旧根文件退役**:ledger.ts(神文件)、error-catalog.ts、billing/types.ts(倾倒场)
等按域拆解后删除;`ledger` 包名保留(业务侧账本域,与资金内核 wallet 相对)。

**薄编排归 app**(单 app 使用、无复用价值):
- `paymentCredit/paymentRefund` → client-api 的支付域(epay 回调状态机)+ wallet.credit/refund
- `redeemCode` → client-api 兑换码服务(码状态机)+ wallet.credit
- `grantSignupGift` / `grantPromotionalCredit` → 注册/邀请流程内的应用服务 + wallet.credit
- `adminGift/adminAdjust` → admin-api 服务 + wallet(见 §3.3)
- `getBalance` / 流水查询 → apps 直调 `wallet.balance` / `wallet.statement`

## 3. wallet 内核增量(小而必要,三条)

### 3.1 tx 注入(对齐 ledger-core/identity-core 既有设计) ✅

现状:wallet 动词各自开事务,无 tx 参数。**业务组合无法原子化**——订阅购买要求
「业务行 + 扣款」同生共死,补充授权结算要求「授权+结算」同事务(§4 差异一)。
ledger 今天之所以自己写钱,正是因为它要在一个事务里做完所有事。

改法:全部写动词(credit/authorize/settle/release/refund/transfer/setCreditLimit/
freeze)入参增加可选 `tx`(缺省自开事务),与 ledger-core.run({tx})、
identity-core.registerCredential({tx}) 同款。内核不变量零妥协——锁与校验随 tx 走。

落地要点(实测验证):
- `runTx` 把 db 类型放宽为 `DbLike` 即天然成立——注入的事务句柄上调 `.transaction()`
  是 SAVEPOINT(drizzle 嵌套事务),唯一冲突只回滚到 savepoint 再走重放读回,
  **注入与否并发同键语义完全一致**;瞬态死锁重试同样安全。
- 动词内所有读写(幂等快速路径 + 冲突兜底重放)统一走 `input.tx ?? db`——
  注入时能读到调用方未提交的前序变动。
- `tx` 不参与命令指纹(连接句柄非业务数据)。
- 测试:tx-injection.test.ts 7 例(含 §4 补充授权结算三步原子 + 中途回滚组合)。

### 3.2 `allowCredit` 策略参数(契约差异二的解法) ✅

现状:wallet 的 authorize/transfer 可用额守卫恒为 `balance + credit_limit − in_flight ≥ amount`
(含授信);而订阅域要求**现金口径** `balance − in_flight ≥ amount`(禁透支购套餐,
现状 ledger 三处手写此守卫)。

改法:`authorize/transfer` 增加可选 `allowCredit?: boolean`(缺省 true)。
`false` 时锁内守卫改为现金口径。**策略判定留在内核锁内**——调用方预读余额再
自行判断是被否决的方案(TOCTOU 竞态)。

落地要点(实测验证):
- `assertCanDebit(account, amount, userId, { allowCredit })` 与 transfer 的
  `buildTransferPosting(..., allowCredit)` 双落点;拒绝抛 `InsufficientCashError`
  (code `insufficient_cash`,与 insufficient_balance 可分流——订阅 UX 需要区分
  「没钱」与「有授信但本单限现金」)。
- 指纹零漂移:`allowCredit` 仅在显式 `false` 时进指纹载荷(undefined 会被
  canonicalize 过滤)——缺省调用与存量指纹字节一致,部署不产生重试冲突。
- 测试:allow-credit.test.ts 6 例(缺省口径回归护栏 + 现金口径/在途扣减/
  transfer 同口径/指纹冲突)。

### 3.3 负向调账 = transfer 到 outside(不新增 adjustment 动词)

正向调账/发放 = `wallet.credit`(counter-leg 天然是 outside 镜像);
负向调账 = `wallet.transfer(user → outside, refType 'admin_adjust', allowCredit: true)`
(可用额守卫天然保住信用地板)。复式两端齐全,不引入第三种余额变更动词。

## 4. 三个契约差异的落地

### 差异一:实际扣费可能超过预估预留(AI 计费特性)

billing 允许 `实际 > 预留`,只要不跌破信用地板;wallet 严格 `settle ≤ hold`
(SettleExceedsHoldError)——**wallet 契约不动**。解法(同事务补充授权模式):

```
settle 时 actual > hold(记 delta = actual − hold):
  同一事务内:
    1. wallet.authorize({ refType:'billing', refId:`${requestId}#over`, amount: delta, tx })
    2. wallet.settle({ refType:'billing', refId:`${requestId}#over`, amount: delta, tx })
    3. wallet.settle({ refType:'billing', refId: requestId, amount: hold, tx })
  前置守卫:补充授权的可用额判定(含授信)不通过 → 整体拒绝(等价旧地板行为)
statement 呈现两笔结算(原预留 + 补充),复式守恒,审计可追。
```

幂等:两个 refId 都落在 wallet 唯一索引下;billing 侧 settle 幂等键不变(ledger-core)。

### 差异二:订阅购买禁用授信

见 §3.2 `allowCredit: false`。适用动词:subscription 域全部资金动作
(purchase/renew/change 补差价/grantPack)。PAYG 计费授权用缺省(允许授信)。

### 差异三(实现侧新增):业务-资金原子性

见 §3.1。没有 tx 注入,差异一的「同事务」与订阅购买都不成立。

## 5. subscription 域详拆(src/subscription/)

表归属:plans / user_subscriptions / org 相关表留在 db 包(业务表);
资金动作全部走 wallet(transfer,allowCredit:false);幂等走 ledger-core。

```
src/subscription/
├─ period.ts          纯函数:订阅窗口顺延(到期后续费从 now 起,未到期从旧 end 起)
├─ proration.ts       纯函数:剩余价值 = 总价 × 剩余额度/总额度;补差价 = max(0, 新总价−剩余价值)
├─ eligibility.ts     纯函数:升档不降级判定(sortOrder/席位)、企业席位门槛
├─ purchase.ts        动词:锁订阅行(FOR UPDATE)→ transfer(cash-only) → 新订阅行 + 凭证改绑 + org 复用/创建(同 tx)
├─ renew.ts           动词:继承(席位/org/顺延)+ 同 purchase 资金路径
├─ change.ts          动词:proration → transfer(diff, cash-only) → 新订阅行 + 凭证改绑
├─ cancel.ts          动词:CAS 状态迁移(不涉钱)
├─ pack.ts            动词:transfer(cash-only) + 订阅额度累加(失效订阅竞态守卫)
├─ quota.ts           动词:额度预留/结算/释放(billing 的订阅路径调用;reserved/used 列的业务不变量在此)
└─ index.ts           域出口:装配 + 类型
```

原则:每动词一文件;纯函数(折算/窗口/资格)独立可测;**订阅域不含任何余额读写**。

## 6. billing 域详拆(src/billing/)

billing_requests 保留 8 态业务状态机(authorized/in_flight/settlement_pending/
processing/retry_wait/settled/released/dead),**不再持有钱的投影**;与 wallet
冻结单两层状态机各自 CAS、业务键对齐(`refType='billing', refId=requestId`);
冻结单不设 expiresAt(生命周期由 billing 自己的恢复/放弃路径显式 wallet.release,
避免双超时系统打架)。

```
src/billing/
├─ state.ts           8 态迁移纯函数(非法迁移结构性拒绝)
├─ gates/
│  ├─ admission.ts    结算积压准入闸
│  ├─ daily-limit.ts  每日花费限额
│  └─ source.ts       计费来源选择(payg vs subscription;成员配额闸)
├─ authorize/         管线:闸门→rating.quote→锁→money: wallet.authorize(no expiry)/
│                     quota: subscription.quotaReserve → INSERT billing_requests
├─ signal/            四事件:upstream_started / lease_renewed / request_succeeded(receipt 校验→rating) /
│                     request_failed(双路释放:wallet.release + quotaRelease)
├─ settle/            结算编排:金额(rating.computeAmounts)→ PAYG:wallet.settle(+§4 补充授权模式)/
│                     订阅:subscription.quotaSettle → 渠道敞口收尾(channel-budget.closeout)→ CAS 终态
├─ release.ts         双路释放唯一实现
├─ dead.ts            死单人工复核/放弃(现 billing/operations)
└─ index.ts           域出口:装配 createBilling({db, wallet, subscription, rating, channelBudget})
```

## 7. channel-budget 域(src/channel-budget/,运营资金域,自治)

渠道采购预算是**公司运营资金**,与用户资金永不混账;熔断是运营语义不是资金不变量。
决策:**不进 wallet**,channels.upstream_budget + channel_recharges 留业务表,
域内自带守卫(预算非负、敞口 ≤ 预算、熔断阈值)。若未来要进总账,用
`platform_revenue → channel_cost` 的 wallet.transfer 结转(预留此路,不在本期)。

```
src/channel-budget/
├─ recharge.ts   管理端进货/调账(幂等:ledger-core kinds 'channel.recharge/adjust')
├─ exposure.ts   上游敞口预留/释放(换渠原子替换)
├─ closeout.ts   结算后实际成本扣减 + 熔断判定
└─ index.ts      域出口
```

## 8. settlement 域(src/settlement/,worker 编排,纯编排)

BullMQ 队列契约、SKIP LOCKED 认领、租约三元组、失败分类重试、滞留恢复、库存——
全部只调用 billing/subscription/channel-budget 的动词,不做任何领域判定。

## 9. 数据迁移与旧模型退役

1. wallet 内核增量(§3)落地,四关全绿。
2. 域按依赖序在包内立起(§10),apps 逐域切换;**新旧并存期唯一规则:一个用户的资金
   事实只允许在一个模型里**——由停机窗口切换保证,不做在线双写。
3. 停机窗口单事务开账(沿用 consolidation 方案 P4 骨架):
   - 每用户 wallet.credit(balance,幂等键 `migration/opening/{userId}`),
     credit_line(credit_limit);
   - 活跃 billing_requests → wallet authorize 重建在途(refId=requestId);
   - 全量校验门禁:wallet 余额 == users.balance、Σ在途 == reserved_balance,
     不全等不切流。
4. 退役:users.balance / reserved_balance / credit_limit / 旧 transactions 只读封存
   (报表按需建视图)→ 统一 DROP;reconcileUser 删除,新对账 =
   wallet.verifyInvariants + usage↔wallet_legs + quota↔billing_requests + 渠道敞口四组。

## 10. 推进顺序(每步四关全绿)

```
S1  wallet 内核增量:tx 注入 + allowCredit(TDD,先红后绿)          ✅ 完成(见 §3)
S2  rating 域(从旧 billing/quote+coefficient+compute-amounts 抽出,纯迁移) ✅ 完成(见下)

S2 落地要点(2026-08-18):
- `src/platform/errors.ts` 起步:错误家谱自 billing/errors.ts 整文件上移(类对象不变,
  消费方 instanceof/name 判定零影响),billing/errors.ts 变 re-export shim。
- `src/rating/` 四文件:types(UsageReceipt/BillingQuote/估算归属 G1)、quote
  (calculateRequired 候选链最坏费用 + validateReceipt 收据验收)、amounts
  (computeAmounts 用户实扣/官方价渠道成本双口径)、coefficient(费率卡快照 + 纯函数挑选)。
- 出口:子导出 `@ai-gateway/ledger/rating`(package.json exports + tsup 扁平产物
  dist/rating.js,与 wallet/metering 惯例一致);根 index 面不变,apps 走 shim 零感知。
- 测试:rating/__tests__ 22 例(quote 14 特征规格新立 + amounts 5 新立 + coefficient 3
  迁移并补测试数据清理纪律);旧路径全部经 shim 复测通过(ledger 套件 29 文件/119 例)。
S3  subscription 域(行为规格 = 现有测试断言按域归类,迁断言不迁实现)  ✅ 23 例
S4  channel-budget 域                                               ✅ 7 例
S5  billing 域(authorize/signal/settle/release/dead 重写在钱包之上) ✅ 6 例核心流
S6  settlement 域(processor 平移,编排面换新动词)                   ✅ 3 例
S7  apps 重写(gateway/worker/admin-api/client-api 直接用新域;旧门面与旧实现
    全删不留兼容层;兑换/支付/营销为 app 自有状态机 + wallet 动词)
                                                                    ✅ 216+69+68+12 例
S8  停机开账迁移 + 相等性门禁                                        ✅ 3312 用户全等
S9  删除旧根文件 + 旧列 DROP(0058)+ 文档终局                       ✅
```

## 12. 终局快照(2026-08-18)

**包结构(@ai-gateway/ledger,单包六域 + platform)**:
```
src/
├─ platform/     errors 单一家谱 + HTTP 映射 + createDomainOperations(幂等执行器)
├─ rating/       报价/费率卡系数/最坏费用/双口径实费/收据校验(纯函数)
├─ subscription/ 套餐生命周期 + period/proration/eligibility 纯函数 + quota 原语
├─ channel-budget/ 进货/调账/敞口预留释放/结算扣减熔断(自治运营资金)
├─ billing/      authorize 管线/四事件 signal/settle(§4 补充授权)/三路释放/死单复核
├─ settlement/   processor(认领/租约/重试/恢复)+ tpm-backfill + redis effects
└─ migration/    开账迁移(幂等 + 相等性门禁)
```

**apps 资金路径**:四个 app 直接装配 createWallet + 各域;管理端调账/赠送
(admin-api funds.ts)、兑换/支付/营销(client-api redeem/payments/promotions)
为 app 自有状态机 + wallet 动词,幂等统一走 platform.createDomainOperations。

**对账(替代旧 reconcileUser)**:wallet.verifyInvariants 全账本核验 +
usage_logs↔billing_requests + quota 守卫(subscription 域)+ 敞口守卫
(channel-budget 域)四组。

**已知边界**:旧 transactions 表封存直读(§11 Q4);admin/client 流水接口已切
wallet.statement(游标分页,日期过滤随旧模型退役)。

## 11. 待拍板

| # | 问题 | 倾向 |
|---|---|---|
| Q1 | 补充授权的呈现:statement 两笔结算(§4 方案)是否可接受 | 是(复式守恒优先于展示合并) |
| Q2 | 支付/兑换/营销归 app(§2)还是立小域包 | 归 app——单 app 使用且薄;第二消费方出现再立包 |
| Q3 | channel-budget 自治(§7)vs 进 wallet 总账 | 自治;结转路径预留 |
| Q4 | 旧 transactions 报表:封存直读 vs 建统一视图 | 先封存直读,报表需求明确后再视图 |
| Q5 | subscription.quota 的额度预留是否也用 wallet 冻结单建模 | 否——额度非钱,业务表自带守卫(复杂度不值) |
