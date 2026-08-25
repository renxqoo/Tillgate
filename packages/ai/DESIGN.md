# @tillgate/ai 设计基线（DESIGN）

> 状态：定稿（2026-08-23 补档——实现已收口，依赖白名单与导出面由 `__test__/architecture.test.ts` 机器锁定）
> 定位：上游协议执行**独立库**（永久私有叶子）——「可靠调用上游并产出结构化事件」，零业务知识（src/types.ts 头注释）
> 旧实现：`/Users/wrr/work/ai-getway/packages/ai`（v1，112 文件 ~9k 行，444 测试）——平移+重写而非垂直用例迁移，
> **不设 MIGRATION.md**（裁决存档于 ADR-0006「影响」节：审计与验收记录由 [IMPLEMENTATION.md](./IMPLEMENTATION.md) 承担）
> 目标位置：`/Users/wrr/work/Tillgate/packages/ai`
> 关联：[ADR-0006](../../docs/adr/0006-ai-standalone-library.md)（保留独立库、不并入 inference）、
> [ADR-0007](../../docs/adr/0007-apps-assembly-ai-injection.md)（apps 装配面注入形态）、
> [ADR-0001](../../docs/adr/0001-errors-registry-ownership.md) D7（ErrorKind ↔ errors 根契约映射归消费方）、
> [project-structure-refactoring.md](../../docs/project-structure-refactoring.md) §3.5/§3.6（数据面/观察面分离）、§5（依赖图：inference 单向依赖 ai）、§5.1（白名单）、§7.2（发布候选资格保留、白名单初始为空）、AGENTS.md §0 铁律 12 与 §11「禁止使用」清单

---

## 0. 原则

1. **独立库，不并入 inference**（ADR-0006）：并入会把已验证的库边界降级为目录边界——
   ai 的消费面除了运行时装配（inference），还有协议矩阵测试、admin-api 探针 port 与未来
   独立发布候选；目录内聚会让这些消费面失去 exports 级契约保护。库/用例两种生命周期不耦合。
2. **数据面与观察面分离**（AGENTS.md 铁律 12 / 总纲 §3.6）：上游响应逐块透传 C 端
   （`pipeThrough` 不缓冲、不改写、不收完再转发）；触碰「不改写」的仅透传例外清单三种
   （§3.6）：跨协议最小必要转换（含错误体）、响应侧 model 字段替换（`responseModelRewrite`
   可配置开关，默认关）、错误出站三层（结构翻译、内容脱敏后保留原文、细节只进日志）。
   计费取证、审计、trace、渠道健康一律经 `onEvent`（`subscribe`）监听面旁路消费，不进热路径。
3. **零跨请求运维状态**：熔断、死凭据等渠道健康状态以 `AiEvent` 订阅者身份住在
   `inference/health`（总纲 §3.6）；ai 不持有任何请求间可变状态，观察 tap 丢失不得造成
   资损——兜底在 billing 状态机与对账。
4. **机制内置、策略注入**：SSRF 受信名单（`guardUrl`）、per-model 参数规则（`paramRules`）、
   logger/tracer、超时档位全部装配注入；包内默认值（config.ts）是纯机制缺省，无业务、
   无策略数据。机制配置是**进程级装配数据**，由 app 持有（ADR-0007 决策理由，§4.2）。
5. **错误归一分层翻译**（IMPLEMENTATION §3.2，用户裁决）：`ErrorKind` 封闭词表全局唯一，
   adapter 只翻译不发明；机制位由 `KIND_MECHANICS` 派生表单点派生；共享层零正则
   （厂商文本 pattern 迁入各 adapter 档案，降为最后兜底且可观测）。

## 1. 问题域

### 1.1 处理

- **单渠道内机制链**：参数抹平（paramRules 驱动）→ 单次尝试体（`withRetry` 包裹）→
  透传中继 + 事件观察。换渠道候选循环、路由、quote、计费衔接全部不在本包。
