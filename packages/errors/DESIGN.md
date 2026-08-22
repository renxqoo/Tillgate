# @tokenlens/errors 设计基线（DESIGN）

> 状态：定稿（2026-08-23）
> 定位：内部错误根契约——三性根类 + category 闭集 + 命名空间错误目录契约 + 规范化错误
> 记录；永久私有、零内部依赖的稳定叶子（结构方案 §3.1"根契约"类）
> 依据：[ADR-0001](../../docs/adr/0001-errors-registry-ownership.md)（注册表归属与词表裁决）、
> [project-structure-refactoring.md](../../docs/project-structure-refactoring.md) §3.3/§5.1；
> 承接旧仓 `error-system-design.md`（v1 定稿）的三性/category 根契约并按 §3.3 调整归属
> 施工图（审计结论 / 裁决表 / 测试计划）：[IMPLEMENTATION.md](./IMPLEMENTATION.md)

---

## 1. 问题域

### 1.1 处理

- **三性分类**：business（业务拒绝，预期内）/ infrastructure（环境故障，可重试）/
  defect（缺陷，不变量破坏）三个根类，及其公共基类 `TokenlensError`。
- **category 闭集**：business 错误的唯一处理契约（七项，见 §3.2），附处理语义默认
  （retryable / alert）的**单点派生** `handlingOf`。
- **身份码规范**：点分命名空间（`ns.key`），装配期形状校验；根命名空间 `errors.*` 保留码。
  业务码 `BusinessCode` 为品牌类型——**唯一签发源是错误目录**，自由字符串在编译期被拒绝。
- **错误目录契约**：`ErrorDefinition`（category + 双语文案）+ `defineErrorCatalog`
  （能力包自有目录，`business()` 抛出 / `entry()` 绑定定义）+ `composeErrorCatalogs`（face 装配）。
- **上下文与注记（ADR-0001 D9）**：`ErrorContext` 值域为递归只读 JSON（结构化校验事实可入）；
  `annotate()` 传播注记——错误上浮途中实例稳定地累积语境，不包装、不改判。
- **错误即数据**：`ErrorRecord` 规范化形状（含 cause 链，深度上限）；
  `normalizeError(unknown)` 边界兜底——外来 Error / 非 Error 值一律按缺陷。
- **守卫**：`isTokenlensError` / `isBusinessError` / `isInfrastructureError` / `isDefectError`。

### 1.2 明确不处理（写明归属，不留白）

| 不处理                                                  | 归属                                                                |
| ------------------------------------------------------- | ------------------------------------------------------------------- |
| HTTP status、信封形状、错误渲染出口                     | `http` 包（category → 默认渲染）+ app face（override 表 + onError） |
| 双语**选择**（Accept-Language/cookie）、i18n 超出 en/zh | face 层；本包只要求目录定义的 `message`/`zh` 存在                   |
| PG SQLSTATE 源头分类                                    | `db` 包（`src/pg-error.ts`），用本包根类表达结果                    |
| Redis / 进程 / 配置类环境错误的具体形状                 | `runtime` 包（用 `InfrastructureError`）                            |
| 厂商上游错误归一                                        | `ai` 包自有 `ErrorKind` 封闭词表（映射见 ADR-0001 §D7）             |
| 审计持久化、告警通道、错误计数                          | `observability` / `runtime`；本包只给 `alert` 布尔默认              |
| 全仓守卫测试（throw 点码必登记）、错误文档生成          | 各消费者迁移单元随迁（ADR-0001 §4.3）                               |
| 跨请求运维状态（熔断/死凭据）                           | `inference/health`（`ai` `AiEvent` 订阅者）                         |

## 2. 外部契约

