# 错误体系设计（Error System Design）——设计论证 + v2 落地状态

> 本文档自 v1（ai-getway）同名文档适配至 v2 结构；以代码为准。
> v1 状态「设计定稿待评审」→ v2 已按 [ADR-0001](./adr/0001-errors-registry-ownership.md) 落地：
> 根契约包 `packages/errors`、`packages/http` 渲染出口、各能力包错误目录与 app face 装配。
> §1-§7 保留 v1 设计论证（注册表归属等被 ADR-0001 推翻处随文标注）；§8 为 v2 落地结果
> （原 v1「迁移路径/待拍板」章节的改写）。
> 配套：[packages/errors/DESIGN.md](../packages/errors/DESIGN.md)、
> [packages/errors/IMPLEMENTATION.md](../packages/errors/IMPLEMENTATION.md)（含 v1 全量审计 E1-E13）、
> [ADR-0002](./adr/0002-http-db-decoupling.md)（http↔db 解耦）。

---

## 1. 背景与问题诊断（v1 现状，审计事实）

### 1.1 现状（v1）

- `packages/http/src/error-codes.ts`：集中注册表（code → status + 中英文案），自称"单一真相"，但只对 `HttpError` 编译期强制。
- 三个 app 各有一份 `http/error-map.ts`：各自定义 `AppError` 类（三处拷贝）+ domain 错误翻译表。
- service 层抛 `AppError(status, code, message)`：code 为自由字符串，全仓共 98 个，未登记的码静默丢失中文文案。
- `validateSession` 等校验逻辑以 `return null` 吞掉失败原因，生产排障无据可查。

v2 迁移前的全量审计把上述现象编号为 E1-E13（四套错误模型并存、25+ 出站自由字符串码
未登记、同名表六处漂移、静默 500 洗白、跨包 code 冲突、大小写同码不同义、zh 本地化
结构性失效、message 即 code、领域层携带 HTTP/i18n 知识、ai duck-typed 错误、name 赋值
分叉、死件/幻影/隐式默认），逐条证据见
[packages/errors/IMPLEMENTATION.md §2](../packages/errors/IMPLEMENTATION.md)。

### 1.2 漂移证据（client-api vs admin-api 同名表）

admin 的 `SUBSCRIPTION_HTTP` 注释声称"与 client-api 同一分级口径"，实际：

| domain 错误 | client-api | admin-api |
|---|---|---|
| `user_not_found` | 401 `unauthorized` | 404 `user_not_found` |
| `plan_disabled` | 422 | 400 |
| `plan_not_purchasable` | 422 | 400 |
| `RefKeyConflictError` | 409 `ref_key_conflict` | 409 `idempotency_conflict` |

另有能力漂移：admin 有 PG 约束码翻译与 `HttpError` 感知，client 均无。审计实际命中
六处漂移（E3），比 v1 设计时点知的还多两处。

### 1.3 已否决的方案及理由

| 方案 | 否决理由 |
|---|---|
| 微信式数字错误码（40001…） | 受众是自家前端而非第三方集成商；字符串码自解释、可作 i18n 主键；gateway OpenAI 兼容面用蛇形码，数字码打架 |
| `DomainError`/`ServiceError` 按层命名错误 | 层身份回答"谁的错"，处理需要的是"什么性质的错"；代码在层间流动（如会话校验从 middleware 移入 service）会改变错误身份，契约不稳定 |
| `api-face` 桥包 | instanceof 匹配错误类的拐杖；错误携带数据后无人需要 import 业务包做错误翻译，桥包失去存在理由 |
| `validateSession` 返回 `null`（作为**内部**语义） | 内外部关注点混同：对外统一 401（防枚举）不要求内部不区分原因；且宽 catch 风险下 DB 故障会伪装成 401。（v2 落地取舍见 §8.3） |
| **http 集中注册表持有全量业务码**（v2 增补，ADR-0001 D1） | http 认识全部业务码 = 反向依赖业务能力，违反 §5.1 依赖白名单；v1 实证注册表与 app 表双轨漂移且无法拦截（E2/E3/E7）——**v1 §3.2/§4.4 的注册表章节由此被推翻** |
| **大写注册键 + wire 小写转换**（v2 增补，D2） | 大小写双轨是 4 组同码不同义冲突（E7）与 `toUpperCase()` 回退误命中的直接来源；改为点分命名空间 + 单段小写蛇形单轨 |
| **定义携带 status / 逐例 retryable**（v2 增补，D5） | status 是呈现轴不是身份轴，置于根契约则引入协议依赖；逐例 retryable 破坏"category 唯一处理契约" |
| **包装式富化（`withContext` 返回新错误）**（v2 增补，D9b） | instanceof 链断裂——固化类经富化退化为基类，精确捕获失效；改为实例稳定的 `annotate()` 注记 |
| **全仓 Result/Either 通道**（v2 增补，D9c） | TS 无 typed throws；推翻 throw/Hono onError 生态与行为等价迁移纪律；目录即"可抛码"声明面 |

