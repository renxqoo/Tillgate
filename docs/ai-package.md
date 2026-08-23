# packages/ai — 上游 LLM 传输层库设计

> 本文档自 v1（ai-getway）同名文档适配至 v2 结构；以代码为准。
> 定位：自研 LLM 上游传输层库（不依赖 Vercel AI SDK，选型论证沿用 v1）。
> v2 关键变化：`ai` 是**零内部依赖的独立库（永久叶子包）**，不并入 `inference`——裁决见
> [ADR-0006](./adr/0006-ai-standalone-library.md)；apps 装配面注入形态见
> [ADR-0007](./adr/0007-apps-assembly-ai-injection.md)；数据面/观察面契约见
> [project-structure-refactoring.md §3.6](./project-structure-refactoring.md)。
> 实现审计记录：[packages/ai/IMPLEMENTATION.md](../packages/ai/IMPLEMENTATION.md)。

---

## 1. 包定位

> **`packages/ai` 只做一件事：可靠地调用上游大模型，并产出结构化事件。**
> 纯机制、零业务知识——不知道费率卡、不知道用户、不知道预扣。模型名/参数规则/厂商档案
> 全部由调用方注入；**零运维状态**：不持有任何跨请求的业务/健康状态（v1 的熔断/死凭据
> 注入存储已迁出，见 §7.2）。

**依赖关系（v2）**：

- `ai` 在依赖图上是**永久叶子**：运行时依赖仅 `js-tiktoken`（BPE 分词）与 `zod`（配置
  校验），不依赖任何 `@tokenlens/*` 包。
- 唯一运行时装配消费方是 `inference`（候选循环、路由、计费衔接都在那侧，§8）。
- apps 在**装配面**直接 import `@tokenlens/ai`：`apps/{gateway,worker,admin-api}/src/assembly.ts`
  构造 `Ai` 实例注入 `createInference`；admin-api 另以 `createAi` 实现 control-plane 的
  `ProviderProbe` port（app 自有 adapter `src/adapters/upstream-probe.ts`）。该窄例外由
  ADR-0007 认可并由各 app 架构测试锁定——业务路由/中间件/任务 handler 不得持有 `ai`。

## 2. 已确认的设计决策

| 决策点 | 结论（v2） |
|---|---|
| 传输层选型 | 自研，不用 AI SDK（论证沿用 v1 tech-stack §9：需要透传保真、SSE 旁路计量与多协议错误归一，SDK 的抽象层反而是负担） |
| 运行时依赖 | `js-tiktoken` + `zod`；v1 的 `eventsource-parser` 已移除——SSE 解析统一为自研单一原语 `transport/sse.ts`（消灭 v1 双实现漂移） |
| 熔断/死凭据归属 | **不在包内**（v1 为包内原语 + Storage 注入；v2 按 §3.6 零运维状态迁入 `inference/health`，以 `AiEvent` 订阅者身份维护，§7.2） |
| 事件形态 | **Result + 双层观察面**：非流式返回 `ChatResult` 判别联合；流式返回 `{ stream, events }`（per-call 订阅面，终态缓冲 + 晚订阅重放）；另有全局 `ai.subscribe` |
| 重试编排 | 包内 `withRetry`：指数退避 + jitter + deadline + maxAttempts + 空完成独立预算（`emptyCompletionRetries`） |
| 错误模型 | `ErrorKind` 封闭词表 + `KIND_MECHANICS` 单点派生表——机制位（retryable/circuitTrip/deadCredential）不可逐例声明（§7.1） |
| SSRF | 机制在包内硬门（网络出口），策略经 `AiDeps.guardUrl` 注入（受信名单是业务数据）；缺省机械基线 https-only + 禁私网/回环 + DNS 逐地址判定防 rebinding |

## 3. 职责清单

**做（机制）**：

