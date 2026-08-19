# 按层分包实现方案（packages/domain + packages/service）

> 版本：2026-08-20 v10（v1 共存清理完成）· 状态：P1-P5 全部执行完毕（四门全绿）；已完成：v1 于 2026-08-20 退役删除
> 前置：gateway 角色裁剪完成（纯网关），81 测试全绿，四门全过。
> 本方案将 gateway 内的 domain/services 层独立为**按层组织的两个共享包**，
> 并引入资金来源策略（FundingSource）与预扣明细表（billing_reservations）。
>
> v3 变更：补入 review 发现的 10 条缺口——probe 错误语义（§3.6）、旧 worker 过渡
> （§4.4）、部分失败策略（§3.7）、Registry 生命周期（§3.8）、零金额（§3.9）、
> 来源上下文预解析（§3.10）、结算路径接口预留（§8）、可观测性（§9）、
> decimal.js 依赖（§10）、测试归属（§6.6）。
>
> v4 变更：订阅排他语义定案（§3.6）——`api_keys.allow_payg_fallback` 开关，
> OFF=额度不足整单拒绝（现状行为），ON=自动转按量补差；probe 签名加 amount；
> 普通 Key 永不消耗订阅额度；成员限额作用域澄清。
>
> v5 变更：对照全仓真实结构（8 app / 15 包）校正——终态包全景（§2.4）、domain 包内
> 依赖方向（§2.2）、settlement 目录占位（§2.2/§8）、依赖表修正（§10，service 经
> repository 取 Db/DbTx）、包骨架 exports 模式（§6 P1/P2）；补入二轮 review 缺口——
> 投影列两阶段时序（§5.1）、部分释放签名与顺序规则（§3.2/§8）、来源依赖注入与
> 上下文桥接（§3.11）、过渡期来源集合冻结（§4.4）、删三列读方清单（§4.2）、
> recover 路径预留（§8）、DDL 约束补全（§4.1）、测试基建（§6.6）。
>
> v6 变更：P1/P2 落地记录——domain 包内方向修正为全序 shared←wallet←rating←
> 用例域（rating 引用 wallet 的金额值对象，§2.2）；§3.11 单参 RepoContext 统一
> 在实现期否决（唯一冲突兜底重放需要池连接），wallet 保留 ctx+tx 双轨。
>
> v9 变更（深度 review 后按 DDD 原则补全）：**结算域落地**——service/settlement/
> （claim / settleClaim / processClaim / finishFailure / recover）+ FundingSource.settle；
> 三条纯规则下沉 domain（allocateSettlement 分配 / settleFailurePolicy 失败策略 /
> decodeReceipt 解码守卫）；usage_logs 投影恢复落库（日限口径失真修复）；回收三路径
> 接通（授权过期/网关崩溃/认领过期）。§2.2 的 settlement 占位目录自此有实现。
>
> v7 变更：P3-P5 落地记录——billing_reservations + allow_payg_fallback（0060，已入库）；
> funding 策略族 + 两阶段瀑布接管 authorize/signal（38 测试全绿）。实现期修复两个老逻辑
> 缺陷：① sumExposure 幂等重放把自身请求计入暴露量两遍（现按 excludeRequestId 排除）；
> ② signal(failed) 先 CAS 成 released 再查明细——findActive 的账单状态白名单须支持
> 调用方覆写（释放路径并入 released）。收尾清理：v2 包内被替代代码已删
> （gateSubscription / 三路投影释放 release.ts / paygPart）；**v1 业务包
> （ledger / wallet / ledger-core）一律未动**，待全部逻辑完成后统一清理共存。
> （后续执行：ledger 已删；wallet/ledger-core 保留为长期内核）
>
> v8 变更：可变值不再写死——币种改为装配注入（WalletEnv.currency /
> BillingDomainDeps.currency 必填，流入 guards 白名单与 FundingSourceContext，
> createWallet 装配期校验白名单含币种）；'billing' refType 收敛为 domain 单一导出
> BILLING_REF_TYPE；顺带修复 PaygSource.probe 多币种下任意挑账户的隐患（按计费币种过滤）。
>
> v10 变更（2026-08-20）：v1 共存清理完成——v1（ledger）已整体删除；四应用去除
> -v2 后缀；wallet / ledger-core 确立为长期内核。

---

## 1. 拆包依据：为什么是按层（方案 B）而不是按域（方案 A）

### 1.1 两个方案对比

| 维度 | 方案 A：按域建包 | 方案 B：按层建包（本方案） |
|---|---|---|
| 包结构 | `wallet/` `funding/` `subscription/` 各一个包 | `domain/` `service/` 各一个包，域是包内目录 |
| 加新域 | 新 package.json + tsup + tsconfig + turbo 接线 | **加目录，零配置** |
| 包间依赖 | funding→wallet 跨包 import（违反「包不互相调」原则） | **域间引用在同包内，包间只有 service→domain 和 service→repository** |
| 包数量增长 | 随域线性增长（每域一包） | **恒定两个**（新域进目录） |
| 架构边界测试 | 每个域包一套 | **一套管全部** |
| import 复杂度 | `@ai-gateway/funding` `@ai-gateway/wallet` 各导各的 | `@ai-gateway/service` `@ai-gateway/domain` 各一个 |