---

## 2. 设计原则（v2 全部沿用）

错误的四个正交信息轴，各归其位，不得混淆：

| 轴 | 回答 | 载体 |
|---|---|---|
| 来源（谁的错） | 日志去哪查 | code 命名空间前缀 + 堆栈 + 目录命名空间 |
| 性质（什么性质的失败） | 调用方该怎么办 | **nature + category（唯一处理契约，闭集）** |
| 具体身份（哪个错误） | 前端展示什么 | **code（命名空间身份码，目录键）** |
| 呈现（这个面怎么渲染） | 出什么状态码/文案 | face 层（renderError + override 表） |

六条铁律：

1. **三性分根**：错误本质只有三种——业务拒绝（预期内）/ 环境故障（可重试）/ 缺陷（不变量破坏）。这是唯一有资格成为根类的区分。
2. **category 是唯一处理契约**：catch 站点与协议出口只对 category 分派，不对错误类、不对层、不对 status 分派。
3. **code 即身份**：身份码由业务上下文自有（随包分发，v2 形态为能力包错误目录），目录做**丰富化**（双语文案）而非再定义。目录签发码 === `BusinessError.code`（v2 进一步品牌化，见 §4.1）。
4. **源头分类**：谁检测谁分类，之后穿层透明传播；任何层不得重新包装他人错误（链用 `cause`；v2 另有 `annotate()` 途中注记——实例稳定，不包装）。
5. **错误即数据**：身份与分类是错误自带字段，face 渲染 `ErrorRecord` 而非匹配类型；新增 API 面零业务 import。
6. **内外分际**：内部诊断字段只进日志不进响应；对外失败语义由 face 决定，防枚举场景（会话校验）对外永远单码。

---

## 3. 目标架构

### 3.1 依赖方向（全单向；v2 修正版）

v1 版把"注册表丰富化"放在 `http`；v2 按 ADR-0001 D1 改为**能力包自有目录 + face 装配**：

```
errors（根契约包，零依赖叶子：三性 + category + 目录契约 + ErrorRecord）
  ↑                ↑                 ↑               ↑
domain/          各能力包          identity         service/app
application     （自有错误目录     （会话校验）     （编排拒绝 BusinessError）
（家谱 extends    defineErrorCatalog，
 BusinessError）  随包分发）
  └────────────────┴─────────────────┴───────────────┘
                          ↓
     http（category → 默认渲染 renderError/errorHandler + http.* 自有目录 + face override）
                          ↓
     apps/* face（composeErrorCatalogs 装配全量目录 + override 表 + 信封）
```

`http` 保持业务无关（只依赖 `errors`）；没有任何包为了错误处理 import 业务包。
PG 翻译的接缝按 ADR-0002：翻译表归 `http`（HTTP 边界语义），cause 链探测 `pgSqlState`
归 `@tillgate/db`，装配期注入。

### 3.2 目录结构（v2 实况）