| 模块 | 内容 |
|---|---|
| Transport | fetch 封装（SSRF 守卫 / connect 超时 / abort）→ 非流式 JSON + 二进制 + 流式 SSE |
| SSE 原语 | `transport/sse.ts` 自研统一解析（行缓冲 + UTF-8 流式解码 + 事件聚合 + 保留 event 名）——扫描器与协议流转换共用，单一实现 |
| 旁路扫描 | `sse-parser.ts` 四计数器累积（`usage/features.ts` 充分统计量，O(1) 内存——替代 v1 文本拼接）；usage 最新帧胜出、错误帧捕获 |
| Relay 透传 | 逐块 `pipeThrough` 不缓冲不改写；心跳注入（仅 SSE 事件边界）；静默超时；abort 三路传播；`bytesRelayed` 计数；错误帧转换 |
| ProtocolAdapter | 五能力件契约（寻址/终改/抹平/usage/错误映射）+ 探测请求 + `supportedEndpoints` 能力声明面；默认注册表 8 适配器，`createAi(_, _, { adapters })` 注册即扩展 |
| Streaming 控制 | 首帧探测（peekFirstChunk）、首字节/中段静默双预算、空完成判定、响应侧 model 字段替换（§3.6 例外 2，默认关） |
| Errors | `ErrorKind` 封闭词表 + 机制位派生表 + 出站脱敏（§3.6 例外 3 内容层） |
| Retry | 同渠道重试：指数退避 + jitter + 总 deadline + maxAttempts + 空完成独立预算 |
| Usage 归一化 | `{inputTokens, cachedInputTokens, cacheWriteTokens?, outputTokens, units?, estimated, raw}`——各供应商缓存字段归一化 |
| 事件输出 | 调用全生命周期事件（attempt_start / first_chunk / param_adjustment / stream_error / aborted / failed / empty_completion / success） |
| 任务族 | `ai.tasks.{parse,query,file}`——异步生成任务（video/music）三动词 |

**不做（边界，全部留在 inference / app）**：

- 鉴权 / 预扣 / 限流 / 渠道路由 / 模型映射 / 费率卡
- 计费 / 结算 / 计量落库（包只发事件，观察 tap 不承载资金事实的最终性）
- 对外 HTTP 表面（Hono 路由、入站 SSE、错误信封组装）
- 换渠道 / fallback 模型编排——**候选循环是 inference 的职责**，包只负责"单个候选内的重试"
- **熔断 / 死凭据 / 渠道健康统计**——跨请求运维状态，`inference/health` 以订阅者身份维护（§7.2）

## 4. 核心类型（v2 实况）

