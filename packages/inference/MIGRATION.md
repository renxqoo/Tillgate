# inference 垂直用例迁移文档

> 状态：实施中 → 已核销（2026-08-23）
> 迁移单元：推理执行（候选循环/路由/故障转移/收据衔接）＋ 生成任务提交查询 ＋ 渠道健康状态
> 旧实现：`/Users/wrr/work/ai-getway`（apps/gateway src 约 10.8k 行中 pipeline/routing/quote/generation 约 1.9k 行；
> packages/ai 内 breaker/dead-credential/storages 约 0.4k 行；相关 domain rating/generation 约 0.9k 行）
> 目标位置：`packages/inference`
> 关联：DESIGN.md / IMPLEMENTATION.md / docs/project-structure-refactoring.md §3.6、§5.2、P4-4

## 1. 行为规格基线（旧测试 → 判定标准）

| 旧测试                                                          | 用例数 | 处置                                                     |
| --------------------------------------------------------------- | ------ | -------------------------------------------------------- |
| gateway `__tests__/pipeline.test.ts`                            | 24     | 改写 → failover/chat/stream.test.ts（OTel/限流断言剥离） |
| gateway `__tests__/quote.test.ts`                               | 5      | 改写 → quote.test.ts                                     |
| gateway `__tests__/output-cap.test.ts`                          | 3      | 移植 → output-cap.test.ts                                |
| gateway `routing/__tests__/{schedule,resolve-channels}.test.ts` | 5+3    | 移植/改写 → schedule.test.ts                             |
| gateway `generation/__tests__/generation.test.ts`               | 8      | 改写 → generation-app.test.ts                            |
| gateway `pipeline/__tests__/upstream-adapter.test.ts`           | 5      | 改写 → upstream-ai.test.ts                               |
| ai `test/unit/breaker.test.ts`                                  | 12     | 移植 → breaker.test.ts                                   |
| ai `test/unit/dead-credential.test.ts`                          | 10     | 移植 → dead-credential.test.ts                           |
| domain `rating/{attribution,receipt,measurement}.test.ts`       | 6+5+6  | 移植 → attribution/receipt/measurement.test.ts           |
| domain `generation/kinds.test.ts`                               | 4      | 移植 → generation.test.ts（domain）                      |
| service/billing、settlement、wallet、poll 全部                  | —      | 不迁（billing/worker 垂直，后续波次）                    |

删除的用例形态（非功能删除）：OTel span 属性断言、rate-limit 闸内联断言（归 app 中间件，B8）、
`repos.fx` 汇率快照断言（C2）、markDead 落库断言（C3，移交 control-plane）。

## 2. 审计引用

真 bug / 缺陷 B1–B10 与逐文件裁决见 IMPLEMENTATION.md §1/§2（证据：run-chat.ts:269/393-410、
channel.repo.ts:102-114、attempt-stream.ts:131-146、context.ts:16 等）。

## 3. API 对照（旧 → 新，节选）

| 旧签名                                                                      | 新签名                                                            | 变化理由                            |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------- |
| `createRunChat(deps)(ctx, auth, body, endpoint)`                            | `createInference(env).chat(input)`                                | facade 化（§5.3）；ctx/trace 归 app |
| `dispatchFailure(channel, error, status)`                                   | `domain/routing/switchable.ts routeFailure(error)`                | 纯函数化；词表 = ai ErrorKind       |
| `buildQuote(ctx, {model,userId,inputTokenUpperBound,maxOutputTokens,body})` | `CatalogPort.findMapping` + `application/quote.ts prepareRequest` | 目录查询 port 化；金额归 billing    |
| `billing.authorize/signal/reserveChannel`（service）                        | `ports/billing.ts BillingPort`（同动词）                          | 跨能力经 port（billing 未建包）     |
| `upstream.chat(channel, {realModel, externalModel, endpoint, body})`        | `UpstreamPort.chat(candidate, req)`（适配器注入凭据）             | 渠道快照+凭据注入收进 adapter       |
| `ai` 注入 `BreakerStorage/DeadCredentialStorage`                            | `HealthStore` + `health/channel-health.ts` 订阅者                 | §3.6 零运维状态（C4）               |
| `signal('request.succeeded'/'request.failed')`                              | `signal({type:'request_succeeded'/…})`                            | C5 蛇形词表                         |
| `estimateInputTokens/estimateTextTokens`（ai 导出）                         | `domain/usage/estimate.ts`（features+系数）                       | C1：v2 ai 不再公开 BPE              |
| `receipt.fxRate/fxRateId`                                                   | 删除                                                              | C2：汇率归 billing 结算时点         |