```
packages/errors/src/                 # 根契约包（零依赖叶子）
  nature.ts                          #   TillgateError 基类 + 三性 + BusinessCode 品牌 + annotate()
  category.ts                        #   category 闭集（七项）+ CATEGORY_DEFAULTS + isErrorCategory
  definition.ts                      #   ErrorDefinition + defineErrorCatalog + composeErrorCatalogs
  error-record.ts                    #   ErrorRecord 联合 + recordOf + handlingOf + ROOT_ERROR_CODES
  normalize.ts                       #   normalizeError(unknown) 边界兜底
  guards.ts                          #   四个 instanceof 守卫
  index.ts                           #   出口桶（boundary.test 快照锁定，19 个值导出）

packages/http/src/errors/            # 渲染出口
  catalog.ts                         #   http.* 自有目录（校验/协议边界/PG 翻译族 + 通用文案）
  render.ts                          #   renderError + CATEGORY_STATUS_DEFAULTS + FaceOverride + errorBody
  handler.ts                         #   errorHandler（Hono onError：优先级链 + 信封 + Retry-After）
  sqlstate.ts                        #   PG SQLSTATE 六码翻译表（探测函数由 db 注入，ADR-0002）
  locale.ts                          #   Accept-Language/cookie → locale

packages/*/src/**/errors.ts          # 能力包自有目录（identityErrors / AccountsErrors / BillingErrors …）

apps/{client-api,admin-api}/src/http/error-face.ts   # compose 装配 + override 表
apps/gateway/src/http/…                              # OpenAI 面信封（kind → C 端码的出站翻译）
```

三个 app 的 v1 `error-map.ts`（AppError 类 + 翻译表 + BY_INSTANCE + PG_HTTP）在各自
迁移单元中删除（client-api 已落地，见 §8.2）。

---

## 4. 核心代码结构（v2 落地实况）

### 4.1 根契约包 `@tillgate/errors`

```ts
// nature.ts —— 三性根类 + 品牌身份码 + 传播注记
export type ErrorNature = 'business' | 'infrastructure' | 'defect';

export abstract class TillgateError extends Error {
  abstract readonly nature: ErrorNature;
  readonly code: string;            // 命名空间身份码（namespace.key）
  readonly context?: ErrorContext;  // 值域 = 递归只读 JSON（D9a）
  readonly retryAfterMs?: number;
  protected constructor(message, identity, opts?: { cause?; retryAfterMs? }) {
    super(message, /* cause */); this.name = new.target.name;   // 子类名即错误名（E12 修复）
  }
}
export class BusinessError extends TillgateError {
  readonly nature = 'business' as const; readonly category: ErrorCategory;
  constructor(init: BusinessErrorInit, context?, opts?) { … }   // 绑定构造（D8）
}
export class InfrastructureError extends TillgateError { /* DB/缓存/上游不可用 */ }
export class DefectError extends TillgateError { /* 不变量破坏：细节不外泄 */ }

/** 业务身份码品牌（D8）：唯一签发源是错误目录，自由字符串编译不通过 */
export type BusinessCode = string & { readonly [brand]: true };
/** 绑定定义：code + category + message 三元组只能整体来自目录 entry() */
export interface BusinessErrorInit { readonly code; readonly category; readonly message }

/** 传播注记（D9b）：外层补事实，实例稳定不包装；recordOf 按时间序合并、后写胜出 */
export function annotate<T extends TillgateError>(error: T, context: ErrorContext): T;
```

```ts
// category.ts —— 唯一处理契约，闭集七项（D4 增补 quota_exhausted），极稳定
export const ERROR_CATEGORIES = [
  'invalid_input',   // 调用方数据问题       → 4xx，不重试
  'not_found',       // 目标不存在           → 404
  'conflict',        // 状态/唯一性冲突      → 409，修正后可重试
  'forbidden',       // 资格/权限/状态不允许 → 401/403
  'quota_exhausted', // 资金/额度不允许      → 402（v1 注册表 8 个 402 码无处安放的审计证据）
  'rate_limited',    // 限流                 → 429，退避
  'unavailable',     // 依赖不可用           → 5xx，可重试 + 告警
] as const;
export const CATEGORY_DEFAULTS: Readonly<Record<ErrorCategory, { retryable: boolean; alert: boolean }>>;
```

