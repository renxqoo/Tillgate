# @tokenlens/ai 重构实现文档

> 状态：设计定稿，待实施
> 基线：旧仓 `ai-getway/packages/ai`（v1，112 文件 ~9k 行，444 测试）
> 目标：壳全新、机制重构移植、已知缺陷修复；**功能零缺失**——旧测试套件是行为规格

---

## 0. 原则

1. **不是复制，是重构**：每个模块逐一裁决 复制/重构/重写，裁决理由写明。
2. **功能完整性以测试为证**：v1 的 444 个测试（尤其 4 个 `.bug.test.ts` 回归）是行为规格；迁移后行为等价或明确更优。
3. **三不变量**：数据面零处理透传（例外仅清单三条）、一切跨请求关切是订阅者、策略必注入机制内置。
4. **并发预算是硬约束**：单线程模型下每帧同步工作 ≤ ~3μs 量级，写进延迟门禁。

---

## 1. 外部契约（v2 API，已定稿）

```ts
const ai = createAi(defaults?, { logger?, tracer?, guardUrl? }, { adapters? })

ai.chat(channel, request, opts?)          → Promise<ChatResult>       // 判别联合
ai.chatStream(channel, request, opts?)    → Promise<{ stream, events }>
ai.use(channel)                           → ChannelClient            // 闭包糖，同一内核
ai.subscribe(observer) → 退订             // 全局观察面（装配时挂一次，快照迭代）
ai.probe(channel)
ai.tasks.{ parse, query, file }           // 生成任务族

// ChannelClient：chat/stream/embed/probe —— endpoint 进方法名，'chat' 为默认族
```

- `opts` 全可选平铺：`requestId`（缺省 randomUUID）、`model`（覆盖 request.model 并写入 body/form——网关的对外名→真实名在此完成）、`endpoint`（缺省 'chat'）、`signal`、`paramRules`、`providerName`、`maxRetries`、`deadlineMs`。
- `ChatResult = { ok: true, usage?, body?, rawBody?, rawContentType?, durationMs } | { ok: false, error, durationMs, empty? }`。
- 事件时序契约不变：`attempt_start*` → `first_chunk`（TTFB 锚，一次性）→ `param_adjustment*` / `usage*`（累计最新者胜出）→ `stream_error*` → `aborted?` → `success|failed`（终态保证最后，`terminated` 随行）。
- `AiDeps` 无状态存储（v1 的 breaker/dead-credential 注入点不恢复）。

---

## 2. 目标目录结构

```text
packages/ai/
├── package.json / tsconfig.json / vitest.config.ts / README.md
├── IMPLEMENTATION.md          # 本文档
└── src/
    ├── index.ts               # 唯一公共出口（门面 + 显式 exports）
    ├── create-ai.ts           # 装配壳：chat/chatStream/use/subscribe/probe/tasks
    ├── types.ts               # 外部契约：ChannelDesc/CallOptions/ChatResult/Ai/…
    ├── config.ts              # AiDefaults（retry/stream/timeout）+ AiDeps（logger/tracer/guardUrl）
    ├── events.ts              # AiEvent 判别联合（时序契约注释）
    ├── pipeline/              # 执行编排
    │   ├── context.ts         # emitTo（快照迭代）/channelKey/retryOptionsOf/前置校验
    │   ├── prepare.ts         # 参数抹平（vendor profile + paramRules 合并 → 规则引擎）
    │   ├── chat.ts            # 非流式单次尝试体（withRetry 回调）
    │   ├── chat-stream.ts     # 流式单次尝试体（首帧探测，重试仅限首字节前）
    │   ├── stream-report.ts   # per-call 事件总线（终态缓冲+重放）+ relay→AiEvent 翻译
    │   ├── probe.ts           # 渠道探测
    │   └── generation-ops.ts  # 任务族操作面
    ├── transport/             # 传输层
    │   ├── http-client.ts     # fetch 封装：guard 注入 + 超时 + 取消传播 + 错误分类 + 限长读体
    │   ├── relay-stream.ts    # 透传管道：pipeThrough 逐块、旁路扫描、心跳/静默守护、取消传播
    │   └── sse-parser.ts      # SSE 增量扫描器（每帧预算受控）
    ├── protocol/              # 协议族编解码（wire 知识，复制为主）
    ├── adapters/              # 厂商适配器（寻址/认证/终改/错误映射）
    ├── usage/                 # 计量：归一/估算/校准/媒体时长
    ├── registry/              # 适配器注册表 + vendor profiles
    ├── retry/                 # withRetry（退避+jitter+deadline+空完成预算）
    ├── errors/                # classify（分类表）+ internal（包内策略错误）+ overflow + server-drain
    ├── generation/            # task-adapter（任务族 port 组合）
    └── internal/              # util/stream 小件（不导出）
```