- **协议适配器注册表**：8 协议（openai-compatible / anthropic / gemini / azure-openai /
  aws-bedrock / vertex-ai / minimax / dashscope）——请求寻址与签名、normalizeRequest
  （含 endpoint 能力声明面）、mapError 厂商错误表、usage 双形提取、任务族操作。
- **传输**：SSRF 守卫的 http-client（guardUrl 注入、readChunks 限长、abort 截断）、
  relay-stream 透传中继（心跳仅 SSE 边界注入、错误帧转换、全局 sweeper 单 timer）、
  sse 统一解析原语（行缓冲 + UTF-8 流式解码 + 保留 event 名）。
- **计量**：usage 归一（方言矩阵 → `Usage`：inputTokens 含缓存命中、cachedInputTokens、
  cacheWriteTokens、units、raw 保留）、缺失时的特征估算（四计数器充分统计量 + BPE 精确
  路径二选一采）、校准 offset、tokenizer 降级、音频时长。
- **任务族**：`tasks.parse/query/file`（video/music 异步生成的提交解析、状态查询、产物取回；
  未注册协议显式报错）。
- **探测**：`probe(channel)` 连通性探测（admin 控制面渠道测试用）。
- **事件总线**：全局 `subscribe` + per-call `CallEvents`（终态缓冲、晚订阅重放）。

### 1.2 明确不处理（写明归属，不留白）

| 不处理                                                               | 归属                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 候选循环 / 换渠 / 路由 / quote / 计费衔接 / 渠道健康（熔断、死凭据） | `inference`（ai 的唯一运行时装配消费方；健康状态 = AiEvent 订阅者形态）                          |
| 计费取证 / 审计 / trace / 请求日志的消费与持久化                     | billing / observability 等订阅者（装配处挂 `subscribe`，旁路消费）                               |
| 模型映射 / 渠道目录 / 费率                                           | `control-plane`（`SUPPORTED_PROTOCOLS`/`vendorProfileNames` 词表供其校验引用）                   |
| 仓库级错误根契约（三性/category）                                    | `@tillgate/errors`——**ai 禁止依赖**（AGENTS.md §11 禁止清单；映射按 ADR-0001 D7 由消费方应用）   |
| C 端 wire 出站投影（OpenAI 错误信封、脱敏呈现）                      | app error-face（gateway `openai-error-face` + `sanitize`；ai 只出 UpstreamError 结构与脱敏参数） |
| 环境变量读取 / OTel SDK / 进程装配                                   | app 装配面（ADR-0007；ai 只收 logger/tracer 结构形状）                                           |
| 任务轮询调度与结算落账                                               | worker / inference（minimax 'Unknown'→running 永挂面上限归 worker，在案）                        |

## 2. 外部契约（v2 API，定稿）

```ts
import { createAi, SUPPORTED_PROTOCOLS, vendorProfileNames,
         UpstreamError, isUpstreamError, KIND_MECHANICS,
         assertSafeUrl, assertSafeUrlSync, allowAllUrls } from '@tillgate/ai';

// ---- 装配（三参：机制默认值 / 依赖注入 / 适配器注册）----
const ai = createAi(
  defaults?,                        // 可选：retry/stream/timeout/responseModelRewrite/errorSanitize 档位
  { logger?, tracer?, guardUrl? },  // AiDeps：宿主实现；缺省 guardUrl = 机械基线（https-only + 禁私网 + DNS 逐地址判定）
  { adapters? },                    // 不传 → 默认注册表 8 协议；传入整体替换，同 protocol 重复注册启动即抛
);

// ---- 调用面（参数平铺、opts 全可选）----
ai.chat(channel, request, opts?)         → Promise<ChatResult>    // 判别联合 { ok: true, usage?, body?, rawBody?, rawContentType?, durationMs } | { ok: false, error, durationMs, empty? }
ai.chatStream(channel, request, opts?)   → Promise<{ stream, events }>   // 数据面（透传管道）与观察面（per-call 事件）在返回值分家
ai.use(channel)                          → ChannelClient          // 闭包糖：chat/stream/embed/probe
ai.probe(channel)                        → Promise<ProbeResult>  // { ok, durationMs, error? }
ai.subscribe(observer)                   → 退订函数              // 全局观察面：装配处挂一次，快照迭代（分发中退订竞态安全）
ai.SUPPORTED_PROTOCOLS                   // 协议词表单一真相（control-plane 校验引用）
ai.tasks.{ parse, query, file }          // 任务族（未注册协议 → invalid_config 族 task_ops_unavailable）

// opts：requestId（缺省 randomUUID）/ model（覆盖并回写 body+form）/ endpoint（缺省 'chat'）/
//       signal / paramRules / providerName / maxRetries / deadlineMs —— 全可选平铺

// ---- SSRF 策略（机制固定在包内；ADR-0010：出口信任锚在运营面）----
assertSafeUrl(url);                        // 机械基线：https-only + 私网/IPv6 解包拒绝 + DNS 逐地址判定
allowAllUrls;                              // 测试/本地调试注入
```

