# ADR-0006: `ai` 保留为独立上游协议库——推翻初版「并入 inference」映射的裁决存档

> 状态：Accepted（P4 启动前补档；总纲 §3.5 必需 ADR 清单第 5 项）
> 日期：2026-08-23
> 关联：[project-structure-refactoring.md §2.3/§3.2/§3.6](../project-structure-refactoring.md)、
> [packages/inference/DESIGN.md](../../packages/inference/DESIGN.md)、
> [ADR-0007](./0007-apps-assembly-ai-injection.md)（装配注入形态）

## 背景

重构方案初版的 §3.2 映射曾倾向把 `ai` 并入 `inference`（「合并为 inference facade，
而不是继续增加桥接层」）。P4 推进前的复核（总纲 §2.3）确认 `ai` 的现状形态：

- **零内部依赖**：不依赖任何 `@tillgate/*` 包，自有 `ErrorKind` 封闭词表
  （ADR-0001 D7），是依赖图上的永久叶子。
- **库形态已验证**：`createAi` facade、`onEvent` 监听面（`subscribe`/`AiEvent`）、
  逐块透传中继（`pipeThrough` 不缓冲不改写）、旁路 SSE 扫描（usage 观察不进热路径）
  均已实现并有 365+ 单测/协议矩阵覆盖。
- **职责边界清晰**：单渠道内机制链（参数抹平 → 单次尝试 → 重试 → 透传）；
  候选循环、路由、quote、计费衔接、渠道健康全部在 `inference`。

## 决策

**`ai` 保留为独立库包（`packages/ai`），不并入 `inference`。** 初版映射按总纲
§3.2 现行文本（「保留为独立库包」）执行，本 ADR 存档该推翻裁决：

- 并入会把**已验证的库边界降级为目录边界**——`ai` 的消费者除了运行时装配
  （inference），还有协议矩阵测试、适配器探针与未来的独立发布候选（总纲 §7.2
  第三候选）；目录内聚会让这些消费面失去 exports 级契约保护。
- `inference` 单向依赖 `ai`（总纲 §5 依赖图）；熔断、死凭据等跨请求健康状态
  以 `AiEvent` 订阅者身份住在 `inference/health`，`ai` 保持零运维状态（§3.6）。
- 装配注入形态（apps 在 assembly 面 `createAi` 后注入 `createInference`）另见
  ADR-0007。

## 备选方案与取舍

| 方案 | 取舍 |
|---|---|
| 并入 inference（初版映射） | 单包内聚，但库/用例两种生命周期耦合；协议矩阵与发布候选失去独立边界——否决 |
| 保持独立 + 继续在 ai 内持有渠道健康注入存储 | 违反 §3.6 零运维状态（跨请求状态属路由消费方 inference）——已在 P4 排除 |
| 独立并立即公开发布 | 无真实外部消费者，提前承担兼容成本（总纲 §7.2「发布白名单初始为空」）——维持私有，发布候选资格保留 |

## 影响

- `packages/ai` 是永久私有叶子（发布候选另议）；`inference` 是其唯一运行时
  装配消费方，架构测试锁定该方向。
- ai 包不设 MIGRATION.md 的原因存档：它是「平移+重写」而非垂直用例迁移，
  其 IMPLEMENTATION.md 承担审计与验收记录职责。
- 后续 ai 包演进只允许强化 §3.6 契约（透传例外清单、onEvent 观察面、零运维
  状态），新增例外必须走 ADR。
