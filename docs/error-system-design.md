# 错误体系重构方案（Error System Design）

> 状态：设计定稿待评审 · 2026-08-22
> 范围：全仓错误体系（`packages/errors` 新建、`packages/http` 重组、domain/repository/identity 改造、三个 app 协议层瘦身）
> 原则依据：[engineering-principles.md](./engineering-principles.md)；本方案是对该原则在错误域的落地

---

## 1. 背景与问题诊断

### 1.1 现状

- `packages/http/src/error-codes.ts`：集中注册表（code → status + 中英文案），自称"单一真相"，但只对 `HttpError` 编译期强制。
- 三个 app 各有一份 `http/error-map.ts`：各自定义 `AppError` 类（三处拷贝）+ domain 错误翻译表。
- service 层抛 `AppError(status, code, message)`：code 为自由字符串，全仓共 **98 个**，未登记的码静默丢失中文文案。
- `validateSession` 等校验逻辑以 `return null` 吞掉失败原因，生产排障无据可查。

### 1.2 漂移证据（client-api vs admin-api 同名表）

admin 的 `SUBSCRIPTION_HTTP` 注释声称"与 client-api 同一分级口径"，实际：

| domain 错误 | client-api | admin-api |
|---|---|---|
| `user_not_found` | 401 `unauthorized` | 404 `user_not_found` |
| `plan_disabled` | 422 | 400 |
| `plan_not_purchasable` | 422 | 400 |
| `RefKeyConflictError` | 409 `ref_key_conflict` | 409 `idempotency_conflict` |

另有能力漂移：admin 有 PG 约束码翻译与 `HttpError` 感知，client 均无。

### 1.3 已否决的方案及理由

| 方案 | 否决理由 |
|---|---|
| 微信式数字错误码（40001…） | 受众是自家前端而非第三方集成商；字符串码自解释、可作 i18n 主键；gateway OpenAI 兼容面用蛇形码，数字码打架 |
| `DomainError`/`ServiceError` 按层命名错误 | 层身份回答"谁的错"，处理需要的是"什么性质的错"；代码在层间流动（如会话校验从 middleware 移入 service）会改变错误身份，契约不稳定 |
| `api-face` 桥包 | instanceof 匹配错误类的拐杖；错误携带数据后无人需要 import 业务包做错误翻译，桥包失去存在理由 |
| `validateSession` 返回 `null` | 内外部关注点混同：对外统一 401（防枚举）不要求内部不区分原因；且宽 catch 风险下 DB 故障会伪装成 401 |

---

## 2. 设计原则

错误的四个正交信息轴，各归其位，不得混淆：

| 轴 | 回答 | 载体 |
|---|---|---|
| 来源（谁的错） | 日志去哪查 | code 命名空间前缀 + 堆栈 + 注册表 owner 字段 |
| 性质（什么性质的失败） | 调用方该怎么办 | **category（唯一处理契约，闭集）** |
| 具体身份（哪个错误） | 前端展示什么 | **code（命名空间身份码，注册表键）** |
| 呈现（这个面怎么渲染） | 出什么状态码/文案 | face 层（renderError + override 表） |

六条铁律：

1. **三性分根**：错误本质只有三种——业务拒绝（预期内）/ 环境故障（可重试）/ 缺陷（不变量破坏）。这是唯一有资格成为根类的区分。
2. **category 是唯一处理契约**：catch 站点与协议出口只对 category 分派，不对错误类、不对层、不对 status 分派。
3. **code 即身份**：身份码由业务上下文自有（随包分发），注册表做**丰富化**（status/双语/retryable/owner）而非再定义。注册键 === `BusinessError.code`。
4. **源头分类**：谁检测谁分类，之后穿层透明传播；任何层不得重新包装他人错误（链用 `cause`）。PG 错误在 repository 就地分类，协议层不碰 PG 码。
5. **错误即数据**：身份与分类是错误自带字段，face 渲染数据而非匹配类型；新增 API 面零业务 import。
6. **内外分际**：内部诊断字段（reason 等）只进日志不进响应；对外失败语义由 face 决定，防枚举场景（会话校验）对外永远单码。

---

## 3. 目标架构

### 3.1 依赖方向（全单向）

