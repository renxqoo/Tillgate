# packages/ai — 上游 LLM 传输层包设计

> 定位：自研 LLM 上游传输层（不依赖 Vercel AI SDK，选型理由见 tech-stack.md §9）。
> 配套文档：`tech-stack.md`（选型）、`requirements.md`（业务）、`architecture.md`（图）。

---

## 1. 包定位

> **`packages/ai` 只做一件事：可靠地调用上游大模型，并产出结构化事件。**
> 纯逻辑、零业务知识——不知道费率卡、不知道用户、不知道预扣。模型名/价格/系数/渠道路由全部由调用方（gateway）注入。

**使用者（一期）**：`gateway`（主链路）、`admin-api`（渠道连通性测试复用）。

## 2. 已确认的设计决策

| 决策点 | 结论 |
|---|---|
| 传输层选型 | 自研，不用 AI SDK（tech-stack §9） |
| 运行时依赖 | **引轻量依赖**：`eventsource-parser`（SSE 解析）+ `zod`（配置校验） |
| 熔断器归属 | **包内**：breaker 原语 + `Storage` 接口（gateway 注入 Redis 实现） |
| 事件形态 | **Result + onEvent 回调**：非流式返回 Result；流式返回 `{ stream, onEvent }` |
| 重试编排 | **包内 `withRetry`**：指数退避 + jitter + deadline + maxAttempts，与错误分类内聚 |

## 3. 职责清单

**做（机制）**：

| 模块 | 内容 |
|---|---|
| Transport | fetch 封装（SSRF 校验 / 超时 / abort）→ 非流式 JSON + 流式 SSE |
| SseParser | 增量解析：事件边界 / 注释行 / 多行 data / **最后 usage 帧胜出** / 错误帧捕获 |
| ProtocolAdapter | 接口：chat / embeddings / usage 归一化 / 错误映射 / **参数抹平（透传基底 + 规则驱动：ignore/clamp/map）**；一期唯一实现 `OpenAICompatibleAdapter` |
| Streaming 控制 | 心跳注入（静默 >30s，仅 SSE 事件边界）、abort 传播、空完成判定（probe）、流式错误帧转换 |
| Errors | 统一错误模型：code / retryable / circuitTrip / deadCredential（死凭据文本特征） |
| Retry | 同渠道重试：指数退避 + jitter + 总 deadline + maxAttempts（含**空完成重试**） |
| Breaker | 熔断原语：closed / open / half-open 状态机 + 滚动窗口计数 + Storage 接口 |
| Usage 归一化 | `{inputTokens, cachedInputTokens, outputTokens, estimated}`——各供应商缓存字段归一化 |
| 事件输出 | 调用全生命周期事件（attempt / usage / stream_error / aborted / failed / empty / success） |

**不做（边界，全部留在 gateway / worker）**：
- 鉴权 / 预扣 / 限流 / 渠道路由 / 模型映射 / 费率卡
- 计费 / 结算 / 计量落库（包只发事件，gateway 转 bull:meter）
- 对外 HTTP 表面（Hono 路由、入站 SSE、错误信封组装）
- 换渠道 / fallback 模型编排（**候选循环是 gateway 的职责**，包只负责"单个候选内的重试"）

## 4. 核心类型

