# @tillgate/inference

> 推理用例:候选循环、路由调度、计费衔接与故障转移;渠道熔断/死凭据健康状态(AiEvent 订阅者,§3.6;单向依赖 @tillgate/ai)。
> 相关裁决:[ADR-0006](../../docs/adr/0006-ai-standalone-library.md)(ai 独立库)、[ADR-0007](../../docs/adr/0007-apps-assembly-ai-injection.md)(装配注入形态)

一句话:网关推理编排——预检 → `billing.authorize` → 候选循环(换渠道故障转移是本包
职责;单渠道内重试在 `ai`);同时是 `@tillgate/ai` 的**唯一运行时消费方**(§3.6:
apps 运行时代码不直接 import ai)。

## 核心导出面

- `createInference(env)` facade → `Inference`:
  `chat` / `stream`(判别联合返回;stream 含透传例外 `PassthroughDelivered`)、
  `generation`(submit / query / adminList / settledAmounts——video/music 异步生成任务)、
  `health`(装配诊断面)、`close()`(退订 ai 事件总线)。
- 端口注入(未建编译依赖,装配取件):`CatalogPort`(control-plane 只读目录)、
  `BillingPort`(billing 授权/收据)、`UpstreamPort`(缺省内置 ai 适配器)、
  `HealthStore`(redis / memory)、`GenerationTaskStore`(postgres / memory)、
  `admitChannel`(gateway 渠道维限流钩子,未装配 = 放行)。
- 渠道健康:`createChannelHealth`——熔断(breaker)+ 死凭据(dead-credential)状态机,
  **AiEvent 订阅者**(装配处挂一次);`channelHealthKey` / `BreakerState` 等契约。
- 收据与估算契约(billing 消费方):`UsageReceipt` / `ESTIMATE_ATTRIBUTIONS` /
  `streamEstimateAttribution`(中断流估算归因)、`buildCandidateChain`、
  `conservativeInputTokenUpperBound`(保守预估上界)。
- 适配器工厂(根入口):`createUpstreamAi` / `createRedisHealthStore` /
  `createMemoryHealthStore` / `createMemoryGenerationTaskStore` /
  `createPostgresGenerationTaskStore`;另有 `createGenerationPollUseCase`(worker
  生成任务轮询自愈)。
- 入站协议翻译转出口:completions / responses / claude / gemini 线格式 ↔ 规范形的
  纯函数自 `@tillgate/ai` 转发——app HTTP 面单一引用面。
- `InferenceErrors` 错误目录;`inferenceDefaultsSchema`(重试/熔断/死凭据缺省可覆写)。

## 目录结构

```
src/
├── inference.ts   # createInference facade:健康挂接 + 预检→authorize→候选循环编排
├── application/   # 用例层:chat/stream/failover(候选循环)/generation/generation-poll/quote
├── domain/        # 领域:model(候选/输出上限)、usage(收据/归因)、generation、errors
├── health/        # channel-health(熔断+死凭据,AiEvent 订阅者) + breaker + dead-credential
├── adapters/      # upstream-ai / state-redis / state-memory / task-memory / generation-pg
├── ports/         # catalog/billing/upstream/state/generation 契约
├── config.ts      # InferenceDefaults zod schema
└── index.ts       # 唯一公共出口
```

## 装配

消费方:`apps/gateway`(`createInference` 主装配——createAi 实例 + redis 健康存储 +
postgres 任务存储)、`apps/worker`(`createGenerationPollUseCase` 生成任务轮询)、
`apps/admin-api`(`createPostgresGenerationTaskStore` 管理读侧)。

## 开发

```bash
cd packages/inference
bun run typecheck && bun run lint && bun run test
DB_TEST_URL=postgres://... bun run test:real   # generation-pg.real.test.ts 真库门(缺 env 整组 skip)
```