### 1.2 按层建包的核心论据

1. **加域零成本**：将来加促销（promo）、企业资金池（enterprise）、新计费模型——只加目录，不建包。
2. **包间依赖最小**：全系统只有两条包间依赖方向（service→domain、service→repository），无环。
3. **与用户定义的四层完全对齐**：`routes → Service → Domain → Repository` = `apps → service → domain → repository`。
4. **域间协作是同包目录引用**：billing 用 wallet 的守卫、subscription 用 wallet 的 transfer——天然属于同一层。
5. **monorepo 私有包无版本问题**：workspace:* 全源码链接，不存在跨包版本兼容。

### 1.3 域归属判定标准

| 判据 | 进 domain/service 包 | 留 app |
|---|---|---|
| ≥2 个 app 需要它的**业务规则** | ✅ wallet（4 app）、billing（3 app）、subscription（2 app） | |
| 只有 1 个 app 调它的业务逻辑 | | ✅ 用户管理（client-api）、模型目录（admin-api）、支付、促销 |
| 有跨 app 不变量要守住 | ✅ 资金守恒、状态机迁移、幂等 | |
| thin CRUD / 单端流程 | | ✅ 用户资料、API Key 管理 |

### 1.4 系统全部域的归属

| 域 | 业务逻辑 | 消费方 | 归属 |
|---|---|---|---|
| 复式记账 | wallet 值对象、posting 规则、账户守卫 | 4 app 间接 | `domain/wallet` + `service/wallet` |
| AI 计费 | 8 态状态机、计价公式、限额闸 | gateway + worker + admin | `domain/billing+rating` + `service/billing` |
| 资金来源 | 策略接口 + PAYG/订阅实现 | gateway + worker | `service/funding` |
| 渠道运营资金 | 敞口预留/释放、成本扣减熔断 | gateway + admin + worker | `domain/channel-budget` + `service/channel-budget` |
| 订阅商品 | proration、eligibility、生命周期动词 | client-api + admin-api | `domain/subscription` + `service/subscription`（将来） |
| 用户管理 | 注册、资料、API Key | client-api 单端 | `client-api/src/services/user/` |
| 模型目录 | 映射/渠道/费率卡 CRUD | admin-api 单端 | `admin-api/src/services/models/` |
| 支付 | 订单、epay 回调 | client-api 单端 | `client-api/src/services/payments/` |
| 促销 | 赠礼、返佣 | client-api 单端 | `client-api/src/services/promotions/` |
| 鉴权 | JWT、会话 | client-api + admin-api | `packages/identity`（已有） |
| LLM 传输 | 协议适配 | gateway 单端 | `packages/ai`（已有） |

---

## 2. 终态架构

### 2.1 包依赖图（完整、无环）

```
                    ┌──→ domain（纯规则，零外部依赖，仅 decimal.js）
                    │
service ────────────┤
                    │
                    └──→ repository ──→ db
                                        │
apps ──→ service + repository + identity + ai + ...
```

### 2.2 包结构

```
packages/
  db/                          schema + migrations（已有，不动）
  repository/                  全部 SQL（已有，不动 + 新增 billing-reservation.repo）
  domain/                    ★ 新建：全部域规则
    src/
      wallet/                   money / posting / account / authorization / fingerprint / guards / errors
      billing/                  reservation / daily-window / errors
      rating/                   pricing / quote / amounts / types / coefficient / errors
      channel-budget/           errors
      shared/                   errors / operation-id
      __tests__/                架构边界测试
    package.json（deps: decimal.js）
    tsup.config.ts / tsconfig.json

  service/                   ★ 新建：全部用例
    src/
      context.ts                RunContext / inTx / readOnly / systemContext
      wallet/                   credit / authorize / settle / release / transfer / credit-line / queries / posting / shared / wallet
      billing/                  authorize / signal / reserve-channel / index
      funding/                  source / payg-source / subscription-source / registry / plan / commit / release / index
      channel-budget/           channel-budget（closeout）
      settlement/               占位：worker 的 claim / process-claim / recover / inventory（§8）
      shared/                   operations（幂等）
      __tests__/                集成测试
    package.json（deps: @ai-gateway/domain + @ai-gateway/repository + decimal.js）
    tsup.config.ts / tsconfig.json

apps/
  gateway/                   纯网关：路由 + 管线 + 装配根
  worker/                    BullMQ 消费 + 装配根（将来）
  client-api/                HTTP + 订阅 + 支付 + 促销（将来）
  admin-api/                 HTTP + 模型管理 + 复核（将来）
```

**domain 包内依赖方向（边界测试强制）**：按层包没有天然边界，方向不测就会长环。

```
层级（只许向下引用）：shared ← wallet ← rating ← billing / channel-budget
禁止：向上引用、用例域互引（billing ↔ channel-budget）
```

