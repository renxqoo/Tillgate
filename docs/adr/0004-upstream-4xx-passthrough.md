# ADR-0004: 上游 4xx 错误原码透传（对总纲 §3.6「502/504 网关语义」的边界澄清）

> 状态：Accepted（2026-08-23 审计裁决：inference 4xx 透传实现与总纲文字口径冲突的消解）
> 日期：2026-08-23
> 关联：[project-structure-refactoring.md §3.6](../project-structure-refactoring.md)、
> [packages/inference/DESIGN.md](../../packages/inference/DESIGN.md)、
> [packages/inference/MIGRATION.md](../../packages/inference/MIGRATION.md)、
> [packages/inference/src/domain/routing/switchable.ts](../../packages/inference/src/domain/routing/switchable.ts)

## 背景

总纲 §3.6「错误出站三层」末尾写有：**「上游错误对外层用 502/504 网关语义（候选循环后
表达整次请求的失败，不透传单一上游状态码）」**。而 inference 的实际实现
（v1 run-chat 迁移而来的既定行为，行为规格由旧测试锁定）是：

- `domain/routing/switchable.ts routeFailure`：非可换渠错误且 `status ∈ [400, 500)`
  → `respond` 透传终局；
- `application/failover.ts dispatchFailure`：4xx = 上游确定未计费 → `request_failed`
  三路释放后**原码返回**（`PassthroughDelivered.status` = 上游 4xx 原值，
  message 为脱敏后的上游原文）。

两处口径文字相抵：若按总纲字面执行，4xx 会被吞成 502，客户端拿不到自己的参数错误
（如 400 invalid_request、404 model_not_found、413 context_overflow），还会空耗
fallback 候选——同一份坏请求换渠道必然再失败一次。

## 决策

按错误定位拆分对外语义，而非一刀切 502/504：

1. **上游 4xx = 客户端错误定位，保留原状态码透传**。候选循环对 4xx 立即终局
   （不换渠、不换候选、不空耗 fallback）；脱敏后的上游 message 随行
   （内容层保留原文、仅脱敏——§3.6 三层纪律不变），原码进入
   `PassthroughDelivered.status`。透传仍不免收尾：`request_failed` 信号先行
   （上游 4xx = 确定未计费）。
2. **上游 5xx / 网络类错误 = 网关语义 502/504**。这类错误换渠有意义（候选循环消费），
   全败后对外统一 `upstream_failed`（502）；网关自生错误（余额不足、平台限流等）
   照旧经 app 层 error-face 用同一 OpenAI 信封表达。
3. 总纲 §3.6 该句的适用范围据此**收窄为「非 4xx 上游错误」**：502/504 表达的是
   「候选循环后整次请求失败」，不覆盖「上游对客户端请求的确定性拒绝」。

## 备选方案与取舍

| 备选 | 取舍 |
| --- | --- |
| 严格按总纲字面：一切上游错误吞成 502/504 | 否决——破坏 v1 既定且被旧测试锁定的行为规格（行为等价铁律 7）；客户端无法区分「自己的请求坏」与「网关/上游坏」，429/400 重试语义失真；且 4xx 换渠空耗 fallback 增加时延与上游负载。 |
| 4xx 也换渠，全败后取最后一次 4xx 原码返回 | 否决——同一坏请求在每个渠道重复失败（invalid_request 换渠道不会变好），fallback 的存在意义是渠道面故障，不是参数错误；v1 已裁决不空耗。 |
| 按状态码白名单透传（仅 400/404/413 等） | 否决——白名单是第二真相，上游新增 4xx 语义（如 422、451）即漂移；`[400, 500)` 区间判定 + 可换渠词表先行（429/401 归一码在换渠词表内，先于状态码判定）已是封闭规则。 |

## 影响

- inference 的 4xx 透传实现是**规范形态**而非违规；DESIGN §1.2 / MIGRATION §4 的
  「4xx 原码透传」表述以本 ADR 为准。
- 总纲 §3.6 的「上游错误对外层用 502/504」一句维持原文但适用范围收窄（见决策 3），
  不再与本实现相抵；新增「透传例外」仍必须走 ADR（本 ADR 是对既有例外清单第三种
  情形中错误体行为的澄清，不是新增改写例外）。
- app 层 error-face 渲染 `PassthroughDelivered` 时沿用同一 OpenAI 错误信封（结构层），
  细节层（内部端点、真实模型名）只进日志关联 requestId——三层纪律不受本 ADR 影响。
- 审计线：若未来出现「上游 4xx 但渠道面值得换」的新语义（如某些网关 401 实为渠道
  凭据问题），应经可换渠词表（switchable.ts 单一真相）扩展，不得绕过本 ADR 直接
  吞码。