```ts
// ---- 输入 ----
interface ChannelDesc {
  baseUrl: string          // 守卫机械基线仍然生效；受信名单经 guardUrl 注入
  apiKey: string           // 调用方解密后传入，包内不落盘
  protocol: string         // 协议键 = 适配器注册表键（词表单一真相 SUPPORTED_PROTOCOLS）
  vendor?: string          // 厂商档案键（协议族的参数怪癖预设，registry/vendor-profiles）
}

// ---- 端点词表（adapter 寻址单一真相） ----
type Endpoint =
  | 'chat' | 'embeddings' | 'images' | 'images_edits'
  | 'audio_speech' | 'audio_transcription' | 'audio_translation'
  | 'rerank' | 'moderations' | 'video' | 'music'

// ---- 调用选项（第三参全可选平铺；网关传全量，脚本用户零配置） ----
interface CallOptions {
  requestId?: string       // 事件流 join key（计费归属）；缺省 randomUUID
  model?: string           // 覆盖 request.model 并回写 body/form（对外名→真实名在此完成）
  endpoint?: Endpoint      // 缺省 'chat'
  signal?: AbortSignal     // 客户端断开 / 总 deadline / 服务 drain
  paramRules?: ParamRules  // per-model 参数规则（策略注入，control-plane 数据，包内零默认）
  providerName?: string    // 厂商名（校准/日志标识）
  maxRetries?: number      // 缺省 defaults.retry.maxAttempts（3）
  deadlineMs?: number      // 本次调用总预算，缺省 240s
}

interface ParamRules {       // 四级策略，透传为基底
  ignore?: string[]                                   // 删除：传了会 400 的参数
  clamp?: Record<string, { min?: number; max?: number }> // 钳制：超范围会 400 的
  map?: Record<string, { to: string }>                // 改名（max_tokens ↔ max_completion_tokens）
  unknown?: 'passthrough' | 'drop'                    // 未知参数策略，默认 passthrough
}

// ---- usage 归一化（缓存计费数据源） ----
interface Usage {
  inputTokens: number
  cachedInputTokens: number   // OpenAI cached_tokens / DeepSeek cache_hit 归一
  cacheWriteTokens?: number   // Anthropic cache_creation 归一（仅事件/日志可见）
  outputTokens: number
  units?: number              // 按次/张/秒/字符计费端点的单位计量；token 端点缺省 0
  estimated: boolean          // usage 缺失，按特征四计数器估算
  raw: unknown                // 原始 usage 保留（排障/审计）
}

// ---- 估算特征（token-estimate 启发式层的充分统计量，单一真相） ----
interface TextTokenFeatures {
  cjkChars: number        // CJK 字符数（逐字计）
  wordSegments: number    // 拉丁连续词段数（相邻字符状态机——字符数无法还原，不可简化为三分类）
  numberSegments: number
  symbolCount: number
}

// ---- 统一错误模型（errors/kinds.ts 单一真相） ----
type ErrorKind =
  // 传输类（http-client 生成，无厂商参与）
  | 'network' | 'timeout'
  // 上游服务类（adapter 结构查表或 status 兜底）
  | 'upstream_error' | 'overloaded' | 'rate_limited' | 'quota_exhausted'
  | 'invalid_api_key' | 'insufficient_permissions' | 'invalid_request'
  | 'invalid_response' | 'context_overflow' | 'content_filtered' | 'model_not_found'
  // 库策略类（生成时直接带 kind）
  | 'empty_completion' | 'canceled' | 'server_draining'
  | 'invalid_config' | 'unsupported_protocol' | 'task_ops_unavailable'

class UpstreamError extends Error {
  readonly kind: ErrorKind            // 语义分类（封闭词表，adapter 只翻译不发明）
  readonly vendorCode?: string        // 厂商原始错误码（排障对照）
  readonly status?: number            // undefined = 网络/超时
  readonly retryAfterMs?: number      // Retry-After 头 / 厂商字段解析（adapter 职责）
  readonly suggestion?: string        // 可操作建议（进 C 端错误信封）
  readonly rawBody?: string           // 上游响应体原文（脱敏前；仅日志/审计）
  readonly retryable: boolean         // ── 以下三个机制位由 KIND_MECHANICS
  readonly circuitTrip: boolean       //    派生表单点填入，
  readonly deadCredential: boolean    //    调用方不可覆盖
}

// ---- 流终止（单一真相；events 与 relay 共同引用，禁止手抄） ----
type TerminationReason =
  | 'client_disconnect' | 'request_cancelled' | 'server_draining'
  | 'inactivity' | 'upstream_error' | 'upstream_disconnected' | 'upstream_truncated'

// ---- 事件（观察面契约——计费/审计/trace/渠道健康四类订阅者的唯一输入） ----
type AiEvent =
  | { type: 'attempt_start'; requestId; channelKey; attempt; atMs }
  | { type: 'first_chunk'; requestId; atMs }          // TTFB 权威锚点（一次性）
  | { type: 'param_adjustment'; requestId; param; action: 'ignore'|'clamp'|'map'; from?; to? }
  | { type: 'stream_error'; requestId; frame: StreamError }
  | { type: 'aborted'; requestId; reason: TerminationReason }
  | { type: 'failed'; requestId; channelKey; error: UpstreamError }
  | { type: 'empty_completion'; requestId; channelKey; attempt }
  | { type: 'success'; requestId; channelKey; usage?; durationMs
      terminated?: TerminationReason    // 流式正常结束 = undefined；中断结束 = 中断原因
      bytesRelayed?: number             // 已透字节量（取消且 usage 缺失时的估算佐证）
      outputFeatures?: TextTokenFeatures // 输出内容四计数器（O(1) 内存替代 v1 文本累积）
      doneSentinel?: boolean            // [DONE] 哨兵是否到达
      terminalFrame?: boolean           // finish_reason 终止帧是否到达
      contextOverflow?: boolean         // 静默溢出旗标（可观测信号，不翻转成功语义）
      model?: string }

interface StreamError { code: string; type?: string; detail?: string }

// ---- 返回 ----
type ChatResult =
  | { ok: true; usage?: Usage; durationMs: number
      body?: unknown; rawBody?: Uint8Array; rawContentType?: string }  // 二进制 = 模态端点
  | { ok: false; error: UpstreamError; durationMs: number; empty?: boolean }

interface CallEvents { subscribe(cb: (e: AiEvent) => void): void }   // per-call（终态缓冲 + 晚订阅重放）
interface ChatStreamResult {
  stream: ReadableStream<Uint8Array>   // 数据面（透传管道）
  events: CallEvents                   // 观察面（与数据面在返回值分家）
}
```

事件顺序约定（同一次调用）：非流式 `attempt_start* → [param_adjustment] → (success | (empty_completion | failed))`；
流式 `attempt_start* → [param_adjustment] → first_chunk → [stream_error…] → [aborted?] → success`——
**终态一定最后发出**；usage 是 success 终态的随行状态（scanner 逐帧捕获，最新者胜出，
随 success 一次性流出——独立的 `usage` 流事件已按死代码裁决移除）。

## 5. 对外 API