分层依赖单向：`create-ai → pipeline → {transport, adapters, registry} → {protocol, usage, errors}`；`types/config/events` 是叶子契约。

---

## 3. 逐模块裁决表

> **裁决语义**：「复制」= **审计通过后复制**，不是盲搬。审计四条标准：① 正确性（边界、错误路径）；② 契约符合 v2（零跨请求状态、无策略数据、无隐藏默认）；③ 实现质量（职责单一、无重复、热路径预算）；④ 依赖方向干净。审计不通过 → 升级为重构，发现记录在 §4。P3 移植阶段逐文件执行，本表随审计进度更新状态。

| 模块（v1 规模） | 裁决 | 审计状态 | 理由与动作 |
|---|---|---|---|
| `retry/with-retry.ts` | 复制 | ✅ 已审计通过 | full jitter（AWS 策略）、AbortSignal.any 合并、deadline finally 清理、空完成独立预算、sleep 可中止——全部正确。微注：Math.random 不可注入（测试以 jitter=0 规避） |
| `errors/classify.ts` | 复制 | ✅ 已审计通过 | 分类矩阵数据化、body code 精确匹配优先于文本特征、401 恒死凭据 vs 403 按特征、模式表可配置扩展 |
| `transport/sse-parser.ts` | **重构** | ✅ 已审计（升级） | 发现 4 项，见 §4.5 |
| `transport/relay-stream.ts` | **重构** | ✅ 已审计（升级） | 发现 2 项，见 §4.6；透传语义/atBoundary 边界判定/错误帧终止序列本身正确 |
| `protocol/*`（1.4k 行） | 复制 | ⏳ 待审计（P3） | wire 格式知识；逐文件审计后移植 |
| `adapters/*`（1.4k 行） | 复制 | ⏳ 待审计（P3） | 厂商寻址/认证/终改知识；审计时重点核 SigV4/事件流解析的边界处理 |
| `usage/calibration、media-duration、tokenizer、model-meta`（~1.2k） | 复制 | ⏳ 待审计（P3） | 校准数据表；核对数据生成脚本的口径注释 |
| `usage/token-estimate、normalize`（~1k） | 复制+接口适配 | ⏳ 待审计（P3） | 估算算法保留；入口接类别计数器形态 |
| `registry/*` | 复制 | ⏳ 待审计（P3） | vendor profiles 数据表 |
| `errors/internal.ts` | 重构 | — | 删熔断/死凭据错误；保留 empty/aborted/serverDraining/invalidConfig/unsupportedProtocol |
| `transport/http-client.ts` | 重写 | — | guard 注入模型定稿；DNS 逐地址判定、超时、错误分类保留语义重写 |
| `pipeline/chat、chat-stream、stream-report、probe、generation-ops、prepare` | 重构 | — | 尝试体/事件翻译/探测逻辑保留；签名换新；fail 收敛去状态化 |
| `pipeline/context.ts` | 重写 | — | emitTo 快照迭代；channelKey 语义改事件维度 |
| `create-ai/types/config/index/events` | 全新写 | — | 新 API 壳（§1） |
| `generation/task-adapter` | 复制+接线适配 | ⏳ 待审计（P3） | port 组合 |
| `breaker/、dead-credential/、admission、memory-storage` | 不移植 | — | 零运维状态裁决 |

---

## 4. 已识别缺陷与重构修复项

v1 实测确认（本会话逐文件核验）：

