# 凭证前缀、契约与可读性门禁实施清单

> 状态：实现、本地验收与远端 PR CI 全部完成（2026-08-24）
> 设计基线：同目录 `DESIGN.md`

## 1. 实施切片

### A. 默认凭证词表迁移

- [x] client-api / admin-api / gateway 默认 `KEY_PREFIX=sk_` 且配置测试锁死。
- [x] accounts 生成、预览、识别测试统一 `sk_`，保留 `Sk_` 非法大小写边界。
- [x] BFF Cookie 常量、两端 server action、middleware/proxy 与测试保持存量兼容名。
- [x] OpenAPI、DTO、README、配置文档、e2e 装置同步。
- [x] 全仓默认 API Key 旧前缀扫描为零；Cookie 兼容名与任务无关的 `tag` 等标识符明确保留。

### B. 契约与类型修复

- [x] rate-card postgres/memory store 返回并刷新 `updatedAt`。
- [x] presenter、OpenAPI、生成 DTO 非空 ISO 字符串一致。
- [x] 金额输入和 DTO 继续使用十进制字符串。
- [x] observability 动态 group 查询通过类型检查且三种分组行为有测试。

### C. 嵌套三元门禁

- [x] 启用 `eslint/no-nested-ternary=error`。
- [x] 全部诊断清零；每处改写核对原求值顺序、短路和渲染结果。
- [x] 修复清理过程中暴露的既有 lint（函数作用域、未使用变量）。
- [x] 对已发现的显式 `null` token 回归补回行为并保持既有测试绿。

## 2. 验收

- [x] `bun run format:check` 通过。
- [x] `bun run typecheck` 通过。
- [x] `bun run lint` 通过。
- [x] `bun run test` 通过（21 workspace，包边界门禁同时通过）。
- [x] `bun run build` 通过（含两个 Next.js 生产构建）。
- [x] `bunx turbo run test:coverage --concurrency=1` 通过（34/34，阈值不变）。
- [x] `git diff --check` 通过，逐文件审计无意外机械替换。
- [x] 提交并推送，PR CI 全绿。

## 3. 已知迁移影响

- 未显式配置 `KEY_PREFIX` 的存量部署升级后默认识别前缀会变为 `sk_`；切换前必须决定
  继续固定 `ag_` 还是重新签发 Key 后原子切换。
- Cookie 名保持不变；API Key 默认前缀切换不会导致现有用户面、管理面会话失效。
