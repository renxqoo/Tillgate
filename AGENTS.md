# Tillgate Agent Guide

Tillgate 是 TypeScript/Bun monorepo，提供 OpenAI 兼容的多供应商 LLM 网关、
控制台、账号、计费、通知与可观测能力。

## 事实来源

- 当前代码、测试、`package.json` 和工具配置是当前行为的唯一事实。
- README、DESIGN、ADR、注释和任务说明只能提供线索，不能代替对实现与测试的核对。
- 文档与代码冲突时，不得猜测目标行为；报告具体差异，按用户本次授权处理。
- 不得猜测脚本名、导出、环境变量、错误码、数据库字段或 HTTP 契约；使用前必须在仓库中查到定义和现有用法。


## 开始修改前

1. 运行 `git status --short`，识别已有修改；他人的工作不回滚、不格式化、不提交。
2. 读受影响 workspace 的 `package.json`、`vitest.config.ts` 和现有 architecture 测试。
3. 列出受影响面：公共导出、HTTP/DTO、持久化、配置、异步任务、前端入口和测试。
4. 复用仓库内已有模式。不为局部问题引入新框架、新依赖或并行架构。

## 代码地图

- `apps/gateway`：推理公网入口，处理协议、鉴权、限流和装配。
- `apps/admin-api` / `apps/client-api`：Hono HTTP 接口与能力装配。
- `apps/admin` / `apps/client`：Next.js 前端；业务请求经 `@tillgate/api-client`，公共 UI 经 `@tillgate/ui`。
- `apps/worker`：BullMQ 与定时后台任务。
- `apps/trace-receiver`：OTLP 接收与批量写入。
- `packages/billing`：钱包、账本、计价、订阅、支付、结算与恢复。
- `packages/accounts` / `identity`：账号与身份能力。
- `packages/inference` / `ai` / `control-plane`：推理编排、上游协议与模型/渠道配置。
- `packages/notifications` / `observability`：通知 outbox 与观测能力。
- `packages/db` / `errors` / `http` / `runtime`：数据库、错误、HTTP 和运行时基础设施。
- `packages/api-client` / `ui`：前端可消费的 API 客户端与设计系统。

## 边界与写法

- packages 不得依赖 apps；workspace 依赖图必须无环。
- 跨 workspace 导入必须命中目标 `package.json#exports`；禁止 `@tillgate/x/src/*`
  与越出 workspace 根的相对导入。
- `gateway` / `admin-api` / `client-api` 的 routes 位于 `src/http/routes`，只处理协议、
  中间件、调用能力面与响应组装；不在 route 内写 SQL 或构建基础设施。
- 分层能力包使用 `domain` / `application` / `ports` / `adapters`；SQL 实现在
  `adapters` 的现有 Postgres 实现中，表定义在 `packages/db/src/schema`，事务编排可在 application 使用
  `@tillgate/db` 提供的原语。
- 不是所有包都使用同一目录形状。简单包与专用协议包保持已有结构；不得为了形式统一强行搬层。
- 每个分层包的 import 白名单不完全相同，以该包 `architecture.test.ts` 为准；修改边界时同步更新契约测试。
- 根入口只导出消费方所需的稳定面。Postgres 适配器、store 和装配细节放在已有
  `./composition` 子入口或 app 装配层，不随意扩大根导出。
- 优先使用函数、显式 `env`/`deps` 与结构化返回值。只在已有真实多态边界中继续使用 class。
- 新建文件使用 kebab-case。代码注释使用中文，只解释契约、不变量或非显然约束，不复述代码。
- 遵守 TypeScript strict：使用 `unknown` 并收窄，禁止显式 `any`、非空断言、
  `@ts-ignore` 和 `@ts-nocheck`；类型导入使用 `import type`。
- 部署可变值在对应 app `src/config.ts` 中用 zod 解析，再由 assembly 注入。
  新配置必须同时核对消费方、配置测试和 `.env.example`。
- 能力包的业务错误沿用其 `defineErrorCatalog` 目录，并提供英文 `message` 与中文 `zh`。
  `throw` 的 message 使用英文；动态事实放 `context`/日志，不在抛出点自造本地化文案。