```ts
// definition.ts —— 目录契约（D1-D3）：定义归能力包，丰富化随包分发
export interface ErrorDefinition {
  readonly category: ErrorCategory;
  readonly message: string;   // en，必填
  readonly zh: string;        // 中文，必填（结构性消灭 E8/E9）
  // 不含 HTTP status（D5）；不逐例覆盖 retryable（D5）
}
export function defineErrorCatalog(namespace, definitions): NamespacedErrorCatalog;
//   → { code(key): BusinessCode（品牌签发）; entry(key): CatalogEntry（冻结四元组）;
//       business(key, context?, opts?): BusinessError（受荐抛出路径）;
//       get/has/codes }
//   命名空间与 key 均须匹配 /^[a-z][a-z0-9_]*$/（单段小写蛇形，D2）；装配期校验，条目深冻结
export function composeErrorCatalogs(...catalogs): ErrorCatalog;   // face 装配；命名空间重复装配期失败（E6 修复）
```

```ts
// error-record.ts / normalize.ts / guards.ts —— 错误即数据
export type ErrorRecord = BusinessRecord | InfrastructureRecord | DefectRecord;
//   （business 分支必带 category——判别联合，处理侧无隐式回退；cause 链规范化，深度上限 10）
export function recordOf(error: TillgateError): ErrorRecord;
export function normalizeError(error: unknown): ErrorRecord;
//   外来 Error → defects 'errors.unhandled'；非 Error 值 → 'errors.non_error'（一律按缺陷）
export function handlingOf(record): { retryable; alert };
//   business 查 CATEGORY_DEFAULTS；infrastructure { true, true }；defect { false, true }——单点派生，无逐例覆盖
export const ROOT_ERROR_CODES = { unhandled, non_error, catalog_key_missing,
                                  catalog_key_invalid, duplicate_namespace };  // D6 根保留码
export const isTillgateError / isBusinessError / isInfrastructureError / isDefectError;
```

### 4.2 能力包目录与家谱（身份在目录/类定义处写死，throw 点只传业务事实）

```ts
// packages/identity/src/domain/errors.ts（实况示例；accounts/billing 同构）
export const identityErrors = defineErrorCatalog('identity', {
  invalid_credentials: { category: 'forbidden',  message: 'Invalid credentials', zh: '凭据错误' },
  identifier_taken:    { category: 'conflict',   message: '…', zh: '…' },
  // …目录封闭性由 __test__/errors.test.ts 快照锁死
});

// 受荐抛出：身份/分类/文案单点来自定义，动态事实进 context（本地化的结构前提）
throw identityErrors.business('invalid_credentials', { identifier });

// 高频错误固化类（家谱形态）：entry() 绑定定义，类与目录零漂移（D8）
export class InsufficientCashError extends BusinessError {
  constructor(needed: string, available: string) {
    super(BillingErrors.entry('insufficient_cash'), { needed, available });
  }
}
// subscription「单类多码」形态 = catalog.business(key) 直用，无需固化类
```

### 4.3 PG 源头分类（v2 按 ADR-0002 调整接缝）

v1 设计把 `classifyPg` 放在 repository；v2 落地为**翻译表归 http + 探测注入**：

```ts
// packages/http/src/errors/sqlstate.ts —— 六码翻译表（HTTP 边界语义：可预期拒绝不得伪装 500）
'SQLSTATE 23505' → http.pg_unique_violation (conflict)      // 唯一冲突
'SQLSTATE 23503' → http.pg_fk_violation      (invalid_input) // 引用不存在
// … 23514 / 22001 / 22P02 / 22003 → invalid_input 族

// errorHandler 的兜底分支（只兜未分类错误——已按三性分类的错误按自身身份出站）：
if (deps.sqlState !== undefined && !isClassifiedError(err)) {
  const rejection = pgRejection(deps.sqlState(err));   // pgSqlState 来自 @tillgate/db，装配注入
  if (rejection !== null) return render(rejection);
}
```

能力包 repository 层的**源头分类**纪律不变：检测到 PG 约束的业务语义时就地抛目录业务错误
（cause 链原始错误）；http 的 SQLSTATE 全局面兜底只接漏网（与 v1 语义一致：已映射错误最先命中）。

### 4.4 渲染出口 `http/src/errors/`（唯一出站分派）

