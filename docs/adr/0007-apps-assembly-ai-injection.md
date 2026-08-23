# ADR-0007: apps 装配面直依赖 `@tokenlens/ai` 注入 inference 的形态认可

> 状态：Accepted（P5 收口补档；总纲 §5.1「例外必须写 ADR，并增加架构测试」）
> 日期：2026-08-23
> 关联：[ADR-0006](./0006-ai-standalone-library.md)、
> [project-structure-refactoring.md §3.6/§5/§5.1/§5.3](../project-structure-refactoring.md)、
> [packages/inference/DESIGN.md §装配](../../packages/inference/DESIGN.md)、
> apps/{gateway,worker,admin-api} `__test__/architecture.test.ts`

## 背景

总纲 §3.6 的目标是「`inference` 是 `ai` 的唯一运行时装配消费方；apps 运行时代码
不直接 import `ai`」。落地时 `createInference` 的 facade 契约选择了**实例注入**
（`env.ai: Ai`，inference DESIGN §装配），于是三个后端 app 在装配面出现了
`@tokenlens/ai` 直接 import：

- `apps/gateway/src/assembly.ts`——`createAi` 构造实例注入 `createInference`；
- `apps/worker/src/assembly.ts`——同上（结算/生成任务轮询经 inference 消费）；
- `apps/admin-api/src/assembly.ts` + `src/adapters/upstream-probe.ts`——装配用
  `SUPPORTED_PROTOCOLS` 词表，并以 `createAi` 实现 control-plane 的 `ProviderProbe`
  port（app 自有 adapter，仅由 assembly 接线，§5.3 形态）。

§5.1 的 apps 依赖白名单（能力 facade、http、runtime、observability）不含 `ai`，
按总纲规则该例外必须 ADR + 架构测试双落地，本 ADR 补档。

## 决策

**认可「apps 装配面构造、inference 运行时持有」的注入形态**，边界如下：

1. `@tokenlens/ai` 的 import **只允许出现在两个位置**：
   a. `apps/*/src/assembly.ts`（唯一装配根）；
   b. app 自有 `src/adapters/*` 中**实现某能力包 port** 的 adapter 文件，且该
   adapter 仅被 assembly.ts 引用（§5.3 的 composition 角色，当前唯一实例是
   admin-api 的 upstream-probe）。
2. `Ai` 实例构造后只交给 `createInference`（或 port 实现），**业务路由/中间件/
   任务 handler 不得持有**；`inference` 仍是 `ai` 的唯一运行时消费方——注入不
   改变依赖方向（apps 不经 `ai` 做任何推理用例编排）。
3. 机器门禁：各 app 架构测试锁定「除上述两位置外，src 内不得出现
   `@tokenlens/ai` import」（gateway 已有；worker/admin-api 同款补齐，随本 ADR 落地）。

不选择「inference 内部 createAi」的原因：`ai` 的机制配置（guardUrl SSRF 策略、
logger、超时档位）是**进程级装配数据**，由 app 持有符合「环境变量读取与依赖装配
归 app」（总纲 §4.1）；若 inference 内部构造，这些参数就要经 inference facade
透传成配置面，接口反而变宽，且 admin-api 的探针 port 将无从取得 `createAi`。

## 备选方案与取舍

| 方案 | 取舍 |
|---|---|
| inference 内部 createAi（§3.6 字面形态） | facade 需暴露 ai 机制配置面；探针 port 仍要单独开口；装配数据上移能力包违反 §4.1——否决 |
| 经 `@tokenlens/ai/composition` 子入口 | composition 子入口是能力包装配契约（§5.3）；`ai` 是零依赖库不是能力包，加 composition 是仪式化——否决 |
| apps 完全不接触 ai（无例外） | 与「实例注入」契约冲突，需重写 inference facade 与三个 app 装配——无对应收益，否决 |

## 影响

- 本 ADR 是 §3.6「apps 运行时代码不直接 import ai」的**窄例外**：装配面除外，
  运行时业务代码仍然禁止；例外范围如需扩大（例如更多 app adapter 直接用 ai），
  必须修订本 ADR 并同步架构测试。
- trace 侧的后续接线（如 ai 的 `tracer` 钩子启用）发生在 app 装配面，不改变本裁决。