wallet 是记账内核（money 金额值对象被 rating 计价公式引用）；billing 引用 wallet 与
rating 是合法下行。将来 subscription 域进包时按用例域对待。已由 packages/domain
的 `__tests__/architecture.test.ts` 机器强制。

### 2.3 gateway 改造后剩什么

```
apps/gateway/src/
  routes/                       （将来）HTTP 适配
  pipeline/                     （将来）推理管线编排
  model-router/                 （将来）模型→渠道路由
  __tests__/                    端到端测试（import @ai-gateway/service）
  package.json                  deps: @ai-gateway/service + @ai-gateway/repository
```

### 2.4 终态包全景（现 15 包，money 空壳待清）

对照全仓真实结构（8 app / 15 包）。旧 `packages/ledger` 自述即「资金账本领域（gateway
与 worker 共用）」、被全部 4 个老后端 app（gateway / worker / client-api / admin-api）
依赖——**共享业务逻辑住包里是仓库既有路线，本方案是对它的严格化（域规则与用例分层）**，
不是新发明。老 worker 的 `tasks/` 只有 generation-poller 与 notify-referral 两个壳任务，
结算业务全在 `ledger/settlement`——service 包不建，worker 只能复用旧包或复制代码。

| 处置 | 包 |
|---|---|
| ★ 新建（已建成） | `domain`、`service` |
| ✖ 已删除（四应用——已去 -v2 后缀——全部切换后执行） | `ledger` |
| 保留为长期内核（原计划删除，实况保留） | `ledger-core`、`wallet` |
| 不动 | `db`、`repository`、`identity`、`identity-core`、`ai`、`core`、`http`、`tracing`、`ui`、`api-client` |

前端（client / admin）与 trace-receiver 不受影响。

---

## 3. 资金来源策略

### 3.1 问题

authorize 管线里「PAYG vs 订阅」的分叉出现了三次（闸/占/放）——策略模式把分叉收敛为一次来源解析，之后全部多态。

### 3.2 接口

```ts
// service/funding/source.ts
export type SourceType = 'payg' | 'subscription' | 'promo' | 'enterprise' | string;

export interface SourceReservation {
  billingRequestId: string;
  sourceType: SourceType;
  sourceRefId: number | null;
  amount: string;
}

export interface FundingSourceContext {
  userId: number;
  /** 计费币种（装配注入——来源按此口径挑账户/算额度，不藏全局默认） */
  currency: string;
  credential: { apiKeyId: number | null; appId: number | null };
  /** 预解析的来源引用（凭证→订阅绑定在解析链组装前完成，策略不重复查库） */
  resolved: {
    subscriptionId: number | null;
    /** 包月额度耗尽是否自动转 PAYG（api_keys.allow_payg_fallback，随凭证一并预解析） */
    allowPaygFallback: boolean;
  };
  model?: string;
}

export interface FundingSource {
  readonly type: SourceType;
  readonly priority: number;

  applies(input: FundingSourceContext): boolean;

  /** amount=瀑布当前缺口；覆盖不足时策略自行判定抛错（整单拒绝）或返回部分额（允许补差） */
  probe(c: RepoContext, input: {
    userId: number; amount: string; now: Date; context: FundingSourceContext;
  }): Promise<Decimal>;

  reserve(c: RepoContext, input: {
    userId: number; requestId: string; amount: string; now: Date; context: FundingSourceContext;
  }): Promise<SourceReservation>;

  /** 归还预扣：缺省整笔；结算差额按 amount 部分释放（顺序规则见 §8） */
  release(c: RepoContext, reservation: SourceReservation, amount?: string): Promise<void>;
}
```

### 3.3 两个初始实现

#### PaygSource（priority 100，兜底）

```
applies:  恒 true（套餐 Key 且开关 OFF 时执行不到——订阅 probe 抛错先行中断瀑布）
probe:    wallet 账户 → balance + creditLimit − inFlight
reserve:  wallet.authorize
release:  wallet.release
```

#### SubscriptionSource（priority 10，先耗）

```
applies:  context.resolved.subscriptionId != null（凭证绑了订阅；普通 Key 恒不适用
          ——即使该用户另有活跃订阅，未绑定的 Key 也不消耗额度）
probe:    结构性非法（过期/越权/成员超限）→ 抛错，与开关无关
          开关 OFF + 覆盖不足 amount → 抛 SubscriptionQuotaExhaustedError（整单拒绝）
          开关 ON  → 返回 min(剩余额度, 成员日限余量, 成员月配额余量)，缺口留给后续来源
reserve:  subscriptionRepo.tryReserveQuota
release:  subscriptionRepo.tryReleaseQuota
```

### 3.4 注册表 + 解析链 + 瀑布

```ts
// service/funding/registry.ts
export function createFundingRegistry(sources: readonly FundingSource[]): FundingRegistry;
// 不可变注册表：一次构造、终身只读（无 register 时机问题）
// FundingRegistry：get(type) 按类型取；resolve(context) applies 过滤 + priority 升序

export async function waterfallReserve(
  registry: FundingRegistry,
  c: RepoContext,
  input: { userId; credential; requestId; amount: string; now: Date; repos: Repositories },
): Promise<SourceReservation[]>;
```