```ts
const ai = createAi(defaults?, { logger?, tracer?, guardUrl? }?, { adapters? }?)

interface Ai {
  // 非流式（自动 withRetry：可重试错误 + 空完成独立预算）
  chat(channel: ChannelDesc, request: unknown, opts?: CallOptions): Promise<ChatResult>
  // 流式（透传管道；重试仅限首字节前，流开始后失败发错误帧不重试）
  chatStream(channel: ChannelDesc, request: unknown, opts?: CallOptions): Promise<ChatStreamResult>
  // 渠道绑定糖（闭包固定 channel，委托同一内核；embed = endpoint:'embeddings'）
  use(channel: ChannelDesc): ChannelClient        // { chat, stream, embed, probe }
  // 连通性探测（admin 控制面渠道测试用：adapter.probeRequests 逐个 GET，死凭据优先语义）
  probe(channel: ChannelDesc): Promise<ProbeResult>
  // 全局事件订阅（chat + chatStream 共用总线；装配挂一次；快照迭代，退订竞态安全）
  subscribe(observer: (e: AiEvent) => void): () => void
  // 协议词表单一真相（control-plane 配置校验引用）
  readonly SUPPORTED_PROTOCOLS: readonly string[]
  // 异步生成任务操作面（任务型协议提供；未注册协议显式报错 task_ops_unavailable）
  readonly tasks: {
    parse(channel, kind: 'video' | 'music', body): GenerationParsedResponse
    query(channel, taskId): Promise<GenerationTaskProbeResult>
    file(channel, fileId): Promise<GenerationFileProbeResult>
  }
}
```

**配置（`AiDefaults`，纯机制默认值，zod 校验）**：

| 组 | 键（默认） |
|---|---|
| retry | maxAttempts(3) / baseDelayMs(250) / maxDelayMs(8000) / jitterRatio(0.25) / deadlineMs(240_000) / **emptyCompletionRetries(2)** |
| stream | heartbeatIdleMs(30_000) / **firstByteTimeoutMs(60_000)** / inactivityTimeoutMs(120_000) |
| timeout | connectMs(10_000) / totalMs(120_000) |
| responseModelRewrite | false（§3.6 例外 2 开关：出站 SSE 帧内仅替换 `"model"` 值，其余字节不动） |
| errorSanitize | maxLen(512) / redactions([])——错误出站脱敏参数（§3.6 例外 3 内容层） |

v1 的 `breaker` / `deadCredential` 配置组已随机制迁出删除。

**依赖注入（`AiDeps`）**：`logger`（最小接口）、`tracer`（OTel 接口，包零 OTel 依赖）、
`guardUrl`（SSRF 策略；缺省机械基线；测试/本地可注入 `allowAllUrls`；生产由装配方组合
`assertSafeUrl(u, { allowedHosts })` 从渠道目录派生）。**没有状态存储注入点**——零运维状态。

**扩展（`AiOptions.adapters`）**：不传 → 默认注册表（openai-compatible / anthropic / gemini /
azure-openai / aws-bedrock / vertex-ai / minimax / dashscope 共 8 个）；传入则**整体替换**
（显式优先，不做隐式合并）；同 protocol 键重复注册启动即抛。未注册协议显式报
`unsupported_protocol`（错误信息列出实际已注册键），不静默回退。

## 6. 内部结构（v2 实况）