```ts
// ---- 输入（由 gateway 注入） ----
interface ChannelDesc {
  baseUrl: string          // 已验证（SSRF 防护在配置层）
  apiKey: string           // gateway 解密后传入，包内不落盘
  protocol: 'openai-compatible'   // 一期仅此值
}

interface RequestCtx {
  requestId: string        // 幂等键
  model: string            // 真实模型名
  providerName: string     // 厂商名（deepseek/glm/...，用于加载 profiles 默认规则）
  paramRules?: ParamRules  // 钳制规则（来自 model_mappings，per-model 覆盖 profile）
  maxRetries?: number      // 默认 3
  deadlineMs?: number      // 总 deadline，默认 240s
}

interface ParamRules {
  ignore?: string[]        // 删除：该模型不支持、传了会 400 的参数（如 reasoner 的 temperature）
  clamp?: Record<string, { min?: number; max?: number }>   // 钳制：超范围会 400 的（如 max_tokens ≤ 8192）
  map?: Record<string, { to: string }>   // 改写：参数改名（如 max_tokens ↔ max_completion_tokens）
  unknown?: 'passthrough' | 'drop'       // 未知参数策略，默认 passthrough（透传）
}

// ---- usage 归一化（缓存计费数据源） ----
interface Usage {
  inputTokens: number
  cachedInputTokens: number   // 缓存命中（OpenAI cached_tokens / DeepSeek cache_hit 归一化）
  outputTokens: number
  estimated: boolean          // usage 缺失，按字符估算
  raw: unknown                // 原始 usage 保留（排查/审计）
}

// ---- 统一错误模型 ----
interface UpstreamError extends Error {
  status?: number            // undefined = 网络/超时
  code: string               // invalid_api_key / rate_limited / upstream_error / timeout / network / model_not_found ...
  retryable: boolean         // 是否值得重试
  circuitTrip: boolean       // 是否计入熔断（5xx/网络/超时 = true；429/4xx/死凭据 = false）
  deadCredential: boolean    // 死凭据标记（401/403 + 错误文本特征）
  suggestion?: string        // 可操作建议（进错误信封）
  rawBody?: string           // 上游响应体（脱敏前，仅日志）
}

// ---- 事件 ----
type AiEvent =
  | { type: 'attempt_start'; requestId: string; channelKey: string; attempt: number }
  | { type: 'param_adjustment'; requestId: string; param: string; action: 'ignore' | 'clamp' | 'map'; from?: unknown; to?: unknown }
  | { type: 'usage'; requestId: string; usage: Usage; streamError?: StreamError }
  | { type: 'stream_error'; requestId: string; frame: StreamError }
  | { type: 'aborted'; requestId: string; reason: 'client_disconnect' | 'inactivity' | 'deadline' }
  | { type: 'failed'; requestId: string; error: UpstreamError }
  | { type: 'empty_completion'; requestId: string; attempt: number }
  | { type: 'success'; requestId: string; usage?: Usage; durationMs: number }

interface StreamError { code: string; type?: string; detail?: string }

// ---- 返回 ----
type ChatResult =
  | { status: 'success'; usage?: Usage; durationMs: number }
  | { status: 'empty' | 'error'; error?: UpstreamError; durationMs: number }

interface ChatStreamResult {
  stream: ReadableStream<Uint8Array>   // 透传管道（含心跳注入与错误帧转换）
  onEvent: (cb: (e: AiEvent) => void) => void
}
```

## 5. 对外 API

```ts
interface AiConfig {
  retry: { maxAttempts: number; baseDelayMs: number; maxDelayMs: number; jitterRatio: number; deadlineMs: number }
  breaker: { windowMs: number; failureThreshold: number; cooldownMs: number; halfOpenProbe: boolean }
  stream: { heartbeatIdleMs: number; inactivityTimeoutMs: number }
  timeout: { connectMs: number; totalMs: number }
  estimate: { charPerToken: number }     // 默认 3.5
}
interface AiDeps {
  logger?: Logger                    // 接口注入（pino 实现由宿主提供）
  tracer?: Tracer                    // OTel 接口注入（宿主提供实现，包零 OTel 依赖）
  breakerStorage?: BreakerStorage    // Redis 实现由 gateway 提供（多实例共享）
}

createAi(config: AiConfig, deps?: AiDeps): Ai

interface Ai {
  // 非流式（自动 withRetry：可重试错误 + 空完成重试）
  chat(input: { channel: ChannelDesc; request: unknown; ctx: RequestCtx }): Promise<ChatResult>
  // 流式（透传管道；重试仅限首字节前，流开始后失败发错误帧不重试）
  chatStream(input: { channel: ChannelDesc; request: unknown; ctx: RequestCtx }): Promise<ChatStreamResult>
  // 连通性探测（admin-api 渠道测试用：优先 /v1/models，回退最小补全）
  probe(channel: ChannelDesc): Promise<{ ok: boolean; durationMs: number; error?: UpstreamError }>
}
```

## 6. 内部结构