```ts
// render.ts —— 错误即数据：渲染 ErrorRecord，不匹配错误类
export const CATEGORY_STATUS_DEFAULTS = { invalid_input: 400, not_found: 404, conflict: 409,
  forbidden: 403 /* 401/403 分歧走 override */, quota_exhausted: 402, rate_limited: 429,
  unavailable: 503 };                                     // errors 包零 status 的 http 侧补位
const HTTP_CODE_STATUS = { 'http.payload_too_large': 413, 'http.unauthorized': 401,
  'http.unsupported_media_type': 415 };                   // 协议语义分级优先于 category 默认

export function renderError(error: unknown, opts: { locale?; catalog?; overrides? }): RenderedError
//   status 解析链：face override > HTTP_CODE_STATUS > CATEGORY_STATUS_DEFAULTS[category]
//   business：目录查定义（miss = face 装配缺陷 → 按缺陷渲染兜底，原码落日志）；
//             message 按 locale 取 definition.message/zh；context/retryAfterMs 随行
//   infrastructure：503 + 身份码保留 + 通用文案（内部诊断不外泄）
//   defect/未知：500 + errors.unhandled + 通用文案（内外分际）

export function errorBody(rendered): { error: { code; message; context? } };  // 信封单一实现
```

```ts
// handler.ts —— Hono onError（边界优先级链，v1 语义保持）
//   坏 JSON → Hono 4xx HTTPException → PG SQLSTATE 兜底（探测注入）→ renderError 分派
//   5xx 渲染时服务端日志（code + stack）；retryAfterMs > 0 → Retry-After 响应头（秒，向上取整）
export function errorHandler(deps: { catalog?; overrides?; sqlState?; logger? })
```

### 4.5 face 层（app 里剩下的全部）

```ts
// apps/client-api/src/http/error-face.ts（实况节选）
export const CLIENT_FACE_OVERRIDES: Readonly<Record<string, FaceOverride>> = {
  'identity.invalid_credentials':   { status: 401 },   // v1 401（category 默认 403 的统一改判）
  'billing.plan_disabled':          { status: 422 },   // v1 422 语义分级保留
  'client.oauth_state_expired':     { status: 410 },   // v1 410 Gone 族
  'client.oauth_callback_failed':   { status: 502 },   // v1 502（上游坏流）
  // …表驱动锁死于 app.test.ts；差异必须逐条带 v1 状态语义注释
};
export function clientErrorCatalog() {
  return composeErrorCatalogs(HttpErrors, identityErrors, AccountsErrors,
                              BillingErrors, clientErrors);   // client.* = app 编排期目录
}
// app.ts：errorHandler({ catalog: clientErrorCatalog(), overrides: CLIENT_FACE_OVERRIDES, sqlState, logger })
```

app 亦可经 `defineErrorCatalog` 声明**编排期目录**（跨能力流程的协议级拒绝，如
`client.captcha_required`）——v1 裸码的命名空间化。

### 4.6 会话校验错误（v2 落地取舍）

v1 设计提出 `AuthError(reason)` + middleware 消费；v2 实际落地为**两层**：

- identity 内部：`SessionVerifyResult = { ok: true, payload } | { ok: false, reason:
  'invalid_token' | 'token_expired' | 'realm_mismatch' }`——失败原因保留在内部面，
  jose 验签层可区分；
- 校验链 `validateSession` 对 app 暴露 **silent null**（验签 → jti 黑名单 fail-open →
  锚点线），app 中间件（`apps/client-api/src/http/middleware/session.ts`）统一抛
  `http.unauthorized` → 401 单码——防枚举在 face 表达，内部 reason 走 identity 日志。

即：v1 铁律 6（内外分际）不变；「内部不吞原因」由 SessionVerifyResult 的内部判别承担，
而非 wire 面 AuthError。

---

## 5. 各模块使用规范