```
packages/ai/
├── package.json               # deps: js-tiktoken, zod；dev: vitest, typescript
├── IMPLEMENTATION.md          # 逐文件审计 + 裁决 + 测试计划（无 MIGRATION.md：平移+重写，见 ADR-0006）
├── src/
│   ├── index.ts               # 公共出口（错误归一件 + 契约类型 + createAi + 入站协议翻译
│   │                          #   + vendor 档案词表 + SSRF 守卫件 + 特征计数器 + AiEvent）
│   ├── create-ai.ts           # 装配壳（注册表 + 装配校验 + prepare/planRequest + probe + use + subscribe）
│   ├── join-url.ts            # baseUrl 版本段去重纯函数
│   ├── config.ts              # zod schema（AiDefaults + AiDeps + AiOptions）
│   ├── events.ts              # AiEvent / StreamError（事件时序与计费语义注释）
│   ├── types.ts               # ChannelDesc/Endpoint/CallOptions/Usage/ChatResult/Ai 等外部契约
│   ├── pipeline/              # 单次尝试机制链
│   │   ├── context.ts         # channelKey / 前置校验 / CallCtx / 快照 emitTo
│   │   ├── attempt-chat.ts    # 非流式尝试体（withRetry 回调：fetch/翻译/分类/计量）
│   │   ├── attempt-stream.ts  # 流式尝试体（fetch/原生归一/peek 首帧判定）
│   │   ├── stream-report.ts   # per-call 事件总线 + failEarly 错误帧流 + relay 事件翻译
│   │   └── tasks.ts           # 任务三动词（parse/query/file）
│   ├── registry/              # 扩展点
│   │   ├── define-adapter.ts  # 能力件组合器（未覆写件落 openai-compatible 默认，委托非复制）
│   │   └── vendor-profiles.ts # 厂商参数怪癖预设库 + errorPatterns（厂商文本 pattern 的唯一住所）
│   ├── transport/
│   │   ├── http-client.ts     # fetch 封装：guardUrl 硬门 / connect 超时 / readBody / assertSafeUrl 家族
│   │   ├── sse.ts             # 统一 SSE 原语（自研单一 reader；行缓冲/UTF-8 流式解码/事件聚合）
│   │   ├── sse-parser.ts      # 旁路扫描器（四计数器累积 + usage 最后帧 + 错误帧捕获）
│   │   ├── relay-stream.ts    # 透传管道：心跳 / abort 传播 / 错误帧转换 / bytesRelayed / 终态事件
│   │   ├── heartbeat.ts       # 全局扫描器（模块级单 interval + 活跃流注册表——替代每流 setInterval）
│   │   └── model-rewrite.ts   # 响应侧 model 字段替换（§3.6 例外 2）
│   ├── protocol/              # 出站协议族 wire 映射：claude-chat/-stream、gemini-chat/-stream/-shared、
│   │                          #   completions-chat、responses-chat（入站翻译函数亦由此导出）
│   ├── adapters/
│   │   ├── protocol-adapter.ts  # 契约：五能力件 + supportedEndpoints + signRequest（bedrock）+ 任务件
│   │   ├── openai-compatible.ts # 默认实现（寻址全端点 + 终改 + 规则抹平 + FormData 直通 + usage + 错误表）
│   │   ├── shared.ts            # 跨适配器共享件（extractOpenAiUsage / gemini-vertex 共享装配）
│   │   └── anthropic / gemini / vertex-ai / azure-openai / aws-bedrock / minimax / dashscope / task-kit
│   ├── usage/
│   │   ├── normalize.ts       # 缓存字段归一化（OpenAI/DeepSeek/Mistral 方言 + cache_write + 一致性观测）
│   │   ├── features.ts        # 四计数器累积器（TextFeaturesAccumulator；分段统计求和 == 整段统计）
│   │   ├── tokenizer.ts       # BPE 真分词器（js-tiktoken：o200k/cl100k 模型族，超长降级启发式）
│   │   ├── token-estimate.ts  # 估算器（BPE 精确路径 × 特征启发式兜底 × 三层校准）
│   │   ├── calibration.ts     # 校准配置（CJK/拉丁词段权重，按 provider/model 覆盖）
│   │   └── media-duration.ts  # 音视频时长估算（WAV/MP3 帧解析 + 兜底）
│   ├── errors/
│   │   ├── kinds.ts           # ErrorKind 封闭词表 + KIND_MECHANICS 派生表 + UpstreamError 构造
│   │   ├── fallback.ts        # status 兜底分类器（通用 HTTP 语义，非厂商知识）
│   │   ├── internal.ts        # 库策略错误（empty/invalid_response/canceled/server_draining/config 族）
│   │   ├── sanitize.ts        # 出站脱敏（截断 + 内部名→对外名替换）
│   │   └── server-drain.ts    # 服务端排空标记（server_draining 计费归属：释放不扣）
│   ├── retry/with-retry.ts    # 同渠道重试原语（full jitter / 信号合并 / 预算分离 / 空完成独立预算）
│   └── internal/              # 包内私有：json（tryParseJson）/ stream（peekFirstChunk）/ util（守卫三件套）
└── __test__/                  # 扁平测试套件（§9）
```

与 v1 的目录差异要点：`pipeline/` 收敛为尝试体五件（prepare/admission 并入装配壳与
inference；无 admission——熔断死凭据已迁出）；`generation/` 并入 `pipeline/tasks.ts` +
`adapters/task-kit.ts`；`transport/sse.ts` + `usage/features.ts` + `transport/heartbeat.ts`
为新增（修 v1 结构缺陷 S1/S2/S3）；`errors/` 重构为词表+派生表（v1 的共享正则
`classify.ts`/`overflow.ts` 拆散：厂商知识迁入 adapter 错误表与 `vendor-profiles.errorPatterns`，
通用兜底留 `fallback.ts`）。

## 7. 关键机制设计

### 7.1 错误归一：适配层翻译 + 集中标准（v2 取代 v1 分类矩阵）