### 3.5 将来扩展示例（零管线改动）

```ts
// service/funding/promo-source.ts（将来）——工厂返回普通对象，闭包捕获依赖
export function createPromoSource(deps: { repos: Repositories }): FundingSource {
  return {
    type: 'promo', priority: 1,
    applies: () => true,
    probe: async (c, input) => new Decimal(0),   // 读池余额；不可用返回 0
    reserve: async (c, input) => { /* 扣池 */ },
    release: async (c, r) => { /* 还池 */ },
  };
}
// 装配数组加一项——authorize / signal / release 零改动
createFundingRegistry([..., createPromoSource({ repos })]);
```

### 3.6 probe 错误语义（已定决策：开关式）

**决策（2026-08-19 定案）**：Key 分两类创建——**套餐 Key**（创建时绑定订阅）与**普通 Key**（纯 PAYG）。

1. **普通 Key 永不消耗订阅额度**（即使该用户有活跃订阅）。
2. **套餐 Key 优先消耗订阅额度**。
3. 订阅额度耗尽后是否自动转 PAYG 扣余额，由开关 **`api_keys.allow_payg_fallback`** 决定（创建 Key 时设置，client-api 职责；gateway 经凭证解析只读）。

**「排他 vs 可选」不是来源类型的静态属性，而是 SubscriptionSource 按每次请求的开关状态在两种语义间切换**：

| 判定 | probe 行为 | 瀑布结果 |
|---|---|---|
| 结构性非法：订阅过期 / 越权 / 成员超限 | 抛领域错误（**与开关无关**） | 整个授权拒绝 |
| 套餐 Key + 开关 OFF + 额度不足以覆盖 amount | 抛 SubscriptionQuotaExhaustedError | **整单拒绝，余额不动（= 现状行为）** |
| 套餐 Key + 开关 ON + 额度不足 | 返回余量（≥0），缺口留给后续来源 | 订阅出余量 + PAYG 补差，明细两行 |
| 用户级可选型来源（促销池）不可用 | 返回 0，不抛错 | 跳过，继续下一来源 |
| 兜底（PAYG）且全链加总仍不够 | — | remaining > 0 → 拒绝 |

瀑布伪码（完整错误处理）：

```ts
async function waterfallReserve(registry, c, input): Promise<SourceReservation[]> {
  if (new Decimal(input.amount).isZero()) return [];  // 零金额：不 probe 不 reserve 不写明细
  const context = buildContext(input);                 // 预解析 subscriptionId + allowPaygFallback
  const chain = registry.resolve(context);             // applies 过滤 + priority 排序
  let remaining = new Decimal(input.amount);
  const plan: Array<{ source: FundingSource; take: Decimal }> = [];
  for (const source of chain) {
    // probe 拿到「当前还差多少」（amount=remaining），策略自行判定：
    //   结构性非法 / 开关 OFF 且覆盖不足 → 抛错 → 整个瀑布中断（事务回滚）
    //   不可用 → 返回 0（约定 ≥ 0，负余量防御性 clamp）→ 跳过
    const available = await source.probe(c, {
      userId, amount: remaining.toString(), now, context,
    });
    const take = Decimal.min(available, remaining);
    if (take.gt(0)) plan.push({ source, take });
    remaining = remaining.minus(take);
    if (remaining.isZero()) break;
  }
  if (remaining.gt(0)) {
    throw new InsufficientBalanceError(userId, '0', input.amount);
  }
  const reservations: SourceReservation[] = [];
  for (const { source, take } of plan) {
    // reserve 失败（守卫输掉跨 user 并发）→ 抛错 → 整个事务回滚（含前面来源的预占）
    const r = await source.reserve(c, { userId, requestId, amount: take.toString(), now, context });
    await repos.billingReservation.insertActive(c, r);
    reservations.push(r);
  }
  return reservations;
}
```

**probe 返回值契约**：恒 ≥ 0。订阅 `剩余 = 配额 − 已用 − 预占` 在异常场景可为负，probe 内部 clamp 到 0——负数不得进瀑布污染 `Decimal.min`。

**成员限额作用域**：成员日限/月配额保护的是**组织订阅池**，只约束订阅份额；开关 ON 时 PAYG 补差是用户自己的余额，由**用户级/Key 级每日限额**（authorize 前置闸，总额口径）约束。两类限额各管各的池，切分不会绕过限额。

### 3.7 部分失败策略

**场景**：促销 probe 2 元 → reserve 成功；PAYG probe 1 元 → reserve 失败（并发对手刚用完）。

**策略**：**整个事务回滚（含促销的已成功预占），抛错让客户端重试。**