```
errors（根契约包，零依赖叶子）
  ↑                ↑                 ↑               ↑
domain          repository        identity         service
（家谱 extends    （PG 源头分类）   （AuthError）    （编排拒绝 BusinessError）
 BusinessError）
  └────────────────┴─────────────────┴───────────────┘
                          ↓
              http（注册表丰富化 + renderError 出口 + category→transport 默认）
                          ↓
              apps/* 与 gateway（薄 face：override 表 + onError + 信封）
```

`http` 保持业务无关（现状即如此，本方案不破坏）；没有任何包为了错误处理 import 业务包。

### 3.2 目录结构

```
packages/
  errors/                          # ★ 新建：根契约包
    src/
      category.ts                  #   category 闭集 + 语义默认（retryable/alert）
      natures.ts                   #   BusinessError / InfrastructureError / DefectError
      index.ts

  domain/src/*/errors.ts           # 家谱改造：extends BusinessError，身份固化在类定义处

  repository/src/
    pg-classify.ts                 # ★ PG 错误源头分类

  http/src/errors/
    registry/
      common.ts                    # 通用码
      auth.ts                      # AUTH_*
      billing.ts                   # WALLET_* / SUBSCRIPTION_* / PAYMENT_* / REDEEM_*
      admin.ts                     # 管理域码（渠道/模型/费率卡）
      gateway-face.ts              # 网关 OpenAI 面专用码
      index.ts                     # 合并 → ERROR_REGISTRY / KnownErrorCode / errorSpec()
    render.ts                      # 唯一出口分派（~40 行，零业务 import）
    localize.ts                    # 双语文案取用（沿用现有逻辑）

  identity/src/
    auth-error.ts                  # AuthError extends BusinessError

apps/
  client-api/src/http/error-face.ts   # 瘦身：override 表 + onError（~15 行）
  admin-api/src/http/error-face.ts    # 同构
  gateway/src/http/openai-face.ts     # OpenAI 信封渲染器

scripts/gen-error-docs.ts             # 读注册表渲染 markdown 错误目录（进 CI）
```

三个 app 现有的 `error-map.ts`（AppError 类 + SUBSCRIPTION_HTTP + BY_INSTANCE + PG_HTTP）**全部删除**。

---

## 4. 核心代码结构

### 4.1 根契约包 `@tokenlens/errors`

```ts
// category.ts —— 唯一处理契约，闭集，极稳定
export const ERROR_CATEGORIES = [
  'invalid_input',  // 调用方数据问题       → 4xx，不重试
  'not_found',      // 目标不存在           → 404
  'conflict',       // 状态/唯一性冲突      → 409，改后可重试
  'forbidden',      // 资格/权限/状态不允许 → 401/403
  'rate_limited',   // 限流                 → 429，退避
  'unavailable',    // 依赖不可用           → 5xx，可重试 + 告警
] as const;
export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];
export const CATEGORY_DEFAULTS: Record<ErrorCategory, { retryable: boolean; alert: boolean }>;

// natures.ts —— 三性根类
export interface ErrorContext { [k: string]: string | number | boolean | null }

export class BusinessError extends Error {
  constructor(message: string, code: string, category: ErrorCategory,
              context: ErrorContext = {}, opts?: { cause?: unknown }) {
    super(message, opts); this.name = new.target.name;
  }
}
export class InfrastructureError extends Error { /* DB/缓存/上游不可用 */ }
export class DefectError extends Error { /* 不变量破坏：细节不外泄 */ }
```

### 4.2 domain 家谱（身份在类定义处写死，throw 点只传业务事实）

```ts
// domain/src/wallet/errors.ts
export class InsufficientCashError extends BusinessError {
  constructor(needed: string, available: string) {
    super('Insufficient cash balance', 'WALLET_INSUFFICIENT_CASH', 'forbidden', { needed, available });
  }
}
// subscription"单类多码"形态亦合法：throw 点传 (code, category)；高频错误再固化成类
```

### 4.3 repository 源头分类

```ts
export function classifyPg(e: unknown): Error {
  const state = pgSqlState(e);   // 现有 core 基建
  if (state === '23505') return new BusinessError('Duplicate record', 'COMMON_CONFLICT', 'conflict', {}, { cause: e });
  if (state === '23503') return new BusinessError('Invalid reference', 'COMMON_INVALID_REFERENCE', 'invalid_input', {}, { cause: e });
  if (state != null)     return new BusinessError('Constraint violated', 'COMMON_CONSTRAINT_VIOLATION', 'invalid_input', {}, { cause: e });
  return new InfrastructureError('database unavailable', { state }, { cause: e });
}
```