```
packages/ai/
├── package.json               # deps: eventsource-parser, zod；dev: vitest, typescript
├── src/
│   ├── index.ts               # 公共出口（createAi + 类型）
│   ├── create-ai.ts           # 组装：适配器注册表（protocol→adapter）+ withRetry + breaker 绑定
│   ├── config.ts              # zod schema（AiConfig 校验，默认值）
│   ├── events.ts              # AiEvent / StreamError
│   ├── types.ts               # ChannelDesc / RequestCtx / Usage / UpstreamError / Result
│   ├── transport/
│   │   ├── http-client.ts     # fetch 封装：connect 超时 / abort 信号 / URL 校验
│   │   ├── sse-parser.ts      # eventsource-parser 薄封装：增量解析 + usage 最后帧 + 错误帧捕获
│   │   └── relay-stream.ts    # 透传管道：心跳注入（事件边界）/ abort 传播 / 错误帧转换
│   ├── adapters/
│   │   ├── protocol-adapter.ts    # ProtocolAdapter 接口（含参数抹平执行引擎）
│   │   ├── openai-compatible.ts   # 一期实现（透传 + 规则抹平 + usage 归一化 + 错误映射）
│   │   └── profiles/              # provider profile（内置默认规则，per-model 规则可覆盖）
│   │       ├── index.ts           # 按 protocol 加载 profile
│   │       ├── deepseek.ts · glm.ts · qwen.ts · minimax.ts · openai.ts
│   ├── usage/
│   │   └── normalize.ts       # 缓存字段归一化（OpenAI cached_tokens / DeepSeek cache_hit+miss）
│   ├── errors/
│   │   └── classify.ts        # 错误分类矩阵 + 死凭据文本特征
│   ├── retry/
│   │   └── with-retry.ts      # 指数退避 + jitter + deadline；空完成重试（≤2）
│   └── breaker/
│       ├── breaker.ts         # 状态机原语（closed/open/half-open + 滚动窗口）
│       └── storage.ts         # BreakerStorage 接口（Redis 实现由 gateway 注入）
└── test/
    ├── unit/                  # sse-parser / classify / with-retry / normalize / breaker
    └── integration/           # mock 上游（本地 HTTP 服务）：正常 SSE / 断流 / 空 200 / 429 / 401 / 超时
```

## 7. 关键机制设计

### 7.1 错误分类矩阵（errors/classify.ts）

| 上游表现 | code | retryable | circuitTrip | deadCredential |
|---|---|---|---|---|
| 5xx | upstream_error | ✅ | ✅ | |
| 网络错误 / 超时 | network / timeout | ✅ | ✅ | |
| 429 | rate_limited | ✅ | ❌ | |
| 401 / 403（含文本特征：invalid api key / 认证失败） | invalid_api_key | ❌ | ❌ | ✅ |
| 400 / 404 | invalid_request / model_not_found | ❌ | ❌ | |
| 200 但空内容 | empty_completion | ✅（≤2 次） | ❌ | |

### 7.2 熔断器（breaker/，包内原语）

```
closed ──60s 窗口失败 ≥5 次 或 5xx 率 >50%──▶ open（拒绝 5min，快速 503）
  ▲                                              │冷却到期
  └─────────── 探测成功 ──────────────────────◀ half-open（放 1 个请求试探）
                                                     │失败 → 立即回 open
```
- **计数只收 `circuitTrip=true` 的错误**（5xx/网络/超时）——429/4xx/死凭据不跳闸（一个用户的坏 Key 不应熔断整个渠道）
- 状态持久化走 `BreakerStorage`（gateway 注入 Redis 实现）→ 多实例共享熔断状态
- 熔断按 `channelKey` 维度，熔断中的渠道在 gateway 路由层被跳过

### 7.3 重试与候选循环的分工（重要边界）

```
包内 withRetry（同渠道）          gateway 候选循环（换渠道 / fallback 模型）
  ├─ 可重试错误（5xx/429/超时）       ├─ 消费 failed / empty_completion 事件
  ├─ 空完成重试（≤2 次，退避）        ├─ 熔断/凭据无效渠道过滤
  └─ 仅限「首字节前」                └─ 全部耗尽 → fallback 模型 / 503
  （流开始后失败 → 发错误帧，不重试）
```

### 7.4 流式管道（relay-stream.ts）

```
上游 SSE ──▶ sse-parser（增量扫描：usage 最后帧胜出 / 错误帧记录）
       ──▶ 输出流（透传 + 心跳注入：静默 >30s 发 ': keep-alive'，仅事件边界）
       ──▶ 事件回调（usage / stream_error / aborted）
abort：客户端断 → 断上游 reader（停止生成）；静默 ≥5min → 断流 + 错误帧
```

### 7.5 usage 归一化（usage/normalize.ts）