| 模块 | 怎么用 | 禁止 |
|---|---|---|
| **errors 包** | 零依赖叶子；三性 + category + 目录契约 + ErrorRecord + 守卫 + annotate | 认识任何业务/协议概念（零 status、零文案选择） |
| **能力包 domain/application** | 自有目录（defineErrorCatalog）+ `catalog.business()` 受荐抛出；高频错误 `entry()` 固化类；码带命名空间前缀 | import http；知道 status 存在；自由字符串作 code（品牌编译期拒绝，D8） |
| **repository（能力包 adapters）** | catch PG → 就地目录业务错误（cause 原始错误）；连接故障 → InfrastructureError | 把 PG 码泄漏到上层；宽 catch |
| **service/app 编排层** | 目录 `business()` 直用或家谱穿透；跨能力流程的协议级拒绝进 app 编排期目录 | 包装/改判 domain 错误；自带 status 数字 |
| **app 协议层（face）** | composeErrorCatalogs 装配 + override 表（差异必须带注释存在）+ errorHandler | 复制映射表；import 业务错误类做翻译（instanceof 拷贝） |
| **middleware** | 守卫（isBusinessError 等）精确捕获已知错误，其余穿透 | 宽 catch |
| **gateway（OpenAI 面）** | 出站翻译表：ai 的 `ErrorKind`/`circuitTrip` 语义 → OpenAI 错误信封；上游 4xx 原码透传（[ADR-0004](./adr/0004-upstream-4xx-passthrough.md)） | 第三份类拷贝 |
| **ai 包** | 自有 `ErrorKind` 封闭词表（零内部依赖，不 import errors）；与根契约映射 = ADR-0001 D7 表（消费方装配时应用） | 在 ai 内 import `@tillgate/errors` |

信封最终形态：`{ error: { code, message, context? } }`（+ `Retry-After` 响应头）。
`requestId` 由 request-context 中间件另行注入响应头，不进 error 信封。

---

## 6. 扩展工作流：新增一个错误

以"支付渠道已停用"为例（v2 实况）：

1. 能力包目录加一条：`BillingErrors` 定义中加
   `payment_channel_disabled: { category: 'conflict', message: 'Payment channel is disabled', zh: '支付渠道已停用' }`
2. 抛出点：`throw BillingErrors.business('payment_channel_disabled', { channel })`
   （或高频错误固化 `extends BusinessError` + `entry()`）

结束。品牌码编译期合法、双语文案就位、category 决定默认 status 与处理语义、face 快照
自动覆盖。对比 v1：抄状态码、编文案、中文缺失、注册表查无此码——四处皆可漏；v2 中
E2/E8/E9 类缺陷是**编译期不可能**，不是约定。

---

## 7. 治理

1. **兼容性规则**：wire code 登记即冻结。新增码安全；改含义/改默认 status = 破坏性变更，
   必须同步 wire 快照测试；退役码永不复用。v2 身份码单轨小写（点分命名空间），无大小写
   转换层（D2）。
2. **守卫测试**（范围随 D8 收窄，随第一个消费者迁移单元落地，不预建空壳）：
   - 目录 namespace 归属校验（能力包命名空间不得使用 `errors` 根命名空间）；
   - `as BusinessCode` 强转违规扫描（品牌绕过的刻意违规兜底）；
   - face override 差异逐条带注释（两 console face 的差异显式化）；
   - wire 快照冻结（迁移期验证对外字节不变）。
3. **词表封闭双锁**：category 闭集 = 编译期 union + 测试硬编码对照；errors 出口面快照
   （boundary.test）锁定 19 个值导出；ai 的 `ErrorKind` 与 `KIND_MECHANICS` 同款双锁。
4. **可观测**：错误按 code 计数（命名空间维度告警认领）；context 与注记进结构化日志；
   message 永不含 PII/密钥。日志分级：business 不告警；infrastructure warn + 告警；
   defect error + 响铃（`handlingOf` 单点）。
5. **文档生成**：`scripts/generate-error-docs.ts` 渲染目录 → markdown 错误目录页
   （码/category/双语/命名空间），随第一个消费者迁移单元进 CI。

---

## 8. v2 落地结果（原「迁移路径/待拍板」的改写）

### 8.1 v1 阶段表 → 落地状态

| v1 阶段 | 内容 | v2 状态 |
|---|---|---|
| P0 冻结 | wire 契约快照 | 已随各 app face 落地表驱动测试（如 client-api app.test 的 override 锁死） |
| P1 根契约 | 新建 `packages/errors` | ✅ 七文件 + 出口快照锁定，四门全绿（IMPLEMENTATION.md §7） |
| P2 重组注册表 | http 拆域文件 + render.ts | ✅ 形态调整：**不再集中注册表**——http 只留 `http.*` 自有目录 + category 默认渲染（ADR-0001 D1） |
| P3 家谱/PG | domain 家谱 + repository 源头分类 | ✅ 能力包目录已落（identity/accounts/billing…）；PG 翻译表归 http + 探测注入（ADR-0002，非 v1 的 repository classifyPg） |
| P4 迁移 throw 点 | 98 个 AppError 调用点 | ✅ 随垂直用例迁移完成；AppError 退役（client-api face 已无 instanceof 翻译表） |
| P5 瘦身 app 层 | 删三份 error-map.ts → face | ✅ client-api `error-face.ts`（compose + override 表）实况；admin-api/gateway 同构 |
| P6 治理 | 守卫三件套 + 文档生成 | 部分：目录/出口/override 快照已锁；全仓 throw 点扫描与 gen-error-docs 随首个消费者单元补齐 |