## 4. 行为对照核销清单（全部满足，2026-08-23 核销）

- [x] 白名单拒绝发生在任何资金动作之前（model_not_allowed）；
- [x] 候选为空/无映射 → model_not_found（v1 404 语义）；
- [x] 候选×渠道双层循环：可换错误换渠、5xx 族换候选、4xx 透传终局（原码返回 + request_failed 收尾）；
- [x] 渠道预算拒绝/限流拒绝 → 换渠并记 lastError；全败渠道面 → no_available_channel，上游面 → upstream_failed；
- [x] upstream_started 只在首次成功预留后发一次；authorizationTtlMs 为租约；
- [x] 非流式：成功先结算后交付；结算重试耗尽 → finalize_unavailable（未交付不结算，B3 滞留由 recover 兜底）；
- [x] 流式：first_chunk/failed 决定性锚定；上线后不换渠；续租 1/3 TTL、下限 1s、上限 100 次、终态即停、结算重试期间不停；
- [x] 流式终态收据：可信累计 usage 正常结算；缺 usage → 估算（input=请求特征估算、output=outputFeatures 估算）+
      归属细分（client_disconnect/inactivity_timeout/server_draining/upstream_error_partial/usage_missing_completed）；
      中断且无 usage 不把缓存命中估 0（uncertain 语义交 billing 验收）；
- [x] cacheWriteTokens>0 透传收据（写价≠输入价，丢弃即错账）；
- [x] 熔断：trip 位计数（429/4xx/死凭据不跳闸）、阈值 open、冷却后半开单探测、探测成功恢复、探测失败重开；
      中断流 terminated∈{inactivity,upstream_*} 计跳闸（v1 stream-report 语义）；
- [x] 死凭据：连续 3 次/1h 窗口 invalid、成功自愈（C3 单阈值）；
- [x] health.admit 拒绝（circuit_open/dead_credential）→ 换渠（C4，v1 admission 等价）；
- [x] 输出上界：声明值超口径钳制、未声明注入、×n、封顶；输入保守上界 = JSON UTF-8 字节（只作敞口）；
- [x] 生成任务：video=上游提交+收据模板持久化、music=仅登记；持久化失败 → billing_receipt_unavailable 且预留保留；
      查询属主隔离 → task_not_found；
- [x] 收据价格快照取自命中候选（fallback 价同样有效——防中途改价）。

## 5. 待办（显式挂账，后果写明）

- **生成任务轮询/结算落账**（v1 service/generation/poll.ts 212 行）：归 worker/settlement 垂直。
  后果：本轮提交的任务不会被本包推进状态；装配方须自备轮询或等待 worker 波次。
- **死凭据永久拉黑 + 告警**（v1 channels.status=4 + notify_outbox）：归 control-plane。
  后果：坏凭据渠道靠 health 状态机软隔离（3 次后不再路由，成功自愈），无永久下线与运营通知。
- **渠道/凭证维限流与 TPM 预占**：归 gateway app（admitChannel 钩子）。
  后果：未装配钩子时渠道维无限流（v1 未装配闸时同形态）。

## 6. 回滚方案

单包新增提交，revert 即整体还原；无 DDL、无调用方切换（apps 尚空），旧仓只读未动。