- `ChannelDesc = { baseUrl, apiKey, protocol, vendor? }`——纯数据；apiKey 为解密后明文，
  包内不落盘、不日志。
- `ChatStreamResult.stream` 是逐字节透传管道：心跳注入只在 SSE 边界（atBoundary 判定），
  `responseModelRewrite` 开启时仅替换帧内 `"model"` 字符串值，其余字节不动（例外清单 2）。

### 2.1 事件时序契约（观察面唯一输入）

- 非流式：`attempt_start* → [param_adjustment] → (success | (empty_completion | failed))`。
- 流式：`attempt_start* → [param_adjustment] → first_chunk`（一次性，TTFB 权威锚点）
  `→ [stream_error…] → [aborted?] → success|failed`（**终态保证最后**，`terminated` 随行）。
- 计费语义（events.ts 头注释）：usage 是 success 终态随行状态，任何帧非 null usage 均视为
  累计值、**最新者胜出**；`success.terminated ≠ undefined` → 流式中断（网关标 stream_aborted）；
  中断且 usage 为空 → 账务进 uncertain，**禁止把未知缓存命中估成 0 后直接扣费**；
  `bytesRelayed`/`outputFeatures`（四计数器）供取消/缺 usage 时的估算佐证。
- 回调契约：fire-and-forget——观察者异常被吞（不反噬数据面）、不得阻塞、不得做 IO
  （重活入队，outbox 侧消费）；回调必须微秒级（§5 并发预算）。

## 3. 词表与语义（封闭清单，变更走 ADR）

- **ErrorKind（18 值，src/errors/kinds.ts）**：传输类 `network`/`timeout`；上游服务类
  `upstream_error`/`overloaded`/`rate_limited`/`quota_exhausted`/`invalid_api_key`/
  `insufficient_permissions`/`invalid_request`/`invalid_response`/`context_overflow`/
  `content_filtered`/`model_not_found`；库策略类 `empty_completion`（独立重试预算）/
  `canceled`/`server_draining`/`invalid_config`/`unsupported_protocol`。
  机制位（retryable/circuitTrip/deadCredential）由 `KIND_MECHANICS` 派生表单点得出，
  adapter 不得逐例声明；`UpstreamError = { kind, vendorCode?, status?, retryAfterMs?, detail, rawBody? }`
  ——原始信息保留（排障对照 + 审计源 + Retry-After 解析归 adapter 职责）。
  与 errors 根契约的关系：kind 是上游传输域语义分类，kind → category 映射按 ADR-0001 D7
  由消费方应用，不是两套标准（IMPLEMENTATION §3.2）。
- **Endpoint（11 值）**：`chat`/`embeddings`/`images`/`images_edits`/`audio_speech`/
  `audio_transcription`/`audio_translation`/`rerank`/`moderations`/`video`/`music`——
  adapter 寻址与参数词表的单一真相（修 v1 S5「无 endpoint 能力声明面」缺口）。