**v1 病灶**：厂商错误知识住在共享层——classify.ts 的死凭据/配额/限流正则在通用层跑全部
厂商的 message 文本，误伤面全局扩散（v1 审计 B8：`/too many tokens/i` 把输出参数超限
误判为上下文溢出）。

**v2 分层翻译模型**：

```
厂商响应（status + headers + body）
  ▼ adapter.mapError —— 厂商知识唯一住所
  │   查表顺序：厂商结构字段精确匹配（code/type/status → kind）
  │            → 共享 status 兜底（fallback.ts，通用 HTTP 语义）
  │            → 档案文本 pattern（vendor-profiles.errorPatterns，最后兜底，命中可观测）
  ▼ UpstreamError { kind, vendorCode?, status?, retryAfterMs?, detail, rawBody? }
  │   机制位由 KIND_MECHANICS 派生表单点得出
  ▼
  ├─ 库内：withRetry 读 retryable；事件流出 kind + 机制位
  ├─ inference：kind 驱动候选循环（换渠道/换模型的路由策略归消费方）
  └─ app error-face：kind → C 端 OpenAI 信封（出站三层不变，翻译变查表）
```

四条硬规则：

1. `ErrorKind` 封闭词表全局唯一定义（`errors/kinds.ts`），adapter 只翻译不发明；新增 kind 走 ADR。
2. 机制位由派生表**单点派生**，adapter 与调用方不得逐例声明（杜绝"rate_limited 却
   retryable=false"矛盾）。
3. 适配层只处理**厂商错误**；传输错误（network/timeout）与库策略错误（empty/config/draining）
   生成时直接带 kind。
4. 共享层零正则：文本 pattern 全部迁入各 adapter 档案，降为最后兜底。

**kind → 机制位派生表（`KIND_MECHANICS` 第一版）**：

| kind | retryable | circuitTrip | deadCredential | 换渠道指引 |
|---|---|---|---|---|
| network / timeout | ✓ | ✓ | | ✓ |
| upstream_error / overloaded | ✓ | ✓ | | ✓ |
| rate_limited | ✓ | — | | ✓ |
| quota_exhausted | — | — | | ✓（换有余额渠道） |
| invalid_api_key | — | — | ✓ | ✓ |
| insufficient_permissions | — | — | ✓ | ✓ |
| invalid_request / invalid_response | — | — | | ✗（调用方修请求） |
| context_overflow | — | — | | ✓（换大窗模型） |
| content_filtered / model_not_found | — | — | | 视策略 |
| empty_completion | 独立预算 | | | ✓ |
| canceled / server_draining / invalid_config | — | — | | 库内闭环 |

v1 矩阵中"连续 401/403 达阈值 → dead_credential"与"熔断打开 → circuit_open"两行不再
是错误分类，而是 inference/health 的**状态机事件**（§7.2）。与仓库级 `errors` 根契约
（三性/category）的映射表落 [ADR-0001 D7](./adr/0001-errors-registry-ownership.md)。

### 7.2 熔断与死凭据：从"包内原语 + Storage 注入"到"inference 订阅者"

v1：breaker/dead-credential 原语住在 ai 包内，gateway 注入 Redis CAS Storage——语义上是
**路由消费方的状态**寄居在传输库，违反 §3.6 零运维状态。v2 迁移：

- `inference/health/`（`breaker.ts` / `dead-credential.ts` / `channel-health.ts`）以
  `Ai['subscribe']` 订阅者身份维护：`failed` 事件按 `error.circuitTrip` 计熔断、按
  `error.deadCredential` 计死凭据；流式中断（`upstream_disconnected` / `inactivity`）
  计熔断，`client_disconnect` 不计——语义与 v1 一致，只是住所变了。
- 状态机不变：closed→open（60s 窗口失败 ≥5）→half-open（CAS 全局唯一赢家）→closed/回 open；
  死凭据连续失败达阈值 → invalid → 停止路由，成功即恢复。多实例共享走 inference 的
  Redis state storage（`adapters/state-redis.ts`）。
- `ai` 内只允许请求内状态（退避重试）、装配期配置（协议注册表）与传输层机制状态
  （连接复用/心跳扫描器）。
- `ai` 侧为订阅者保留的配合面：`UpstreamError.circuitTrip` / `.deadCredential` 机制位
  （派生表单点给出）与 `success.terminated` 中断语义。

### 7.3 重试与候选循环的分工（重要边界，语义同 v1、消费方改名 gateway→inference）