```ts
// ---- 能力包：定义自有目录（身份/分类/文案单点来源，随包分发）----
export const BillingErrors = defineErrorCatalog('billing', {
  insufficient_cash:  { category: 'quota_exhausted', message: 'Insufficient cash balance', zh: '现金余额不足' },
  plan_disabled:      { category: 'conflict',        message: 'Plan is disabled',         zh: '套餐已停售' },
});

// ---- 抛出：受荐路径（文案来自定义，动态事实进 context——本地化的结构前提）----
throw BillingErrors.business('insufficient_cash', { needed: '5.00', available: '3.00' });

// context 收只读 JSON 值：结构化校验事实（字段路径列表等）直接入（D9a）
throw BillingErrors.business('invalid_amount', { fields: [{ path: 'amount', reason: 'not a decimal' }] });

// ---- 传播注记：外层补事实，实例稳定、不包装、instanceof 不动（D9b）----
catch (e) {
  if (isBusinessError(e)) throw annotate(e, { requestId, channelId });
  throw e;
}

// ---- 抛出：家谱形态（高频错误固化类；entry() 绑定定义，类与目录零漂移）----
export class InsufficientCashError extends BusinessError {
  constructor(needed: string, available: string) {
    super(BillingErrors.entry('insufficient_cash'), { needed, available });
  }
}

// ---- 捕获：instanceof 精确捕获，其余穿透（middleware 纪律）----
try { ... } catch (e) {
  if (isBusinessError(e) && e.category === 'quota_exhausted') { /* 换渠道/提示充值 */ }
  else throw e;
}

// ---- face 装配：合成全量目录（重复命名空间装配期失败）----
const APP_ERRORS = composeErrorCatalogs(BillingErrors, IdentityErrors, /* ... */);
APP_ERRORS.get('billing.insufficient_cash');   // → { category, message, zh }

// ---- 边界兜底：任意 unknown → 规范化记录（外来一律按缺陷）----
const record = normalizeError(thrown);          // ErrorRecord
handlingOf(record);                             // { retryable, alert } —— 单点派生
```

接口面刻意极小（结构方案 §3.1："其接口必须极小且多年稳定"）：7 个源文件、19 个值导出。
类型导出与其配套；完整出口清单由 `__test__/boundary.test.ts` 快照锁定。

## 3. 词表与语义

### 3.1 三性（唯一有资格成为根类的区分）

```text
拒绝该操作是系统的正确行为吗？
├─ 是，且在预期内（用户余额不足、权限不够、状态冲突）──→ business（携带 category）
├─ 否，但属于环境（DB/Redis/上游/投递不可用）──────────→ infrastructure（可重试、告警）
└─ 否，且不该发生（不变量破坏、不可达路径、装配 bug）──→ defect（不重试、响铃、细节不外泄）
```

判例（v1 审计映射）：`WalletInvariantError`/`BillingInvariantError`/各包 `*InternalError`
→ defect；`CaptchaError(unavailable)`/`BillingBacklogError`/投递失败 → infrastructure；
其余业务拒绝 → business。边界判例（v1 双包矛盾）：`SettleExceedsHold`——账面数额与授权
不一致属于可防御的恶意/缺陷输入，v2 裁决为 **business/conflict**（出站 422，不掩盖、
不甩锅 500）；「settle ≤ hold 是内核保证」的核内断言则用 defect 表达，二者不得混用。

### 3.2 category 闭集（七项；唯一处理契约）

| category          | 语义                                        | 默认 status（http 侧，仅示意） | retryable | alert |
| ----------------- | ------------------------------------------- | ------------------------------ | --------- | ----- |
| `invalid_input`   | 调用方数据问题                              | 400                            | ✗         | ✗     |
| `not_found`       | 目标不存在                                  | 404                            | ✗         | ✗     |
| `conflict`        | 状态/唯一性冲突，修正后可重试               | 409                            | ✗         | ✗     |
| `forbidden`       | 资格/权限/状态不允许                        | 401/403                        | ✗         | ✗     |
| `quota_exhausted` | 资金/额度维度不允许（v2 增补，ADR-0001 D4） | 402                            | ✗         | ✗     |
| `rate_limited`    | 限流，退避后可重试                          | 429                            | ✓         | ✗     |
| `unavailable`     | 依赖不可用/自我保护拒流                     | 503                            | ✓         | ✓     |