### 4.4 注册表（丰富化目录）

```ts
export interface ErrorSpec {
  status: number;        // 默认状态码（face 可 override）
  message: string; zh: string;
  retryable?: boolean;   // 缺省从 category 推导
  owner?: string;        // 归属分组：文档分章 + 告警认领
}
// 条目示例：
// WALLET_INSUFFICIENT_CASH: { status: 402, message: 'Insufficient balance', zh: '余额不足', owner: 'wallet' }
// 注册键大写蛇形 === BusinessError.code；wire 输出统一小写，转换只在 render 一处
```

### 4.5 唯一出口分派 `render.ts`

```ts
export interface FaceOverride { status?: number; code?: string }

export function renderError(e: unknown, opts: { locale: string; overrides?: Record<string, FaceOverride> }) {
  if (e instanceof BusinessError) {
    const spec = errorSpec(e.code);               // 守卫测试保证必登记
    const face = opts.overrides?.[e.code];
    return { status: face?.status ?? spec.status,
             code: (face?.code ?? e.code).toLowerCase(),
             message: localize(e, spec), context: e.context };
  }
  if (e instanceof InfrastructureError) return { status: 503, code: 'unavailable', message: 通用文案, retryable: true };
  if (e instanceof DefectError)         return { status: 500, code: 'internal_error', message: 通用文案 };
  return { status: 500, code: 'internal_error' };  // 未知一律按缺陷
}
```

### 4.6 face 层（app 里剩下的全部）

```ts
// apps/client-api/src/http/error-face.ts
const OVERRIDES = {
  // client face：用户自己的账号没了 = 会话失效（admin face 不覆盖 → 404）
  SUBSCRIPTION_USER_NOT_FOUND: { status: 401, code: 'AUTH_SESSION_INVALID' },
};
export function onError(error: unknown, c: Context) {
  const mapped = renderError(error, { locale: localeFromContext(c), overrides: OVERRIDES });
  return c.json({ error: { ...mapped, requestId: c.get('requestId') } }, mapped.status);
}
```

### 4.7 AuthError（identity 包）

```ts
export class AuthError extends BusinessError {
  constructor(public readonly reason:
    | 'token_invalid' | 'token_expired' | 'session_revoked'
    | 'account_unavailable' | 'session_invalidated') {
    super('Session invalid or expired', 'AUTH_SESSION_INVALID', 'forbidden', { reason });
  }
}
// middleware 消费：catch (e) { if (e instanceof AuthError) { log(e.reason); return 401 } throw e }
// reason 只进日志不进响应（防枚举）；instanceof 精确捕获，DB/Redis 故障穿透为 5xx
```

---

## 5. 各模块使用规范

| 模块 | 怎么用 | 禁止 |
|---|---|---|
| **errors 包** | 零依赖叶子；定义三性 + category + ErrorContext | 认识任何业务/协议概念 |
| **domain 包** | 家谱 extends BusinessError；身份码带命名空间前缀 | import http；知道 status 存在 |
| **repository** | catch PG → classifyPg 重抛；连接故障 → InfrastructureError | 把 PG 码泄漏到上层 |
| **service（packages/service）** | 编排拒绝 `throw new BusinessError(msg, CODE, category)` | 包装/改判 domain 错误 |
| **identity** | AuthError(reason)；翻译 SessionVerifyError 保留 reason | reason 进任何 wire 响应 |
| **app service 层** | 同 service：BusinessError 直用；domain 家谱穿透不上包 | 自带 status 数字；自由字符串码 |
| **app 协议层** | override 表（差异必须带注释存在）+ onError 接 renderError | 复制映射表；import 业务错误类做翻译 |
| **middleware** | `instanceof` 精确捕获已知错误，其余穿透 | 宽 catch |
| **gateway** | OpenAI 信封渲染器；AppError/注册表用共享的 | 第三份类拷贝 |

信封最终形态（additive）：`{ error: { code, message, context?, requestId } }`。

---

## 6. 扩展工作流：新增一个错误

以"支付渠道已停用"为例：

1. `registry/billing.ts` 加一行：`PAYMENT_CHANNEL_DISABLED: { status: 409, message: 'Payment channel is disabled', zh: '支付渠道已停用', owner: 'payments' }`
2. `payments.service.ts`：`throw new BusinessError('Payment channel is disabled', 'PAYMENT_CHANNEL_DISABLED', 'conflict', { channel })`