```
包内 withRetry（同渠道）             inference 候选循环（换渠道 / fallback 模型）
  ├─ 可重试错误（5xx/429/超时类）      ├─ 消费 failed / empty_completion 事件 + kind 派生表
  ├─ 空完成重试（独立预算，默认 2）    ├─ 熔断/凭据无效渠道过滤（health 模块）
  └─ 仅限「首字节前」                 └─ 全部耗尽 → fallback 模型 / 503
  （流开始后失败 → 发错误帧，不重试）
```

### 7.4 流式管道（数据面/观察面分家）

```
上游 200 → peekFirstChunk（首帧探测）
            ├─ 空流（无 data 帧）→ empty 完成，withRetry 独立预算重试
            └─ 有首帧 → recordSuccess 语义交 relay → 包装 rest[首帧+剩余] 透传

上游 SSE ──▶ sse.ts 原语 ─▶ 旁路扫描器（sse-parser.ts：四计数器累积 / usage 最后帧胜出 / 错误帧记录）
       ──▶ 输出流（relay-stream：逐块透传 + 心跳注入（全局 sweeper，静默 >30s 发 ': keep-alive'，
                    仅事件边界）+ bytesRelayed 计数 + （可配）model 字段替换）
       ──▶ 事件面（per-call events + 全局 subscribe；fire-and-forget，回调异常不反噬数据面）

abort 三路：客户端断（signal / pipeTo cancel）→ 断上游 reader；静默超预算 → 断流 + 错误帧；
上游读失败 → 错误帧。first_chunk 事件由装配壳合成（TransformStream 需求耦合：两侧互等
会成结构性死锁，e2e 抓出；总线幂等去重）。
```

**流式中断计费语义（沿 v1 requirements 5.11，注释在 `events.ts`）**：

- `success.terminated === undefined` 正常结束；`terminated='upstream_disconnected' |
  'inactivity' | …` 流内中断——网关标 `stream_aborted`。
- 中断且 `usage` 为空 → 账务进入 **uncertain**，由 billing 状态机与对账兜底；**禁止**
  把未知缓存命中估成 0 后直接扣费。中断但有可信累计 usage → 按最新 usage 正常结算。
- `client_disconnect`（用户主动断开）：不计熔断；`bytesRelayed` + `outputFeatures`
  四计数器是取消且 usage 缺失时的估算佐证。估算可计费但必须归属白名单（由计费侧
  定义，ai 包不持有该名单）。

### 7.5 usage 归一化（usage/normalize.ts）

| 供应商 | 原始字段 | 归一化 |
|---|---|---|
| OpenAI 风格 | `prompt_tokens_details.cached_tokens` | cachedInputTokens |
| DeepSeek | `prompt_cache_hit_tokens` | cachedInputTokens（`cache_miss` 计入未缓存） |
| Anthropic | `cache_creation_input_tokens` | cacheWriteTokens（仅事件/日志可见） |
| 无缓存字段 | — | cachedInputTokens = 0 |

usage 缺失时的估算兜底在 `usage/token-estimate.ts`（单一真相）：BPE 精确路径
（js-tiktoken）× 特征启发式（`features.ts` 四计数器——分段统计求和与整段统计等价，
扫描器可按片段喂入）× 三层校准（`calibration.ts`）。估算器修掉了 v1 的口径分裂 bug
（B1：输出侧 reasoning/tool_calls 未透传 model 导致恒走启发式）。total 不一致弃真
（B3）现在**可观测**（发日志/事件信号，不再静默）。

### 7.6 参数抹平策略（透传为基底，规则驱动）

**原则**（沿 v1）：不硬编码各家差异——适配器只实现"规则的执行引擎"，规则本身可配置。
**响应方向不抹平**（`reasoning_content` 等特有字段原样透传），只有 usage（内部计量）与
错误（统一信封）做归一化。

**四级参数策略**（`ParamRules`，见 §4）：passthrough（默认，wire 保真）/ ignore / clamp /
map。**规则来源单一**：control-plane 的 per-model 配置（v1 `model_mappings.param_rules`
的数据形态），inference 从目录快照注入 `opts.paramRules`；`channel.vendor` 引用厂商档案
预设，merge 规则 model 侧逐键优先。未配置时全部透传。

**执行引擎**（adapter 契约，`src/adapters/protocol-adapter.ts`）：