- `packages/ai` 保持自有的上游错误契约，不得为了表面统一强制引入 `@tillgate/errors`。
- 前端先搜索 `@tillgate/ui` 已有组件、hooks 和 formatting 子路径。可复用的通用组件放入 UI 包；
  UI 包不引入 Next.js 专有依赖。
- 遇到有bug、逻辑错误代码，如果阻塞当前任务流程，请及时停下来反馈，非阻塞在当前任务结束报告。


## 高风险路径

- `packages/billing` 是资金与计费事实源。修改前跟完整调用链，核对精度、币种、幂等键、
  事务、并发认领、重试、结算与恢复路径。金额沿用现有 Decimal/十进制字符串模型，
  不引入浮点运算。
- 修改流式、用量或上游协议时，同时核对 `ai` 适配器/事件、`inference` 编排和
  `gateway` 响应路径，保留取消、截断、超时、错误转换与 usage 证据。
- 修改 HTTP DTO、公共导出、错误码、数据表、事件或环境键时，逐个搜索并处理所有生产者、
  消费者、测试和导出面。数据库 schema 变更必须配套 `packages/db/migrations` SQL。
- 迁移收口后只保留一套实现。普通重构不引入无期限的旧路径别名、双轨字段或参数双收。
  实施前必须明确兼容窗口、观测指标、删除条件和回滚路径，切换完成后立即恢复单轨。
  删除整包或整个应用前，先开 issue 列出清单并等待维护者确认。
- 不得用隐式默认、静默 catch、无限期兼容双轨或同步外部调用掩盖一致性缺口。
- 范围外缺陷只报告证据与影响。只有与当前任务直接相关且可低风险修复时，才随同
  补回归测试。

## 禁止操作

- 不写 TODO 实现、占位返回、假成功或未被调用的接口；未完成的行为不得声称已完成。
- 不要在业务代码中写mock数据
- 不要在底层代码写固定常量
- 不通过修改 `.oxlintrc.json`、降低 coverage threshold、扩大 ignore 或把代码搬入
  `generated`/`migrations` 来换取门禁通过。
- 不提交临时计划、研究笔记、调试输出、真实凭证或 PR 专用截图。
- 不在未明确授权时运行 real/e2e 外部调用、生产迁移、删库/卷、`docker compose down`
  或按名称模式批量终止进程。
- 不做任务外重构，不顺手修复无关文件，不自行创建 PR 或提交。

## 测试与验证

- 测试布局以对应 `vitest.config.ts` 为准。大部分 workspace 使用平铺 `__test__`；
  `packages/ui` 使用 `test/{unit,render,pack}`；e2e 按场景自持配置。
- 修复 bug 必须先补能在旧实现上失败的回归测试。契约变更必须覆盖正常、边界、无效输入和失败路径。
- 优先运行最小可信证明：相关测试文件、受影响 workspace 的 typecheck/lint/build、
  相关 architecture 测试。
- 完成代码改动前运行根四门：

  ```bash
  bun run typecheck && bun run lint && bun run test && bun run build
  ```

- 修改了可格式化文件时运行 `bun run format`，然后重跑受影响门禁。
- 覆盖率使用 `bunx turbo run test:coverage --concurrency=1`；阈值以各 workspace
  `vitest.config.ts` 为准，不降阈值。
- `*.real.test.ts` 与 `e2e/` 不属于默认门禁。只在任务相关、依赖和凭证完整时运行；
  选择命令前先读对应 package script 或场景 vitest 配置。
- 无法运行的验证必须明确列出命令、缺失条件和已完成的替代检查；不得用“应该通过”代替结果。

## 交付与提交

- 最终回复列出改动、已运行的验证及结果、未运行的条件型测试和已知风险。
- 只在用户明确要求时提交。`git add` 逐路径点名，禁止 `git add .`、`git add -A`、
  `git commit -a`；提交前核对 staged diff 只含本任务文件。
- commit 使用英文 Conventional Commits：`type(scope): subject`。一个提交只包含一个关注点。
- 提交代码到github优先使用本地代理网络
