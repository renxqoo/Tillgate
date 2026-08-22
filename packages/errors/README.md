# @tokenlens/errors 使用文档

> 内部错误根契约：三性根类 + category 闭集 + 命名空间错误目录 + 规范化记录。
> 零内部依赖的稳定叶子；本文件是**唯一**的使用文档。
> 裁决与词表治理：[ADR-0001](../../docs/adr/0001-errors-registry-ownership.md)；
> 设计基线：[DESIGN.md](./DESIGN.md)；谁必须/禁止使用：AGENT.md §11。

一句话：**错误的身份与分类在抛出点定一次（目录），之后穿层透明传播；
捕获只看 nature/category；渲染与日志只消费规范化记录。**

---

## 1. 快速开始（能力包三步）

```ts
// ① 定义自有目录（码的唯一登记处，随包分发；namespace = 包名）
export const BillingErrors = defineErrorCatalog('billing', {
  insufficient_cash: { category: 'quota_exhausted', message: 'Insufficient cash balance', zh: '现金余额不足' },
  plan_disabled:     { category: 'conflict',        message: 'Plan is disabled',         zh: '套餐已停售' },
});

// ② 抛出（默认路径：文案/分类/身份来自定义，动态事实进 context）
throw BillingErrors.business('insufficient_cash', { needed: '5.00', available: '3.00' });

// ③ 捕获方按 category 分派（不看类、不看层、不看 status）
catch (e) {
  if (isBusinessError(e) && e.category === 'quota_exhausted') { /* 换渠道/提示充值 */ }
  else throw e;
}
```

## 2. 按角色的完整用法

### 2.1 抛出业务拒绝（domain / service）

**路径 A——目录直抛（默认，覆盖绝大多数抛出点）：**

```ts
throw BillingErrors.business('insufficient_cash', { needed: '5.00', available: '3.00' });

// 原始错误链（不包装改判）与重试提示：
throw BillingErrors.business(
  'settle_exceeds_hold',
  { held: '5.00', requested: '6.00' },
  { cause: pgError, retryAfterMs: 3000 },
);
```

**路径 B——固化类（仅两种情形：需要 `instanceof` 精确捕获；或构造器要强制上下文形状）：**

```ts
export class InsufficientCashError extends BusinessError {
  constructor(needed: string, available: string) {
    super(BillingErrors.entry('insufficient_cash'), { needed, available });
  }
}
```

`entry()` 保证类与目录零漂移。**没有路径 C**：`BusinessCode` 品牌类型使自由字符串码
编译不通过（ADR-0001 D8）；`as BusinessCode` 强转属违规，由守卫扫描。

**context 值域为递归只读 JSON**（D9a）——结构化校验事实直接入：

```ts
throw BillingErrors.business('invalid_amount', {
  fields: [{ path: 'amount', reason: 'not a decimal' }],
});
```

### 2.2 基础设施 / 缺陷（db / runtime，检测点就地分类）

```ts
throw new InfrastructureError('database unavailable', 'db.unavailable', { state }, { cause: e });
throw new DefectError('double-entry invariant broken', 'ledger.invariant', { entryId });
```

二者的码为自由字符串（无目录——按设计走通用渲染，不出站身份）；协议细节（PG
SQLSTATE 等）在源头翻译完，不向上泄漏。

### 2.3 传播途中补事实（service / middleware）

```ts
catch (e) {
  if (isBusinessError(e)) throw annotate(e, { requestId, channelId });
  throw e;
}
```

`annotate` 实例稳定（符号键、非枚举）：不包装、不改判、instanceof 不动；
`recordOf` 按「构造上下文为底 + 注记时间序、后写胜出」合并（D9b）。

### 2.4 捕获（middleware / 编排层）

```ts
try {
  await next();
} catch (e) {
  if (isBusinessError(e)) {
    // 按 category 七选一分派；rate_limited 读 e.retryAfterMs 退避
  } else if (isInfrastructureError(e)) {
    /* 可重试 */
  } else if (isDefectError(e)) {
    /* 不重试、响铃；细节只进日志 */
  } else throw e; // 未知穿透，禁止宽 catch
}
```

| 场景（判据：调用方该怎么办） | category          |
| ---------------------------- | ----------------- |
| 调用方数据有问题             | `invalid_input`   |
| 目标不存在                   | `not_found`       |
| 状态/唯一性冲突              | `conflict`        |
| 资格、权限、状态不允许       | `forbidden`       |
| 钱、额度、配额维度不允许     | `quota_exhausted` |
| 限流，退避后可重试           | `rate_limited`    |
| 依赖不可用/自我保护拒流      | `unavailable`     |

### 2.5 face 装配（app assembly）

```ts
const APP_ERRORS = composeErrorCatalogs(BillingErrors, IdentityErrors /* … */); // 重复命名空间装配期失败
APP_ERRORS.get(e.code); // → { category, message, zh } 双语文案按码取
```

status 默认值与信封归 `@tokenlens/http` 的 `renderError`（category → 默认 status +
face override）；face 不 import 业务包。

### 2.6 日志 / 告警

```ts
const record = normalizeError(thrown); // 任意 unknown 安全成录；外来一律按缺陷 errors.unhandled
handlingOf(record); // { retryable, alert } —— 单点派生
recordOf(ours); // 根契约错误 → 记录（含 cause 链，深度上限 10）
```

错误按 code 计数（namespace 即 owner 维度）；defect 细节只进日志关联 requestId。

## 3. 新增一个错误的完整流程

1. 目录加一行：`channel_disabled: { category: 'conflict', message: '…', zh: '…' }`
2. 抛出点：`business('channel_disabled', { channel })` 或固化类

结束——码合法性、双语文案、分类正确性由编译期（品牌）与装配期（校验）保证，
无需在任何映射表或 face 重复登记。

## 4. 禁止清单（每条有结构或守卫兜底）

- 自由字符串业务码 / 散参构造（编译封死，D8）
- 调用点覆盖文案与分类（绑定构造，D8）
- 包装、改判他人错误（用 `opts.cause` 链）
- 捕获点按错误类、层、status 分派（只看 nature/category）
- defect / infrastructure 细节进响应（通用文案渲染归 http；内外分际）
- `retryable` 逐例声明（不存在该 API；`handlingOf` 单点派生）
- context 放函数、类实例等非 JSON 值（值域为只读 JSON，D9a）

## 5. 词表治理

`ErrorCategory`（七项）、根保留码 `errors.*`、ai 映射表（ADR-0001 D7）三处变更必须
走 ADR；出口面（19 个值导出）由 `__test__/boundary.test.ts` 快照锁定。