```ts
interface ProtocolAdapter {
  protocol: string
  /** 能力声明面：本协议支持的端点词表（寻址覆写缺口静态可见，装配期校验） */
  supportedEndpoints: readonly Endpoint[]
  // 上游寻址：路径 + 完整认证头由协议决定（支持 model 进 path 的协议，如 gemini）
  planRequest(channel, { endpoint, model, requestId, stream }): { path; headers }
  // 请求体终态化：model 重写（对外名→真实名）、流式 stream_options 强制注入、格式转换
  finalizeRequestBody(body, { endpoint, model, stream }): Record<string, unknown>
  // 请求方向：透传为基底，按规则抹平（endpoint 参与——chat 词表不误删 embeddings 参数）
  normalizeRequest(req, rules, endpoint): { body; adjustments: ParamAdjustment[] }
  // 响应方向：仅提取计量与错误，正文透传
  extractUsage(res): Usage | null
  mapError(status, body, headers): UpstreamError
  // 连通性探测（GET，无副作用），路径与认证头由协议决定
  probeRequests(channel): Array<{ path; headers }>
}
```

**注册即扩展**：一切协议特定行为（路径、认证头、签名、model 重写、stream_options 注入、
usage 提取、错误表、探测请求）都收敛在 ProtocolAdapter；编排层（create-ai.ts）不含任何
协议字面量。新协议 = `defineAdapter` 组合能力件 + 注册一行（未覆写件落 openai-compatible
默认，委托非复制）。

**可观测**：每次抹平产生 `param_adjustment` 事件（requestId / 参数 / 动作 / 原值→新值）。

## 8. 与 inference 的职责划分

| 职责 | ai 包 | inference |
|---|---|---|
| 调用上游 / SSE 解析 / usage 归一化 / 错误翻译 | ✅ | |
| 心跳 / abort / 空完成判定 / 同渠道重试 | ✅ | |
| 候选循环（换渠道 / fallback 模型 / kind 驱动路由） | | ✅ 消费事件编排 |
| 熔断 / 死凭据 / 渠道健康状态 | | ✅ health 模块（AiEvent 订阅者） |
| quote / 预扣 / 计费衔接 / 生成任务用例 | | ✅ |
| 鉴权 / 限流 / 模型目录 | | ✅（目录快照来自 control-plane） |
| 错误信封组装 / 入站 SSE（Hono） | | app 层（gateway） |
| 渠道测试（admin-api 复用 probe） | ✅ | / control-plane 的 `ProviderProbe` port 由 admin-api 装配实现 |

## 9. 测试策略

**策略论证（沿 v1）**：包的核心价值是纯机制的正确性——错误分类、重试退避、SSE 边界、
usage 方言矩阵都是纯函数/纯协议行为，值得高覆盖单测；传输与管线用 mock 上游
（本地 HTTP）做集成；真实供应商契约用独立门的 real 套件。

**v2 落地形态**（`__test__/` 扁平套件，默认门 exclude `*.real.test.ts`）：

- **契约（api / adapter-matrix / assembly）**：平参数三态、`ChatResult` 判别联合穷举、
  requestId 缺省与透传、model 覆盖回写、`use()` 糖等价、subscribe 快照迭代与晚订阅重放、
  事件时序（终态最后）、tasks 命名空间。
- **错误（errors / outbound）**：每 adapter 一张错误表用例（结构字段 → kind 精确断言）、
  兜底链（结构 → status → pattern）、派生一致性（任意构造的 UpstreamError 机制位 == 派生表）、
  B8 回归（max_tokens 输出超限 ≠ context_overflow）、词表封闭性双锁。
- **流式（relay / stream-deep / sse-features）**：透传保真（逐位对照）、心跳边界矩阵、
  静默超时、取消三路、failEarly、出站三层（结构/脱敏内容/细节）。
- **协议（codec 矩阵族）**：claude 四方向、B2 回归（Gemini 流式 cached_tokens）、
  B7 回归（completions n>1 全 choice）。
- **usage 矩阵 / fuzz-sweep / 深分支**。
- **延迟门禁（latency.test.ts）**：TTFB 不缓冲、观察面异常不反噬、扫描内存常数上界、
  全局 sweeper 单 interval 频率（§3.6 契约的机器验证）。
- **架构（architecture.test.ts）**：零 `@tokenlens/*` 依赖（永久叶子锁定）。
- **real 套件（providers.real.test.ts，`test:real` 独立门）**：MiniMax + DeepSeek 真实
  上游，声明即启用、无 key 默认 skip。

## 10. 发布候选（v2 增补，替代 v1「二期扩展」）

总纲 §7.2 列 `@tokenlens/ai` 为**第三发布候选**（当前私有、零内部依赖，已是
`createAi` + `onEvent` + 透传中继的 SDK 形态）。发布前必须：生成 `dist` 与声明文件；
冻结 `createAi` / `AiEvent` / `ChannelDesc` 契约；重型 vendor SDK 声明为 optional peer；
纯 Node consumer fixture 安装冒烟。无真实外部消费者前维持私有，不提前承担兼容成本。
