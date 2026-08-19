# platform —— 域公共底座

> 出口：`@ai-gateway/ledger/platform`（根出口亦有再导出）
> 源码：`src/platform/{errors,http,operations,index}.ts`

## 1. 职责与边界

platform 是**被所有域引用的根**：错误单一家谱、领域错误 → HTTP 语义映射、
以及 ledger-core 幂等执行器的域侧装配。它自己不依赖任何域、不碰业务表、不含业务判定。

存在意义（治本而不是治标）：
- 重写前同一错误映射在 admin-api/client-api 复制三份且已漂移
  （`no_subscription` 两个码名、`insufficient_balance` 三种状态码）——单一真相后，
  新增领域码漏配 HTTP 映射即**编译失败**（`Record<LedgerError['code'], …>` 穷尽键）。
- 各域幂等样板（占位→回读→指纹核对→回执存档→冲突翻译）收敛为一个工厂，
  域内不再手写 `OperationConflictError → 业务错误` 的翻译。

## 2. 三个组件

### 2.1 errors.ts —— 错误单一家谱

| 家族 | code 语义 | 消费方 |
|---|---|---|
| `LedgerError` | 订阅/调账业务码（`plan_not_found`、`already_subscribed`、`idempotency_conflict`…14 码；余额不足语义由 wallet `InsufficientCashError` 经 `ledgerHttpError` 直接映射 402） | admin/client 路由经 LEDGER_HTTP 翻译 |
| `ChannelBudgetError` | `channel_not_found` / `insufficient_budget` | 管理端渠道资金 |
| `BillingConfigurationError` | `invalid_quote` / `invalid_coefficient` / `reservation_limit_exceeded` | 网关 422/503 |
| `InsufficientBalanceError` | 可用信用不足（含 balance/settled/reserved/creditLimit 四口径） | 网关 402 |
| `DailySpendLimitExceededError` | 用户级/Key 级日限（scope + apiKeyId 区分） | 网关 402 |
| `MemberDailyLimit/MemberQuota/SubscriptionForbidden/SubscriptionRequired/SubscriptionQuotaExhausted` | 成员/订阅来源闸系 | 网关 402/403 |
| `BillingBacklogError` | 结算积压准入（pending 深度 + 最老账龄） | 网关 503 |
| `BillingStateConflictError` | 状态机冲突（requestId + 原因） | 409 |
| `ReceiptUserMismatchError` / `PoisonReceiptError` | 毒收据（**按类型不按 message 文本**分类） | 结算侧永久失败 → dead |
| `BillingInvariantError` | 不变量红灯（code 定位发生点） | invariant_violation → dead |

### 2.2 http.ts —— HTTP 映射单一真相

```ts
LEDGER_HTTP: Record<LedgerError['code'], { status, code, message }>  // 编译期穷尽
CHANNEL_BUDGET_HTTP: Record<ChannelBudgetError['code'], …>
ledgerHttpError(error): { status, code, message } | original
```

`ledgerHttpError` 同时覆盖 wallet 内核错误族（`InsufficientBalance/InsufficientCash → 402`、
`FrozenAccount → 403`、`IdempotencyConflict → 409`）——资金单一事实源后，
apps 的错误出口只此一处。

### 2.3 operations.ts —— 幂等执行器装配

```ts
type DomainTx = Parameters<Parameters<Db['transaction']>[0]>[0];  // schema 绑定事务句柄

createDomainOperations(db, kinds): DomainOperations
// DomainOperations.run<T>({ operationId, kind, fingerprint, execute(tx) })
//   → { receipt: T, replayed: boolean }
```

- kinds 白名单传给 ledger-core（fail-closed：未登记 kind 的 run 直接拒绝）；
- `OperationConflictError`（同键异参）统一翻译为 `LedgerError('idempotency_conflict')`，
  保住 apps 的 409 契约；
- execute 的 tx 是 schema 绑定类型，域内业务写与 wallet 动词（`tx` 注入）同生共死。

## 3. 使用规约

- 新域动词的 kinds **必须在域常量里登记**（如 `SUBSCRIPTION_OPERATION_KINDS`），
  并在 `create<Domain>` 装配时传入 `createDomainOperations`；
- 业务错误一律抛家谱成员；新 code → 同步补 `LEDGER_HTTP`（编译器会逼你）；
- 指纹只放业务参数；tx/连接句柄不进，策略开关只在「显式改变语义」时进
  （例：`allowCredit === false` 才进指纹，缺省调用与历史指纹字节一致）。

## 4. 测试

家谱的 code 全局唯一由 error-contract 测试锁定（wallet 包内，因其消费 wallet 错误族）；
映射穷尽由 TypeScript `Record<code,…>` 键检查在编译期保证，无需运行时测试。