**理由**：
- advisory 锁只按 user 串行化 authorize——同 user 无竞态
- **跨 user 共享同一订阅**时，两个 user 的 authorize 各持各的 advisory 锁，tryReserveQuota 的守卫 WHERE 是唯一防线
- 守卫输掉 = 另一个 user 先占了额度 → 本 user 的部分预占已无意义 → 回滚是唯一正确选择
- 不做自动重试（重试在 authorize 层面由客户端发起，幂等键保证安全）

### 3.8 FundingRegistry 生命周期

**方案 B：装配时创建，注入到 BillingEnv。**

```ts
// gateway 或 worker 的装配根（不可变注册表：一次构造、终身只读）
const fundingRegistry = createDefaultFundingRegistry({ wallet, repos });  // {subscription, payg}
// 将来：createFundingRegistry([..., createPromoSource({ repos })])

const billing = createBillingDomain({ db, currency: 'CNY', wallet, repos, fundingRegistry });
```

- **不使用模块级单例**：测试需要替换来源（数组里放 stub），单例无法隔离
- **每个 app 的装配根各自装配**：gateway 和 worker 可以用不同的来源集（如 worker 不需要 promo 的 probe，只需要 release）
- **注册表是不可变的**（只存来源对象的只读快照），构造后无 register 时机问题

### 3.9 零金额请求

**瀑布直接跳过**：`if (amount.isZero()) return []`。不调任何 probe、不调任何 reserve、不写任何明细行。

对应 authorize.ts 的免费快路径（explicitlyFree → 0 元 → 无预占）——行为与现有一致。

### 3.10 来源上下文预解析

`FundingSourceContext.resolved.subscriptionId + allowPaygFallback` 由**解析链组装前**统一查询一次（调 `repos.credential.resolveSourceAndLimits`，api_keys 一并带出开关值），传入所有 source。

**策略自身不重复查库获取凭证绑定**——避免同一事务内多次查 api_keys/apps 表。策略的 probe 只查自己域内的数据（订阅快照/额度/成员限额；wallet 余额）。

### 3.11 来源的依赖注入与上下文桥接

来源是**装配期单例**（§3.8），不能持请求态——协作者构造注入：

```ts
// 装配根
new PaygSource({ wallet })          // 注入 wallet 服务
new SubscriptionSource({ repos })   // 注入仓储
```

**上下文桥接（P2 实现期定案）**：原计划「wallet API 统一 RepoContext 单参口径」在实现时**否决**——
wallet 幂等三段式的「唯一冲突兜底重放」需要在事务回滚后的**池连接**上重读；若调用方持有事务
（单参口径），冲突时事务已 aborted，无法在原连接上返回重放答案。因此 wallet 保留
`(ctx: RunContext, input & { tx? })` 双轨：独立调用自开事务、billing §4 注入共享事务。
PaygSource 在瀑布内桥接——瀑布契约保证 `c.db` 是事务句柄，
`const { db: tx, ...ctx } = c` 即得 RunContext + tx，调 `wallet.authorize(ctx, { ..., tx })`。

---

## 4. 新表：billing_reservations

### 4.1 DDL

```sql
-- 0060_billing_reservations.sql
CREATE TABLE billing_reservations (
  id BIGSERIAL PRIMARY KEY,
  billing_request_id UUID NOT NULL REFERENCES billing_requests(request_id),
  source_type VARCHAR(32) NOT NULL,
  source_ref_id BIGINT,
  amount NUMERIC(38,18) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  released_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX billing_reservations_request_idx
  ON billing_reservations (billing_request_id) WHERE status = 'active';
CREATE INDEX billing_reservations_source_idx
  ON billing_reservations (source_type, source_ref_id) WHERE status = 'active';
-- 全量索引（非 partial）：清理脚本/对账要扫 released/settled 行，partial 索引盖不到
CREATE INDEX billing_reservations_request_all_idx ON billing_reservations (billing_request_id);

-- 约束：落行必为正（零金额不落行，§3.9）；状态机与时间戳一致；
-- 同请求同来源至多一行 active（防重放双预留）
ALTER TABLE billing_reservations
  ADD CONSTRAINT billing_reservations_amount_positive CHECK (amount > 0),
  ADD CONSTRAINT billing_reservations_status_valid CHECK (status IN ('active','released','settled')),
  ADD CONSTRAINT billing_reservations_status_ts CHECK (
    (status = 'active'   AND released_at IS NULL     AND settled_at IS NULL) OR
    (status = 'released' AND released_at IS NOT NULL AND settled_at IS NULL) OR
    (status = 'settled'  AND settled_at IS NOT NULL  AND released_at IS NULL)
  );
CREATE UNIQUE INDEX billing_reservations_request_source_uq
  ON billing_reservations (billing_request_id, source_type) WHERE status = 'active';

-- §3.6 定案：包月额度耗尽自动转按量开关（创建 Key 时设置——client-api 职责；gateway 只读）
-- DEFAULT false（已定）：存量套餐 Key 零行为变化（额度不足仍整单拒绝），新 Key 创建时按需打开
ALTER TABLE api_keys ADD COLUMN allow_payg_fallback BOOLEAN NOT NULL DEFAULT false;
```

### 4.2 与 billing_requests 三列的关系

