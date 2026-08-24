# @tillgate/errors

> 内部错误根契约:三性根类 + category 闭集 + 命名空间错误目录 + 规范化错误记录——零业务/协议依赖的稳定叶子。
> 裁决:[ADR-0001](../../docs/adr/0001-errors-registry-ownership.md) · 设计基线 [DESIGN.md](./DESIGN.md) ·
> 施工图 [IMPLEMENTATION.md](./IMPLEMENTATION.md) · 完整使用文档（按角色的用法与示例）:[docs/usage.md](./docs/usage.md) ·
> 使用纪律:AGENT.md §11

一句话:**错误的身份与分类在抛出点定一次(目录),之后穿层透明传播;捕获只看
nature/category;渲染与日志只消费规范化记录。**

## 核心导出面

- 三性根类:`BusinessError` / `InfrastructureError` / `DefectError`(公共基类
  `TillgateError`)+ `annotate()` 传播注记(实例稳定:不包装、不改判、instanceof 不动)。
- category 七项闭集(`ERROR_CATEGORIES`:invalid_input / not_found / conflict / forbidden /
  quota_exhausted / rate_limited / unavailable)+ `CATEGORY_DEFAULTS`;处理语义
  (retryable / alert)由 `handlingOf` **单点派生**。
- 错误目录契约:`defineErrorCatalog`(能力包自有目录——码的唯一登记处,namespace =
  包名)+ `composeErrorCatalogs`(app face 装配,重复命名空间装配期失败);业务码
  `BusinessCode` 为品牌类型,自由字符串编译期被拒绝(ADR-0001 D8)。
- 规范化记录:`recordOf`(根契约错误 → 记录,含 cause 链)、`normalizeError`
  (任意 unknown 安全成录;外来一律按缺陷 `errors.unhandled`)。
- 守卫:`isTillgateError` / `isBusinessError` / `isInfrastructureError` / `isDefectError`。

## 快速开始(能力包三步)

```ts
// ① 定义目录(码的唯一登记处,随包分发)
export const BillingErrors = defineErrorCatalog('billing', {
  insufficient_cash: { category: 'quota_exhausted', message: 'Insufficient cash balance', zh: '现金余额不足' },
});
// ② 抛出(文案/分类/身份来自目录定义,动态事实进 context——值域为只读 JSON)
throw BillingErrors.business('insufficient_cash', { needed: '5.00', available: '3.00' });
// ③ 捕获方按 category 分派(不看类、不看层、不看 status)
catch (e) {
  if (isBusinessError(e) && e.category === 'quota_exhausted') { /* 提示充值/换档 */ }
  else throw e; // 未知穿透,禁止宽 catch
}
```

出站渲染归 `@tillgate/http` 的 `renderError`(category → 默认 status + face override),
本包不定义协议形态;defect / infrastructure 细节不出站,只进日志。

## 目录结构

```
src/
├── nature.ts       # 三性根类 + annotate + 品牌类型 BusinessCode
├── category.ts     # category 七项闭集与默认处理语义
├── definition.ts   # defineErrorCatalog / composeErrorCatalogs 目录契约
├── error-record.ts # ErrorRecord 规范化记录 + handlingOf 单点派生
├── normalize.ts    # normalizeError 边界归一(外来一律按缺陷)
├── guards.ts       # is* 守卫
└── index.ts        # 唯一公共出口(boundary.test.ts 快照锁定,19 个值导出)
```

## 装配

消费方:`apps/admin-api` / `apps/client-api` / `apps/gateway` / `apps/trace-receiver`
的 error face(`composeErrorCatalogs` 装配各能力包目录);同时是全部能力包
(db / http / accounts / identity / billing / control-plane / inference)的依赖底座。

## 治理与开发

词表(`ErrorCategory` 七项、根保留码 `errors.*`、ai 映射表)变更必须走 ADR-0001。

```bash
cd packages/errors
bun run typecheck && bun run lint && bun run test
```