- 闭集为**编译期 union + 测试双锁**；增删走 ADR（同 ai `ErrorKind` 治理）。
- "唯一处理契约"：catch 站点与协议出口只对 category（及 nature）分派，不对错误类、
  不对层、不对 status 分派。
- status 列仅示意归属（http 渲染），**本包源码零 status**。

### 3.3 身份码规范

- 形如 `namespace.key`，两段均为 `/^[a-z][a-z0-9_]*$/`；目录定义与 face 装配期校验，
  多段伪造（`ns.a.b`）在查找时必然 miss。
- **业务码构造绑定（ADR-0001 D8）**：`BusinessError` 构造器只收绑定定义
  （code + category + message 三元组，`BusinessErrorInit`），三元组只能整体来自目录的
  `entry()` / `business()`——message 与 category 无法在构造点偏离定义（E8/E9 的编译期
  封死）。`BusinessCode` 品牌类型使自由字符串/手误码无法作为身份码编译通过；
  `as BusinessCode` 强转属刻意违规，由全仓守卫扫描兜底（ADR-0001 §4.3）。
- infrastructure / defect 码**不打品牌**：它们没有注册表事实源（按设计走通用渲染），
  无签发源的品牌只是仪式；其命名空间治理随 db/runtime 迁移单元落地。
- 命名空间即 owner（能力包名）；v1 的 `owner` 字段不复存在——namespace 已是分组与
  告警认领维度。
- 根命名空间 `errors.*` 保留五码（ADR-0001 D6），由本包单点定义（`ROOT_ERROR_CODES`）。
- wire 投影（如 gateway OpenAI 面的码）归 face；同一身份码在不同 face 可有不同出站码。

### 3.4 处理语义单点派生

`handlingOf(record)`：business 查 `CATEGORY_DEFAULTS[record.category]`；
infrastructure → `{ retryable: true, alert: true }`；defect → `{ retryable: false, alert: true }`。
不提供逐例覆盖（ADR-0001 D5）——某码需要不同处理语义时，是它的 category 选错了。

## 4. 治理与稳定性

1. **封闭词表**：`ErrorCategory`、根保留码、ai 映射表（ADR-0001 D7）三处变更必须走 ADR。
2. **业务码封闭（编译期）**：`BusinessCode` 品牌 + 绑定构造，未登记码无法编译；
   目录 namespace 归属（能力包不得占用他包命名空间）与 `as BusinessCode` 违规扫描
   归全仓守卫测试，随第一个消费者迁移单元落地（ADR-0001 §4.3）。
3. **冻结语义**：目录定义、`codes` 数组、目录对象、`entry()` 返回值在构造期深冻结；
   定义入目录后与源对象隔离（防御性拷贝）。传入可变对象是调用方自由，目录自身不可变。
4. **零依赖门禁**：`dependencies`/`peerDependencies` 恒为空（`__test__/boundary.test.ts`
   运行时断言；仓库级边界脚本就位后并入 CI 的静态检查）。
5. **稳定性承诺**：三性、category、记录形状按"多年稳定"设计——新增 category 是破坏性
   变更（消费方 switch 穷举被打破），必须 major 级评审；新增导出一般是安全的。
6. **ES 目标**：`Error.cause`（ES2022）是 cause 链的唯一载体；不引入自定义链式字段。

## 5. 预算

无热路径（错误构造与归一只在异常路径）。约束：

- 构造一次错误 = 常数次对象分配（Error + 字段；无栈捕获、无格式化）。
- `recordOf` / `normalizeError` 浅拷贝字段；cause 链规范化深度上限 `MAX_CAUSE_DEPTH = 10`
  （v1 实证 drizzle 包装链深 ≤ 3；防御病态长链）。
- 目录构造（装配期，每进程一次）O(n) 冻结；查找 O(1)。