| 列 | 处置 |
|---|---|
| `reserved_amount` | 继续写（总额 = Σ明细），旧 worker 限额 SUM 依赖 |
| `plan_reserved_amount` | 继续写（= 订阅来源明细额），旧 worker 释放依赖 |
| `subscription_id` | 继续写（来源解析依据） |

**新真相在 `billing_reservations`**；旧列是投影，worker 上线后删。**删列前读方必须先切**：

| 读方 | 现状 | 切换 |
|---|---|---|
| `sumExposure`（billing-request.repo.ts）——用户/Key 日限、成员限额口径 | 读 `reserved_amount`（按 `subscription_id` 过滤） | 改按明细表 SUM（可分 source 维度），限额口径升级为真来源口径 |
| authorize 重放校验 | 比对 `existing.reservedAmount` | 金额已含在 `authorization_fingerprint` 里，比对退位给指纹 |
| signal(failed) 释放 | 读三列驱动 releaseReservations | 本方案 §5.2 已改读明细（findActive） |
| 旧 worker 结算/释放 | 读三列 | worker 接管（§4.4 / §8） |

### 4.3 Repository 新增

```
BillingReservationRepository:
  insertActive(c, reservation) → void
  findActive(c, billingRequestId) → SourceReservation[]
  markReleased(c, id, now) → boolean
  markSettled(c, id, now) → boolean     // worker 将来调用
```

### 4.4 旧 worker 过渡期（关键）

**旧 worker 不知道 billing_reservations 表存在。** 过渡期行为：

| 事件 | gateway（新代码） | 旧 worker | billing_reservations 行状态 |
|---|---|---|---|
| authorize | 瀑布预占 + 写明细行 | — | `active` |
| signal(failed) | releaseAllReservations + markReleased | — | `released` |
| signal(succeeded) | 落 settlement_pending | — | `active`（保持） |
| 旧 worker settle | — | 按 billing_requests 三列结算（wallet.settle / settleQuota） | **`active`（孤儿）** |
| 旧 worker release | — | 按 billing_requests 三列释放 | **`active`（孤儿）** |

**孤儿行处理**：旧 worker 的结算/释放不操作明细表，会留 `active` 孤儿行。过渡期方案：

- `findActive` 查询加 `AND billing_requests.status IN ('authorized','in_flight','settlement_pending','processing','retry_wait','dead')` JOIN 条件——**只找账单仍在途的明细行**，已 settled/released 的账单的明细行不会误释放
- worker 上线后接管 markSettled / markReleased，孤儿行由一次性迁移脚本清理（`UPDATE billing_reservations SET status='settled' WHERE billing_request_id IN (SELECT request_id FROM billing_requests WHERE status='settled')`）
- **过渡期来源集合冻结**：registry 只允许注册 {payg, subscription}。旧 worker 按三列投影结算，投影只表达两源切分——promo 等新来源必须等 worker 上线后再 register，否则旧 worker 会把新来源份额当 PAYG 结算，账就错了

---

## 5. 管线改造

### 5.1 authorize 第④⑦步（if/else 消失）

```
改造前：
  if (source.subscriptionId != null) {
    gateSubscription(...)           // ~54 行
    tryReserveQuota(...)
  } else {
    wallet.authorize(...)
  }

改造后：
  const reservations = await waterfallReserve(registry, c, {
    userId, credential, requestId, amount, now, repos,
  });
  // 内部：零金额跳过 → 预解析 → 解析链 → 逐源 probe → 瀑布 → 逐笔 reserve + 写明细
```

**两阶段时序（投影列填值问题）**：`billing_reservations.billing_request_id` 有 FK，
billing_requests 行必须先插；但 `plan_reserved_amount`（订阅份额）要 probe 完才知道——
单趟瀑布在 INSERT 时填不出投影列。拆两阶段：

```
① probe 循环（不动账）→ 得 plan（各源份额）
② INSERT billing_requests（reserved_amount=总额；plan_reserved_amount=订阅份额；
   subscription_id 有无——投影三列全部从 plan 算出）
③ reserve 循环 + insertActive（FK 要求 billing_requests 行已存在）
```

advisory 锁保证 ①→③ 间同 user 无竞态；waterfallReserve 对外仍是一次调用，两阶段是其内部实现。

### 5.2 signal(request.failed) 释放（三路变两路）

```
改造前：
  ① wallet.release(paygPart)
  ② tryReleaseQuota(planPart)
  ③ channelBudget.releaseExposure

改造后：
  ① releaseAllReservations(requestId)   // 读明细 → 逐笔 source.release → markReleased
  ② channelBudget.releaseExposure
```

---

## 6. 实施步骤