| 供应商 | 原始字段 | 归一化 |
|---|---|---|
| OpenAI 风格 | `prompt_tokens_details.cached_tokens` | cachedInputTokens |
| DeepSeek | `prompt_cache_hit_tokens` | cachedInputTokens（`cache_miss` 计入未缓存） |
| 无缓存字段 | — | cachedInputTokens = 0 |
| usage 缺失 | — | 按 `estimate.charPerToken`（3.5）估算，`estimated=true`，全部按未缓存计 |

### 7.6 参数抹平策略（透传为基底，规则驱动）

**原则**：不硬编码各家差异——适配器只实现"规则的执行引擎"，规则本身可配置。**响应方向不抹平**（`reasoning_content` 等特有字段原样透传），只有 usage（内部计量）与错误（统一信封）做归一化。

**四级参数策略**（`ParamRules`，见 §4）：

| 策略 | 含义 | 例子 |
|---|---|---|
| passthrough（默认） | 原样透传，不校验 | 绝大多数参数——wire 兼容底线 |
| ignore | 该模型不支持、传了会 400 的参数 → 删除 | reasoner 的 `temperature` |
| clamp | 超范围会 400 的 → 钳制到上限 | `max_tokens` > 8192 → 8192 |
| map | 参数改名/换算 | `max_tokens` ↔ `max_completion_tokens`（OpenAI 新模型） |

**规则来源两层，per-model 覆盖**：

```
provider profile（packages/ai/src/adapters/profiles/*.ts 内置默认）
        ×
model_mappings.param_rules（DB 配置，运营可调）
        = 生效规则（per-model 优先）
```

**执行引擎**（adapter 内）：

```ts
interface ProtocolAdapter {
  protocol: string
  // 请求方向：透传为基底，按规则抹平，返回调整记录（进 param_adjustment 事件）
  normalizeRequest(req: unknown, rules: ParamRules): { body: unknown; adjustments: ParamAdjustment[] }
  // 响应方向：仅提取计量与错误，正文透传
  extractUsage(res: unknown): Usage | null
  mapError(status: number, body: unknown): UpstreamError
  probePaths(): string[]    // ['/v1/models', 最小补全]
}
type ParamAdjustment = { param: string; action: 'ignore' | 'clamp' | 'map'; from?: unknown; to?: unknown }
```

**可观测**：每次抹平产生 `param_adjustment` 事件（requestId / 参数 / 动作 / 原值→新值）——排障时能看出"客户端传了什么、网关改了什么"。

## 8. 与 gateway 的职责划分

| 职责 | ai 包 | gateway |
|---|---|---|
| 调用上游 / SSE 解析 / usage 归一化 / 错误分类 | ✅ | |
| 心跳注入 / abort / 空完成判定 / 同渠道重试 | ✅ | |
| 熔断机制（原语 + Storage 接口） | ✅ | 注入 Redis Storage 实现 |
| 候选循环（换渠道 / fallback 模型） | | ✅ 消费事件编排 |
| 鉴权 / 预扣 / 限流 / 路由 / 模型映射 | | ✅ |
| 计量事件 / 结算 | | ✅（ai 事件 → bull:meter） |
| 错误信封组装 / 入站 SSE（Hono） | | ✅ |
| 渠道测试（admin-api 复用 probe） | ✅ | 接线 |

## 9. 测试策略

**unit（纯函数高覆盖，包的核心价值）**：
- `sse-parser`：多行 data / 注释行 / 心跳帧 / 错误帧 / usage 帧 / 最后帧胜出
- `classify`：错误分类矩阵全量断言（含死凭据文本特征）
- `with-retry`：退避抖动范围 / deadline 截断 / 空完成重试次数
- `normalize`：OpenAI / DeepSeek 缓存字段矩阵
- `breaker`：状态机全转移（closed→open→half-open→closed/回open）、429 不计数

**integration（mock 上游 = 本地 HTTP 服务）**：
- 正常 SSE 流 → 断言事件序列 + 输出流内容一致
- 流中途断 / 空 200 / 429 / 401 / 超时 → 断言 retryable/circuitTrip 与事件

## 10. 二期扩展

- `AnthropicAdapter` / `GeminiAdapter`：实现 `ProtocolAdapter` 接口（格式转换 + usage 映射 + 错误映射），届时评估是否局部引 SDK provider 包（仅转换、不透传，见 tech-stack §9）
- `Storage` 的 Redis 实现：gateway 侧提供（ioredis + Lua 原子读写）
- embeddings 适配：一期 `OpenAICompatibleAdapter` 直接支持（透传 + usage）