结束。类型联合自动含新码、双语文案就位、文档 CI 自动重生成、守卫测试自动覆盖。对比现状：抄状态码、编文案、中文缺失、注册表查无此码——四处皆可漏。

---

## 7. 治理

1. **兼容性规则**：wire code 登记即冻结。新增码安全；改含义/改默认 status = 破坏性变更，必须同步 frontend-contract 测试；退役码永不复用。注册键大写蛇形、wire 小写蛇形，转换只在 render。
2. **守卫测试三件套**：
   - 注册表守卫：全仓扫 `new BusinessError`（含 domain 包，跨包扫描）的 code 必须登记且 category 合法、码带命名空间前缀；
   - face 一致性：两 console face 的 override 差异必须逐条带注释（差异显式化）；
   - frontend-contract 快照：wire 全集冻结，迁移期验证对外字节不变。
3. **文档生成**：`scripts/gen-error-docs.ts` 渲染注册表 → markdown 目录页（code/status/双语/retryable/owner），进 CI，PR 里文档 diff 与代码同审。
4. **可观测**：错误按 code 计数（owner 维度告警认领）；AuthError.reason、BusinessError.context、requestId 进结构化日志；message 永不含 PII/密钥。
5. **日志分级**：`token_expired` 等日常 reason 记 debug；`session_revoked`/`account_unavailable` 记 info+；InfrastructureError 记 warn 并告警；DefectError 记 error 并响铃。

---

## 8. 迁移路径（每步独立可交付，测试始终绿）

| 阶段 | 内容 | 产出 |
|---|---|---|
| **P0 冻结** | frontend-contract 快照锁现有 wire 契约 | 安全网 |
| **P1 根契约** | 新建 `packages/errors`（三性 + category） | 零风险纯新增 |
| **P2 重组注册表** | 现 259 行 `error-codes.ts` 按域拆文件（纯搬家）+ `render.ts` 落地 | 出口逻辑就位 |
| **P3 家谱改造** | domain 各 errors.ts extends BusinessError（加 code/category）；repository 接 pg-classify | 源头分类就位 |
| **P4 迁移 throw 点** | 98 个 AppError 调用点机械迁移（大小写归一后多数已在注册表；缺的补登记并补齐中文） | AppError 退役 |
| **P5 瘦身 app 层** | 删三份 error-map.ts → error-face.ts / openai-face.ts；**同此产出漂移 reconcile 清单逐条拍板**（见 §9） | 三份拷贝消亡 |
| **P6 收紧与治理** | 守卫测试三件套上线；信封加 requestId/context；文档生成脚本 | 长效机制 |

### 现状 → 目标映射

| 现状 | 去向 |
|---|---|
| 3× AppError 类 | BusinessError 直用 |
| wallet/subscription 家谱 | extends BusinessError + code/category |
| WalletInvariantError | DefectError |
| SUBSCRIPTION_HTTP / BY_INSTANCE（×2） | 注册表 status + face override |
| PG_HTTP + cause 链爬树 | repository pg-classify |
| 3× error-map.ts | render.ts + face ~15 行 |
| 98 个自由字符串码 | 命名空间码进注册表 |
| validateSession 返回 null | AuthError(reason)，middleware 统一 401 |

---

## 9. 待拍板决策点

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| 1 | `plan_disabled` / `plan_not_purchasable` 状态码 | 422（client 现状）vs 400（admin 现状） | 422（语义分级更准：状态不允许而非格式错误） |
| 2 | `RefKeyConflictError` wire code | `ref_key_conflict` vs `idempotency_conflict` | `idempotency_conflict`（与同族错误一致） |
| 3 | `user_not_found` 分歧 | 保留两面差异（override 显式化） | 保留——两面语义都正确 |
| 4 | 信封新增字段时点 | P6 或暂缓 | P6 一起（additive 无风险） |
| 5 | AuthError 日志分级 | reason 分级 or 统一 info | 分级（§7.5） |

---

## 附：本方案讨论过程中的关键结论索引

- 会话校验移入 service、middleware 只做协议适配——已实施（本方案前置改造）
- 错误码保持字符串，不采用数字码——受众与 i18n 决定
- 错误身份绑"意义"不绑"层"——重构不应改变错误身份
- 注册表是丰富化目录而非第二身份体系——code 单一词汇表
- http 保持业务无关——任何包不得为错误翻译 import 业务包