> 执行状态（2026-08-19）：**P1-P5 全部完成，四门全绿**。
> P1/P2——packages/domain（55 单测）、packages/service（38 集成测试，真实 PG）建成；
> gateway 删除 src/domain + src/services，改为消费 @ai-gateway/service；
> repository 再导出 Db/DbTx。P3——0060 迁移（billing_reservations + api_keys 开关列）
> 已入 dev 库 + BillingReservationRepository。P4——funding 策略族（source / payg /
> subscription / registry / waterfall / release）+ 瀑布单测。P5——authorize 两阶段
> 瀑布接管（gateSubscription 消失）、signal(failed) 走 releaseAllReservations、
> 订阅切分五场景集成测试。v1 共存清理已完成：v1（ledger）于 2026-08-20 退役删除，
> 四应用去除 -v2 后缀，wallet / ledger-core 保留为长期内核。

### 阶段 P1：建 domain 包

```
1. 建 packages/domain/ 包骨架——照抄 repository 的 package.json 形状：
   exports 带 "development": "./src/index.ts" 条件（开发态直连 TS 源码、构建态 dist，
   app 开发态零预构建）；scripts 四件（build=tsup / typecheck / lint / test）；
   tsconfig 继承 tsconfig.base.json；turbo 接线。deps: decimal.js
2. 从 gateway/src/domain/ 平移全部文件
3. 建 architecture.test.ts（零 drizzle / 零 repository / 零旧包 + 包内依赖方向 §2.2）
4. pnpm install + build + typecheck
```

### 阶段 P2：建 service 包

```
1. 建 packages/service/ 包骨架（同 P1 的 exports / scripts / turbo 模式；
   deps: @ai-gateway/domain + @ai-gateway/repository + decimal.js，见 §10）
2. 从 gateway/src/services/ 平移全部文件
3. import 改为从 @ai-gateway/domain 取；wallet API 统一 RepoContext 单参口径（§3.11）
4. 建 architecture.test.ts（禁 drizzle / 全仓禁旧包）
5. 四门验证（现有测试全绿）
```

### 阶段 P3：billing_reservations 表

```
1. db 包：schema + 0060 DDL + journal
2. repository 包：BillingReservationRepository
3. psql 执行 0060
```

### 阶段 P4：资金来源策略

```
1. service/funding/source.ts —— 接口
2. service/funding/payg-source.ts
3. service/funding/subscription-source.ts（gateSubscription 逻辑迁入 probe）
4. service/funding/registry.ts —— 注册表 + waterfallReserve
5. service/funding/release.ts
6. 单元测试
```

### 阶段 P5：管线改造

```
1. service/billing/authorize.ts 改用 waterfallReserve
2. service/billing/signal.ts failed 改用 releaseAllReservations
3. 集成测试
4. 四门验证
```

### 6.6 测试归属

| 测试类别 | 归属 | 说明 |
|---|---|---|
| **domain 单元测试**（money 攻击面、posting 规则、proration 纯函数、指纹规范化） | `packages/domain/src/__tests__/` | 跟着 domain 包走，不依赖 DB |
| **service 集成测试**（billing 流程、wallet 八动词、幂等操作——真实 PG） | `packages/service/src/__tests__/` | 跟着 service 包走，依赖 PG |
| **gateway 端到端测试**（管线全链路） | `apps/gateway/src/__tests__/` | 留在 app，import `@ai-gateway/service` |
| **repository 测试**（边界测试 + 仓储正确性） | `packages/repository/src/__tests__/` | 已有 |

P1/P2 平移时：
- gateway 现有测试按上述归属**拆到对应包**
- gateway 只留管线端到端测试（authorize→signal→reserveChannel 的编排验证）
- 81 个测试按此拆分后各自全绿

测试基建（P1/P2 落地细节）：
- service 集成测试需要真实 PG——复用 repository 包的测试供给模式（DATABASE_URL / 全局 setup），vitest 配置随包，turbo test 按包并行
- app 测试经 workspace `development` 条件直连 service 源码，无需预构建 dist
- domain 单元测试零 DB 零 IO，纯 node 环境即可

---

## 7. 验收标准

| 项 | 标准 |
|---|---|
| P1-P2 行为等价 | 全部测试全绿（拆到对应包后） |
| P4 管线形态 | authorize.ts 无 `if (subscriptionId)` 分叉 |
| P5 明细正确 | billing_reservations 有正确行（订阅 1 行 / PAYG 1 行 / 瀑布 N 行 / 零金额 0 行） |
| 释放完整性 | signal(failed) 后所有明细 status='released'、钱包在途归零、额度 reserved 归零 |
| probe 错误语义 | 结构性非法恒抛错；开关 OFF 额度不足抛错整单拒绝；开关 ON 返回余量由 PAYG 补差；可选型返回 0 跳过 |
| 包月开关 OFF，额度不足 | 整单拒绝，余额零变动（现状行为保持） |
| 包月开关 ON，额度不足 | 订阅出余量 + PAYG 补差，billing_reservations 恰两行 |
| 普通 Key | 用户另有活跃订阅也不消耗额度（解析链仅 PAYG） |
| 部分失败 | 任一 reserve 失败 → 整个事务回滚 → 客户端可安全重试 |
| 边界强制 | domain 零依赖；service 禁 drizzle；全仓禁旧包；domain 内核域不引用其他域（§2.2） |
| 投影列时序 | INSERT billing_requests 时三列 = 瀑布 plan 份额（两阶段，§5.1） |
| 部分释放 | release(reservation, amount) 支持差额；顺序 priority 降序（§8） |
| 包骨架 | exports 带 development 条件 + 四 script + turbo 接线，app 开发态零预构建 |
| 四门 | typecheck / lint / build / test 全绿 |