- **TerminationReason（7 值，types.ts 单一定义）**：`client_disconnect`/`request_cancelled`/
  `server_draining`/`inactivity`/`upstream_error`/`upstream_disconnected`/`upstream_truncated`
  ——events 与 relay 共同引用，禁止手抄（修 v1 S6 三处漂移）。
- **SUPPORTED_PROTOCOLS（8 协议）** 与 **vendorProfileNames**（registry/vendor-profiles）：
  admin 下拉 / control-plane capabilities 的单一真相；未注册协议显式 `unsupported_protocol`，
  不静默回退。
- **机制默认档位**（config.ts，可整体覆盖）：retry `{ maxAttempts: 3, baseDelayMs: 250,
maxDelayMs: 8000, jitterRatio: 0.25, deadlineMs: 240_000, emptyCompletionRetries: 2 }`、
  stream `{ heartbeatIdleMs: 30_000, firstByteTimeoutMs: 60_000, inactivityTimeoutMs: 120_000 }`、
  timeout `{ connectMs: 10_000, totalMs: 120_000 }`、`responseModelRewrite: false`（默认关）、
  `errorSanitize { maxLen: 512, redactions: [] }`。

## 4. 治理与稳定性

1. **依赖白名单 = 零内部依赖**（永久叶子）：运行时仅 `zod` + `js-tiktoken`；src 全量
   import 白名单由 `__test__/architecture.test.ts` 机器锁定（含「src/errors 不得 import
   @tillgate/errors」专项）。发布候选资格保留（总纲 §7.2 第三候选），公开发布需显式评审。
2. **导出面快照**：`index.ts` 值导出集合精确锁定于架构测试——新增导出是契约变更。
3. **装配注入形态**（ADR-0007，apps 依赖白名单的窄例外）：`@tillgate/ai` import 只允许
   出现在 `apps/*/src/assembly.ts` 与实现能力包 port 的 app 自有 adapter（当前唯一实例
   admin-api `adapters/upstream-probe.ts`）；`Ai` 实例构造后只交给 `createInference`
   （或 port 实现），业务路由/中间件/任务 handler 不得持有；机器门禁在各 app 架构测试。
4. **词表治理**：ErrorKind / Endpoint / TerminationReason / 协议注册表的新增与变更走 ADR
   （同 errors category 治理）；§3.6 契约演进只允许强化，新增透传例外必须走 ADR（ADR-0006）。
5. **错误映射是纯数据表**：每 adapter 一张错误表（结构字段精确匹配 → 共享 status 兜底 →
   档案文本 pattern），表驱动测试；新增厂商成本 = 自己档案加表，不在共享层堆正则。
   兜底必须可观测——结构/status/pattern 三档命中各自发信号（B3 静默弃真教训）。

## 5. 并发与性能预算（数字化硬约束；门禁 = `__test__/latency.test.ts`）

- **每帧同步工作 ≤ ~3μs 量级**：万帧合成流的扫描总耗时上界断言（SSE 原语 + relay 边界判定）。
- **每流常数 KB 内存**：万级并发流的内存 = 每流 O(1)——usage 扫描四计数器化（v1 sse-parser
  的 4MB 文本缓冲上界废除，S1）；输出特征以 `TextTokenFeatures` 充分统计量随行，不累积文本。
- **全局单 timer**：心跳由模块级单 sweeper interval + 活跃流注册表驱动（v1 每流一个
  setInterval 的 4 万次/秒唤醒废除，S2）。
- **观察面零反噬**：观察者异常吞掉、回调无 IO；tap 丢失不得造成资损（兜底在 billing）。
- **无跨请求可变状态**：重试预算、deadline、取消链全部调用内闭合；TTFB 不缓冲
  （跨协议流在 node-server 环境不缓冲有回归用例，S4）。