### 8.2 现状（v1）→ 目标（v2）映射结果

| v1 | v2 去向（实况） |
|---|---|
| 3× AppError 类 | `BusinessError` 直用 / 能力包目录 `business()` |
| wallet/subscription 家谱 | 能力包目录 + `entry()` 固化类（extends BusinessError） |
| WalletInvariantError | DefectError |
| SUBSCRIPTION_HTTP / BY_INSTANCE（×2） | CATEGORY_STATUS_DEFAULTS + face override 表 |
| PG_HTTP + cause 链爬树 | http `sqlstate.ts` 翻译表 + db `pgSqlState` 探测注入（ADR-0002） |
| 3× error-map.ts | `renderError`/`errorHandler` + face ~百行（目录声明为主） |
| 98 个自由字符串码 | 点分命名空间目录码（品牌类型编译期封闭，D8） |
| validateSession 返回 null | 内部 SessionVerifyResult(reason) + face 统一 401（§4.6） |
| ai duck-typed 错误（E11） | ai 自有 `ErrorKind` 封闭词表 + 派生表；映射 ADR-0001 D7 |

### 8.3 v1「待拍板决策点」→ 落地结论

| # | v1 决策 | v2 落地 |
|---|---|---|
| 1 | `plan_disabled`/`plan_not_purchasable` 422 vs 400 | 422 保留：category=conflict（默认 409）+ face override `{ status: 422 }`（client face 实况）——语义分级经 override 显式化而非默认 |
| 2 | `RefKeyConflictError` wire code | `idempotency_conflict` 口径随迁移统一（conflict category + 命名空间码） |
| 3 | `user_not_found` 两面差异 | 保留两面差异：client face 用 override 把相关身份码改判 401（防枚举），admin face 走默认 404——差异必须逐条注释存在 |
| 4 | 信封新增字段时点 | 已落：context（business 且非空时随行）+ retryAfterMs（渲染为 Retry-After 头）；requestId 走响应头不进信封 |
| 5 | AuthError 日志分级 | 形态调整：reason 保留在 identity 内部面（SessionVerifyResult），identity 日志分级；wire 面单码（§4.6） |

### 8.4 v2 增量裁决（v1 未涉及，ADR-0001）

- **D7**：ai `ErrorKind` ↔ 根契约映射表（kind → nature/category）——两个封闭词表，
  消费方（inference/app face）装配时翻译。
- **D8**：`BusinessCode` 品牌 + `BusinessErrorInit` 绑定构造——E2/E8/E9 从守卫级升为编译期封闭。
- **D9**：context 放宽为只读 JSON（a）、`annotate()` 传播注记（b）、类型化错误通道裁决不做（c）。
- **边界快照**：errors 出口面（19 个值导出）与 `dependencies` 为空由 boundary.test 运行时断言。

---

## 附：本方案讨论过程中的关键结论索引（v1 结论 + v2 裁决）

- 会话校验移入 service、middleware 只做协议适配——已实施（v2：identity 校验链 + app 中间件）
- 错误码保持字符串，不采用数字码——受众与 i18n 决定（v2 沿用）
- 错误身份绑"意义"不绑"层"——重构不应改变错误身份（v2 沿用）
- 注册表是丰富化目录而非第二身份体系——v2 推进一步：目录签发身份（品牌），单一词汇表
- http 保持业务无关——任何包不得为错误翻译 import 业务包（v2 以 D1 归属调整落实）
- 处理语义单点派生（category 默认 / handlingOf），禁止逐例覆盖（v2 D5，与 ai KIND_MECHANICS 同构）