1. **运维状态在库内**——breaker/dead-credential 以注入存储形式住在包里，gateway 是唯一注入者 → v2 移除；`circuitTrip`/`deadCredential` 分类标志保留在 `UpstreamError` 随事件流出（inference/health 的计数输入）。
2. **SSRF 策略进配置**——`allowLocalUrl`/`allowedHosts` 在 `AiConfig`，且 gateway 从未传过 `allowedHosts`（死配置）→ v2 删除；`guardUrl` 注入，缺省机械基线（https-only + 禁私网/回环 + DNS 逐地址防 rebinding）。
3. **emitTo 退订竞态**——分发中 `off()`（splice）使 `for...of` 跳过下一监听器 → 快照迭代。
4. **三层嵌套 API + 双 model**——`{channel, request, ctx}` 且 `ctx.model`（真实名）与 `request.model`（对外名）分离 → 平参数 + 单 model（`opts.model` 覆盖并回写）。
5. **（已证实）sse-parser 四项**：① `outputText += piece.join('')` 字符串拼接——V8 rope 摊还尚可，但 `OUTPUT_TEXT_CAP = 4MB`：万级并发流 × 4MB 上界 = **40GB 潜在内存**，估算只需字符类别计数（O(1) 内存）；② 注释称"usage 帧到达时清零重计"，**代码无此逻辑**（注释与实现不一致）；③ `reset()` 不 flush streaming decoder（复用场景残留截断多字节序列）；④ `lastLineEnded` 命名误导（实为"曾有过行结束"）。→ 重构：类别计数器替代文本累积、注释对齐、decoder 语义明确。
6. **（已证实）relay-stream 两项**：① **每流一个 `setInterval`**（默认 250ms 间隔）——万级流 = 4 万次/秒定时器唤醒，全局单 timer 扫描活跃流表更优；② emit 的 `for...of` 直接迭代数组（同 emitTo 退订竞态模式）——快照迭代统一。→ 重构：全局 sweeper、快照迭代；透传语义与 atBoundary 心跳边界判定保留（正确且精巧）。

## 5. 并发与性能约束（进延迟门禁）

- **每帧同步预算**：decode + 行切 + 小帧 parse + 计数器累加 ≤ ~3μs 量级（万级并发流下事件循环占比 ≤ ~10%）。
- **零跨帧缓冲**：唯一跨帧状态 = 计数器 + 不完整行尾巴（<1KB）。
- **全局 timer**：心跳/静默检查单 interval 扫描，不每流一个。
- **背压链不可破坏**：任何路径不得出现无界缓冲；`pipeTo` 停读必须传导至上游。
- **回调微秒级**：observer 契约无 IO 无 await；重活入队（outbox 侧）。
- **取消即时**：三路（signal / pipeTo 取消 / inactivity 兜底）都必须取消上游 fetch。

## 6. 测试策略（功能完整性证明）

| v1 测试 | v2 去处 | 动作 |
|---|---|---|
| `*.bug.test.ts`（server-drain / firstframe-leak / stream-peek-leak / first-byte-timeout） | `test/streaming/` | **必须移植**——回归资产 |
| protocol 编解码测试 | `test/protocol/` | 移植 |
| usage/classify/model-meta/calibration 测试 | `test/usage/` | 移植 |
| create-ai 集成测试（重试/参数抹平/usage/事件序列） | `test/contract/` | 移植 + 改写为新 API 签名；删熔断/死凭据联动用例（v1 已裁决，非功能缺失） |
| 无 | `test/latency/` | **新写**：每帧预算、快照迭代、无界缓冲断言 |
| `test/real/` | `test/real/` | 移植（凭证隔离，默认 skip） |

验收：四门（typecheck/lint/test/build）全绿；对照 v1 行为清单逐项确认（透传、重试、超时矩阵、取消三路、usage 归一/估算、param_adjustment、probe、任务族、SSRF 基线）。

## 7. 实施顺序（每阶段独立提交）

1. **P1 壳**：types/config/events/index/create-ai 骨架 + context（快照 emitTo）——可编译，测试空跑。
2. **P2 传输**：http-client（guard 模型）→ sse-parser（计数器化）→ relay-stream（timer 模型）+ streaming 测试移植。
3. **P3 机制移植**：errors → retry → registry → protocol → adapters → usage + 对应测试移植。
4. **P4 管线**：prepare/attempts/stream-report/probe/generation-ops 接新签名 + contract 测试改写。
5. **P5 收口**：README、latency 门禁、全量四门、行为对照清单核销。