---

## 8. worker 接口预留（settle / recover / claim）

老 worker 的全部结算业务在 `ledger/settlement`（claim / process-claim / recover / inventory），
`tasks/` 只是壳任务。worker 动工时这些用例住 `service/settlement/`（§2.2 占位），
资金侧依赖两个入口：

```ts
// service/funding/settle.ts（本方案只定义接口，worker 动工时实现）
export async function settleReservations(
  registry: FundingRegistry,
  c: RepoContext,
  billingRequestId: string,
  actualAmount: string,
): Promise<void>;
// 内部：findActive → 差额释放（见下）→ 逐笔 source 结算 → markSettled

// service/funding/release.ts（P4 已实现，recover 复用）
export async function releaseAllReservations(
  registry: FundingRegistry, c: RepoContext, billingRequestId: string,
): Promise<void>;
// recover（TTL 到期的 authorized/in_flight 回收）与 signal(failed) 走同一释放路径
```

**差额释放（实际 < 预扣是常态）**：`release(c, reservation, amount?)` 支持部分释放（§3.2）。
顺序规则：**priority 降序——先退兜底源（PAYG），再退订阅**。例：预留 10（订阅 3 + PAYG 7）、
实际 5 → PAYG 释 5 留 2，订阅 3 不动；理由是保留高优先级（更专属）来源的占用，退还现金兜底。
claim 的多副本安全继续走 billing_requests CAS + SKIP LOCKED，明细行的正确性由
findActive 的账单状态 JOIN 过滤保证（§4.4）。

**关键约束**：FundingSource 接口将来需要加 `settle` 方法——P4 实现时在接口注释标注
`// TODO(worker): settle method`；扩方法不动 probe / reserve / release 现有签名。

---

## 9. 可观测性

billing_reservations 表已包含 `source_type + amount`——运营指标（「订阅出款 vs PAYG 出款占比」「促销消耗」）的查询基础已备。

admin-api 将来需要的聚合查询（按来源/时间/模型维度）走 repository 层新增方法，不影响本方案接口。

---

## 10. 依赖声明

| 包 | dependencies | devDependencies |
|---|---|---|
| `packages/domain` | `decimal.js`（仅此一个运行时依赖） | tsup / typescript / vitest |
| `packages/service` | `@ai-gateway/domain` + `@ai-gateway/repository` + `decimal.js` | `@ai-gateway/db`（测试要 createDb / schema）+ tsup / typescript / vitest |
| `apps/gateway` | `@ai-gateway/service` + `@ai-gateway/repository`（+ 将来 identity / ai） | — |

domain 包 **不依赖** repository / db / drizzle / 任何 @ai-gateway/* 包——这由架构边界测试强制。

**service 与 db 的类型关系（v5 修正）**：gateway 的 services 有 7 处
`import type { Db, DbTx } from '@ai-gateway/db'`（context / authorize / release /
operations / channel-budget / posting / shared）。处置：**repository 加一行
`export type { Db, DbTx } from '@ai-gateway/db'`**（它本来就 import），service 改从
repository 取——运行时依赖箭头保持 service→repository→db，service 不直连 db 包；
测试用的 createDb / schema 走 devDependencies。提取时同步修订 repository/context.ts
头注释的「services（app 侧）」措辞（提取后不再是 app 侧）。

---

## 11. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 平移 import 路径错 | P1/P2 独立验收，测试是安全网 |
| probe→reserve 跨 user 竞态 | advisory 锁覆盖同 user；跨 user 由 tryReserveQuota 守卫 WHERE 兜底；失败→整体回滚 |
| 旧 worker 留孤儿明细行 | findActive 加账单状态 JOIN 过滤；worker 上线后一次性清理脚本 |
| 新旧包并存 | 已收口：ledger 已删除；wallet 为长期内核；domain/service 是唯一活跃开发面 |
| 过渡期误注册新来源 | registry 冻结 {payg, subscription}，promo 等 worker 上线后再注册（§4.4） |

---

## 12. 将来扩展（本文档范围外，仅记录）

| 扩展 | 改动面 |
|---|---|
| 加促销来源 | service/funding/ 加 promo-source.ts + 注册，管线零改动 |
| worker settleClaim | service/billing/ 加 settle 用例 + FundingSource 加 settle 方法 |
| client-api 订阅 | service/subscription/ 加生命周期动词 |
| admin-api 渠道管理 | service/channel-budget/ 加 recharge/adjust |
| 删旧三列 | worker 上线后 DROP COLUMN；前置条件 = §4.2 读方清单全部切换完成 |
| 加新计费模型 | domain/rating/ 加规则 + service/billing/ 加用例 |
| 按来源聚合报表 | repository 加查询方法，admin-api 消费 |
