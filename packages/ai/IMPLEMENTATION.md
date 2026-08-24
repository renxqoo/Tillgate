# @tillgate/ai 重构实现文档

> 状态：已实施(收口轮:出站改写/脱敏/延迟测试落地;real 上游契约测试已移植,见 §4.8)
> 基线：旧仓 `ai-getway/packages/ai`（v1，112 文件 ~9k 行，444 测试）——全部 30 个源文件已逐一审计
> 目标：壳全新、机制重构移植、8 个真 bug 修复；**功能零缺失**——旧测试套件是行为规格

---

## 0. 原则

1. **不是复制，是重构**：每个模块逐一裁决，裁决基于逐文件审计而非"信战斗测试"。
2. **功能完整性以测试为证**：v1 的 444 个测试（尤其 4 个 `.bug.test.ts` 回归）是行为规格。
3. **三不变量**：数据面零处理透传（例外仅清单三条）、一切跨请求关切是订阅者、策略必注入机制内置。
4. **并发预算是硬约束**：每帧同步工作 ≤ ~3μs 量级，万级并发流的内存 = 每流常数 KB。

---

## 1. 外部契约（v2 API，已定稿）

```ts
const ai = createAi(defaults?, { logger?, tracer?, guardUrl? }, { adapters? })

ai.chat(channel, request, opts?)          → Promise<ChatResult>       // 判别联合
ai.chatStream(channel, request, opts?)    → Promise<{ stream, events }>
ai.use(channel)                           → ChannelClient            // 闭包糖：chat/stream/embed/probe
ai.subscribe(observer) → 退订             // 全局观察面（装配挂一次，快照迭代）
ai.probe(channel)
ai.tasks.{ parse, query, file }
```

- `opts` 全可选平铺：`requestId`（缺省 randomUUID）、`model`（覆盖并回写 request.model）、`endpoint`（缺省 'chat'）、`signal`、`paramRules`、`providerName`、`maxRetries`、`deadlineMs`。
- `ChatResult = { ok: true, usage?, body?, rawBody?, rawContentType?, durationMs } | { ok: false, error, durationMs, empty? }`。
- 事件时序不变：`attempt_start*` → `first_chunk` → `param_adjustment*` / `usage*`（最新者胜出）→ `stream_error*` → `aborted?` → `success|failed`（终态保证最后，`terminated` 随行）。

---

## 2. 全量审计结论（30 文件）

### 2.1 真 bug 清单（8 项，计费/数据丢失优先）

| #   | 位置                                   | 问题                                                                                                                                                             | 级别     |
| --- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| B1  | `usage/token-estimate.ts` L238/240/242 | 输出侧 reasoning/tool_calls/text 未透传 `opts.model` → 恒走启发式；与 L234 自我声明的口径要求矛盾，同一响应 content 用 BPE、reasoning 用启发式，**估算口径分裂** | 估算精度 |
| B2  | `protocol/gemini-chat.ts` L287/292     | Gemini 流式尾帧/中间帧 usage 丢 `prompt_tokens_details.cached_tokens`（非流式 L240 有）→ **流式缓存折扣漏记**                                                    | 计费     |
| B3  | `usage/normalize.ts` L74/75            | total 不一致即弃整个 usage（部分代理 total 含额外分量→真实 usage 静默丢弃退估算）；0/0 弃用后估算可能非零（多计）。**零观测**                                    | 计费     |
| B4  | `adapters/vertex-ai.ts` extractUsage   | translate 后恒 null（gemini.ts 有双形兜底，vertex 漏抄）→ **全部落字符估算**                                                                                     | 计费     |
| B5  | `transport/http-client.ts` L153/195    | `resolveAndPin` 的 DNS pin 结果从未使用，fetch 用原 URL 重解析——**rebinding TOCTOU 窗口实际存在**（白名单是实际防线，pin 是死代码）→ **已收口（§6）**            | 安全     |
| B6  | `generation/task-adapter.ts` L70/105   | 任务协议未注册返回误导错误 `'Upstream did not return a task ID'`；succeeded 后 file 取回永久失败 → 任务永卡 running                                              | 正确性   |
| B7  | `protocol/completions-chat.ts` L41     | 非流式 n>1 只回 `choices[0]`，**其余 choice 丢弃**                                                                                                               | 数据丢失 |
| B8  | `errors/overflow.ts` L39-40            | `/too many tokens/i` 等通用兜底可能把「max_tokens 输出超限」误判为上下文溢出——误分类被「不可重试+不换渠道」语义放大                                              | 正确性   |

### 2.2 结构性缺陷（v1 会话逐行核验）

| #   | 位置                | 问题                                                                                                                                                                                                                                                                                                        |
| --- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `sse-parser.ts`     | `outputText +=` 拼接 + 4MB CAP——万级并发流潜在内存上界 40GB；注释"usage 帧到达时清零重计"与实现不符；`reset()` 不 flush 流式 decoder                                                                                                                                                                        |
| S2  | `relay-stream.ts`   | **每流一个 `setInterval`**（默认 250ms）——万级流 = 4 万次/秒定时器唤醒；emit 数组迭代退订竞态                                                                                                                                                                                                               |
| S3  | 全包                | **两套 SSE 解析实现并存**（sse-parser 用 eventsource-parser 库；stream-convert 手写行缓冲）——行为漂移风险                                                                                                                                                                                                   |
| S4  | `stream-convert.ts` | 用 `new ReadableStream({pull})` 模式，与 relay-stream 头注释"必须 pipeThrough 防 node-server 缓冲"的经验矛盾（需实测）                                                                                                                                                                                      |
| S5  | 契约层              | `normalizeRequest(req, rules)` 缺 endpoint → openai-compatible 的 `unknown:'drop'` 用 **chat 词表删非 chat 端点合法参数**（embeddings 的 `input`、images 的 `n/quality` 不在集合内——契约级潜伏雷）；`amzDate` 泄漏进通用签名钩子；**无 endpoint 能力声明面**（azure/dashscope 覆写缺口只能靠上游 404 暴露） |
| S6  | `types.ts`          | 七值 TerminationReason 在 events.ts/relay-stream.ts **三处手抄**，漂移风险实打实                                                                                                                                                                                                                            |

### 2.3 重复代码清单（9 项，重构时提取）

| #   | 重复                                                                 | 位置                                                            |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| D1  | asJson/asArray/str 三件套逐字×3，且与 `asRecord`（接受数组）语义冲突 | gemini-chat / completions-chat / responses-chat / internal-util |
| D2  | readBody/readRawBody 读循环 90%                                      | http-client                                                     |
| D3  | relay done 事件构造×3                                                | relay-stream finishOk/fail/cancel                               |
| D4  | OpenAI 形 usage 提取×2                                               | adapters/gemini + anthropic                                     |
| D5  | gemini/vertex codec 装配 ~60 行                                      | adapters                                                        |
| D6  | task-adapter submit/execute 骨架 90%                                 | generation                                                      |
| D7  | Gemini usage 字面量×3（顺带修 B2）                                   | gemini-chat                                                     |
| D8  | claude flush 兜底与主路径 usage 构造                                 | claude-chat L400-417 vs L431-447                                |
| D9  | 帧构造的 `created: Date.now()/1000` 每帧重算                         | claude/gemini codec                                             |

### 2.4 逐文件裁决总表

| 文件                                              | 裁决        | 要点                                                                                                                                |
| ------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `retry/with-retry`                                | ✅ 复制     | 全对（full jitter/信号合并/预算分离）                                                                                               |
| `errors/classify`                                 | **重构**    | 拆为：status 兜底分类器 + kind→机制位派生表（§3.2）；正则迁入各 adapter 档案                                                        |
| `errors/overflow`                                 | 复制+微修   | B8 由 §3.2 结构化消解（context_overflow 精确 code 命中），通用正则兜底收窄                                                          |
| `errors/server-drain`                             | ✅ 复制     | 无瑕疵                                                                                                                              |
| `errors/internal`                                 | 重构        | 删熔断/死凭据错误构造                                                                                                               |
| `usage/token-estimate`                            | 复制+微修   | B1 三处 model 补传；暴露 `estimateTokensFromFeatures`（见 §3.3）                                                                    |
| `usage/normalize`                                 | 复制+微修   | B3 弃真处加观测事件/日志钩子                                                                                                        |
| `usage/calibration`、`tokenizer`                  | ✅ 复制     | 无瑕疵（provider offset 语义不对称无实际影响）                                                                                      |
| `usage/media-duration`                            | 复制+微修   | L37 死子句删除                                                                                                                      |
| `registry/vendor-profiles`、`define-adapter`      | 复制+微修   | 数据驱动优等；vendor-profiles 扩展 `errorPatterns` 字段（§3.2 正则迁入）                                                            |
| `internal/stream`                                 | ✅ 复制     | peekFirstChunk 竞态处理全仓最佳                                                                                                     |
| `internal/util`                                   | 重构        | 统一 as 三件套（拒数组语义，D1）                                                                                                    |
| `protocol/claude-chat`                            | 复制+微修   | 质量高；D8/D9                                                                                                                       |
| `protocol/gemini-chat`                            | 复制+微修   | **B2 计费修复**；D7/D9；tool_call id 合成跨消息重号（低概率，记录）                                                                 |
| `protocol/completions-chat`                       | 复制+微修   | B7 n>1                                                                                                                              |
| `protocol/responses-chat`                         | 复制+微修   | completed 事件 output 空回放（记录为已知限制）                                                                                      |
| `protocol/stream-convert`                         | **重构**    | S3/S4：并入统一 SSE 原语                                                                                                            |
| `adapters/protocol-adapter`                       | **重构**    | 契约演进（S5）：normalizeRequest 加 endpoint、签名钩子通用化、能力声明面；mapError 契约按 §3.2 表化（kind 翻译 + 机制位禁逐例声明） |
| `adapters/openai-compatible`                      | 复制+微修   | unknown-drop 词表随契约修；原型键防护补齐；9 层三元改查表                                                                           |
| `adapters/anthropic`                              | 复制+微修   | D4 共享提取                                                                                                                         |
| `adapters/gemini`、`vertex-ai`                    | **重构**    | D5 组合化；**B4 修复**；tokenCache 良性竞态文档化                                                                                   |
| `adapters/azure-openai`                           | 复制+微修   | api-version 可配置；endpoint 覆写面声明                                                                                             |
| `adapters/minimax`                                | 复制+微修   | 'Unknown'→running 永挂面文档化（上限归 worker）；静默默认保留（已注释声明）                                                         |
| `adapters/dashscope`、`task-kit`                  | 复制+微修   | task-kit 数组体守卫                                                                                                                 |
| `generation/task-adapter`                         | 复制+微修   | B6 错误修正；D6 骨架合并                                                                                                            |
| `transport/http-client`                           | **重写**    | guard 模型定稿；**B5 处置：删除死 pin，白名单+逐地址判定即防线，文档说明**；D2                                                      |
| `transport/relay-stream`                          | **重构**    | S2 全局 sweeper；D3；快照迭代                                                                                                       |
| `transport/sse-parser`                            | **重构**    | S1 四计数器化；decoder 语义                                                                                                         |
| `types/config/events/index/create-ai/pipeline 壳` | 全新写/重构 | §1 API；S6 TerminationReason 收编；`ErrorKind` 封闭词表 + kind→机制位派生表（§3.2）                                                 |

---

## 3. v2 代码拆分（审计驱动的增量决策）

### 3.1 目录结构

```text
src/
├── index.ts / create-ai.ts / types.ts / config.ts / events.ts   # 壳层
├── pipeline/    # context(快照emitTo/CallCtx) prepare chat chat-stream stream-report probe
│                # generation-ops attempt-chat attempt-stream tasks(2026-08-23 拆出,铁律5 max-lines)
├── transport/   # http-client(guard) relay-stream(全局sweeper) sse(统一解析原语)
├── protocol/    # claude-chat/-stream gemini-chat/-stream/-shared(同款拆分) completions-chat responses-chat
├── adapters/    # protocol-adapter(契约) openai-compatible anthropic gemini vertex azure minimax dashscope task-kit shared(D4)
├── usage/       # normalize token-estimate(含 features 入口) calibration tokenizer media-duration model-meta*
├── registry/    # vendor-profiles define-adapter
├── retry/ errors/ generation/ internal/(stream json)
```

**2026-08-23 拆分注记**（oxlint max-lines 500 门禁收口，行为零变化——365 用例全绿回归）：
`create-ai.ts` 715→411 行（chat/chatStream 单次尝试执行体拆至 `pipeline/attempt-chat.ts`/
`attempt-stream.ts`，任务操作组拆至 `pipeline/tasks.ts`，`CallCtx` 移入 `pipeline/context.ts`，
`tryParseJson/withRawBody` 移入 `internal/json.ts`）；`protocol/gemini-chat.ts` 589→322 行
（流式双向 codec 拆至 `gemini-stream.ts`，形状小件 `gemini-shared.ts`——与 claude-chat/
claude-stream 既有拆分同款约定，全部 import 点同步更新、无转发层）。

### 3.2 错误归一：适配层翻译 + 集中标准（用户裁决，取代 v1 共享正则）

**v1 病灶**：厂商错误知识住在共享层——classify.ts 的 `DEFAULT_*_PATTERNS` 正则（死凭据/配额/限流）在通用层跑全部厂商的 message 文本，误伤面全局扩散（审计 B8 即其产物：`/too many tokens/i` 把输出参数超限误判为上下文溢出）。

**v2 分层翻译模型**：

```text
厂商响应（status + headers + body）
  ▼ adapter.mapError —— 厂商知识唯一住所
  │   查表顺序：厂商结构字段精确匹配（code/type/status → kind）
  │            → 共享 status 兜底（通用 HTTP 语义，非厂商知识）
  │            → 档案文本 pattern（个别厂商 message-only 语义的最后兜底）
  ▼ UpstreamError { kind, vendorCode?, status?, retryAfterMs?, detail, rawBody? }
  │   机制位（retryable/circuitTrip/deadCredential）由派生表单点得出
  ▼
  ├─ 库内：withRetry 读 retryable；事件流出 kind + 机制位
  ├─ inference：kind 驱动候选循环（换渠道/换模型的路由策略归消费方）
  └─ app error-face：kind → C 端 OpenAI 信封（出站三层不变，翻译变查表）
```

**四条硬规则**：

1. `ErrorKind` 封闭词表全局唯一定义（types.ts），adapter 只翻译不发明；新增 kind 走 ADR。
2. 机制位由 kind→派生表**单点派生**，adapter 不得逐例声明（杜绝"rate_limited 却 retryable=false"矛盾）。
3. 适配层只处理**厂商错误**；传输错误（network/timeout）与库策略错误（empty/config/draining）生成时直接带 kind。
4. 共享层零正则：文本 pattern 全部迁入各 adapter 档案（vendor-profiles 扩展 `errorPatterns`），降为最后兜底。

**kind → 机制位派生表（第一版）**：

| kind                                        | retryable | circuitTrip | deadCredential | 换渠道指引        |
| ------------------------------------------- | --------- | ----------- | -------------- | ----------------- |
| network / timeout                           | ✓         | ✓           |                | ✓                 |
| upstream_error / overloaded                 | ✓         | ✓           |                | ✓                 |
| rate_limited                                | ✓         | —           |                | ✓                 |
| quota_exhausted                             | —         | —           |                | ✓（换有余额渠道） |
| invalid_api_key                             | —         | —           | ✓              | ✓                 |
| insufficient_permissions                    | —         | —           | ✓              | ✓                 |
| invalid_request / invalid_response          | —         | —           |                | ✗（调用方修请求） |
| context_overflow                            | —         | —           |                | ✓（换大窗模型）   |
| content_filtered / model_not_found          | —         | —           |                | 视策略            |
| empty_completion                            | 独立预算  |             |                | ✓                 |
| canceled / server_draining / invalid_config | —         | —           |                | 库内闭环          |

**原始信息保留**：`vendorCode`（排障对照）、`status`、`detail`（原文；脱敏在外层出站做）、`rawBody`（审计源）、`retryAfterMs`（Retry-After 头/厂商字段解析，adapter 职责）。

**兜底必须可观测**（吸取 B3 静默弃真教训）：结构查表与 status 兜底 miss、落到文本 pattern 时发日志/事件信号，厂商错误形状漂移可发现。

**与 errors 根契约的关系**：ai 的 kind 是上游传输域语义分类，仓库级 `errors` 三性/category 是跨层体系——映射关系（kind → category）落 ADR，不是两套标准。

**收益闭环**：B8 结构性消解（context_overflow 由 OpenAI `context_length_exceeded` 等 code 精确命中）；UpstreamError.code 自由 string 缺口由封闭词表修复；错误映射变纯数据表——表驱动测试，新增厂商成本从"共享正则堆 pattern"变为"自己档案加表"。

**代价（已接受）**：① 适配器作者需建错误表（openai-compatible 默认表覆盖兼容厂商，原生协议知识已在 v1 迁移即可）；② kind 词表治理走 ADR 不开放注册。

### 3.3 其余拆分决策

1. **`transport/sse.ts` 统一 SSE 原语**（修 S3/S4）：自研单一 reader（行缓冲 + UTF-8 流式解码 + 事件聚合 + **保留 event 名**），sse-parser（扫描器）与 codec 的流转换都基于它；流转换用 TransformStream 包装（不用 pull 模式 ReadableStream，吸取 relay 经验）。
2. **契约演进**（修 S5）：`normalizeRequest(req, rules, endpoint)`；adapter 增加 `supportedEndpoints` 声明面（寻址覆写缺口静态可见）；`signRequest` 参数去 amzDate 化（bedrock 自带日期）。
3. **`adapters/shared.ts`**：`extractOpenAiUsage`（D4）、gemini/vertex 共享装配（D5，vertex 组合 gemini 组件）。
4. **`internal/util` 统一守卫件**（D1）：`asJson`（拒数组）/`asArray`/`str` 单一实现。
5. **`usage/features.ts` 四计数器累积器**（修 S1）：`TextFeaturesAccumulator`——按片段喂入、四计数（**cjkChars/wordSegments/numberSegments/symbolCount，不是三分类**——wordSegments 依赖相邻字符状态机，字符数无法还原词段数）、终态求值；BPE 精确路径二选一采方案 (b)：文本现场可得时先跑 BPE，`{ features, bpeExact }` 随行，估算层合并。
6. **`transport/heartbeat.ts` 全局扫描器**（修 S2）：模块级单 interval + 活跃流注册表（WeakRef 或显式注销），替代每流 setInterval。
7. **`types.ts` 收编 `TerminationReason`**（修 S6），events/relay 引用之。

---

## 4. 测试用例计划

### 4.1 `test/contract/`（新写——新 API 面行为）

- 平参数三态：`chat(channel, req)` 两参可用；`opts` 全可选平铺生效
- `ChatResult` 判别联合穷举；empty 分支语义
- `requestId` 缺省 randomUUID（同调用事件流 join key 一致）；显式传递透传到全部事件
- `opts.model` 覆盖回写：JSON body 的 model 字段与 FormData 的 model 字段
- `endpoint` 缺省 'chat'；`use()` 糖的 `embed/stream/probe` 方法族与显式 endpoint 等价
- `subscribe`：挂一次全局收全部流事件；**分发中退订不跳过后续监听**（快照回归）；观察者抛错不反噬
- 事件时序：attempt_start → first_chunk → … → 终态最后；per-call events 晚订阅重放
- `tasks`：parse/query/file 命名空间行为（含 B6 错误码 `task_ops_unavailable`）

### 4.2 `test/streaming/`（移植 + 回归）

- **必移植**：server-drain / firstframe-leak / stream-peek-leak / first-byte-timeout 四个 `.bug.test.ts`
- 透传保真：上游字节与 C 端接收字节逐位对照（同协议零改写）
- 心跳：仅 SSE 边界注入（atBoundary 矩阵：行中/行末/空行/CRLF/注释行）
- 静默超时、取消三路（signal / pipeTo cancel / inactivity）、首帧错误 failEarly、错误出站三层（结构/脱敏内容/细节）
- **S4 回归**：跨协议流在 node-server 环境下不缓冲（TTFB 对照）

### 4.3 `test/errors/`（新写——错误归一框架，§3.2）

- **表驱动**：每 adapter 一张错误表用例（结构字段 → kind 精确断言；openai/anthropic/gemini/minimax/dashscope/bedrock 各一组，v1 知识迁移）
- **兜底链**：未知结构 → status 兜底分类正确；文本 pattern 仅在结构与 status 都 miss 时触发
- **派生一致性**：任意构造的 UpstreamError，机制位 == 派生表查表值（防逐例声明回归）
- **兜底可观测**：结构/status/pattern 三档命中各自发信号（B3 教训回归）
- **B8 回归**：max_tokens 输出超限 ≠ context_overflow（OpenAI code 精确区分）
- retryAfterMs：Retry-After 头与厂商字段解析
- kind 词表封闭性：导出面枚举 == 文档词表（编译期 + 测试双锁）

### 4.4 `test/protocol/`（移植 + bug 回归）

- claude 四方向（请求/响应/流式双向、tool_use 映射、thinking→reasoning_content）
- **B2 回归**：Gemini 流式 usage 含 cached_tokens（尾帧与中间帧）
- **B7 回归**：completions n>1 全 choice 返回
- gemini/completions/responses 既有用例移植；错误映射矩阵（含 401/403 死凭据特征）

### 4.5 `test/usage/`（移植 + bug 回归）

- **B1 回归**：同一响应 content/reasoning/tool_calls 估算同口径（model 透传后）
- **B3 观测回归**：total 不一致弃真时有事件/日志可观测
- **B4 回归**：vertex 渠道 usage 双形提取（翻译后 OpenAI 形命中）
- 四计数器累积器：分段统计求和 == 整段统计（关键性质）；BPE/启发式分流
- 校准解析三层合并；tokenizer 降级；音频时长（WAV/MP3/兜底）

### 4.6 `test/transport/`

- guard 矩阵：默认机械基线（https+禁私网+rebinding）/ `allowAllUrls` / 白名单组合
- **B5 文档性用例**：白名单外域名拒绝；DNS 解析到私网拒绝
- readChunks 限长 + abort 截断契约；限长默认值表

### 4.7 `__test__/latency.test.ts`（已实施——§3.6 延迟门禁:TTFB 不缓冲/观察面异常不反噬/500 帧吞吐界;原计划并发预算门禁）

- 每帧扫描预算：N 万帧合成流的扫描总耗时上界断言
- **内存上界**：长流（>4MB 输出）扫描器内存为常数（计数器 vs 旧文本缓冲对照）
- 全局 sweeper：万级活跃流的 timer 总唤醒频率 == 单 interval 频率

### 4.8 `__test__/providers.real.test.ts`（已移植——v1 `test/real/providers.test.ts`）

- v1 real 套件（MiniMax + DeepSeek，9 用例/供应商）逐用例移植到 v2 平参数 API；
  env 契约随迁（声明即启用、缺必填 fail、无 key 默认 skip；.env 向上查找保留）。
- 语义映射与 v2 裁决移除项（熔断/死凭据存储配置、allowLocalUrl 键）在文件头注释逐条列明。
- 门禁（铁律 14）：vitest.config.ts 默认 exclude `__test__/*.real.test.ts`；
  real 门 = `test:real`（`vitest.real.config.ts`，vitest 4 的 CLI 过滤不能穿透配置级 exclude）。

### 4.9 验收

四门全绿 + 上表全部回归用例通过 + 行为对照清单核销（透传/重试/超时矩阵/取消三路/usage 归一与估算/param_adjustment/probe/任务族/SSRF 基线/事件时序）。

---

## 5. 实施顺序（每阶段独立提交）

1. **P1 壳**：types（含 TerminationReason）/config/events/index/create-ai/context——可编译
2. **P2 传输**：sse 统一原语 → 四计数器 → http-client(guard) → relay-stream(sweeper) + streaming/latency 测试
3. **P3 机制移植**：errors（classify 拆分：status 兜底 + 派生表，§3.2）→ retry → internal → registry（vendor-profiles 扩 errorPatterns）→ protocol（修 B2/B7/D7-D9）→ adapters（错误表化 + 修 B4/S5/D4/D5）→ usage（修 B1/B3）+ 对应测试（含 test/errors 表驱动）
4. **P4 管线**：prepare/attempts/stream-report/probe/generation-ops（修 B6/D6）+ contract 测试
5. **P5 收口**：README、全量四门、行为对照核销

---

## 6. 安全收口（2026-08-25 独立审计复核批次）

复核确认 B5 裁决「删除死 pin、白名单+逐地址判定即防线」两条均未执行，且发现
重定向跟随与 IPv6 边缘形态两个绕过面。本批四项修复（DESIGN §0.4 契约不变，
本节是实现收口记录）：

1. **删除死代码 `resolveAndPin` / `ResolvedTarget`**（B5 执行）：零生产调用方，
   pin 结果从未被消费——留着只会让维护者误判 rebinding 已防护。生产防线
   = 装配层注入 `allowedHosts`（gateway/worker，生产必填 env）+ `assertSafeUrl`
   逐地址判定；DNS 解析失败放行语义不变（未解析 = 无法发起连接）。
2. **`fetchUpstream` 以 `redirect: 'manual'` 派发**：守卫只校验初始 URL，
   缺省 follow 会让过审的 https 地址 30x 跳到内网/metadata（同时绕过
   https-only 与私网判定）。3x 不再自动跟随——按非 2xx 交 `adapter.mapError`
   分类（依赖重定向的上游需在渠道 baseUrl 配置最终地址）。副作用：某上游
   若依赖 30x 跳转将直接失败并可见报错，不再静默跟随。
3. **`isUnsafeIpv6` 内嵌 IPv4 全量解包**：逐 hextet 解析（覆盖 URL 规范化
   压缩形与 DNS 结果 dotted 形），`::/96`（IPv4-compatible，含 `::127.0.0.1`
   与其规范化形 `::7f00:1`）、`::ffff:0:0/96`（mapped）、`64:ff9b::/96`
   （NAT64）取尾 32 位、`2002::/16`（6to4）取第 2/3 组，内嵌 IPv4 命中
   保留段即整地址拒绝；非法形态按不安全处理（防御对称）。`2001:db8::/32`
   文档段维持放行（不可路由，仅信息面）。
4. **`readBody` / `readRawBody` 中止即抛 `'aborted'`**：旧契约「abort 返回
   截断体 + 调用方自查 `signal.aborted`」已被调用方违约（upstream-failure /
   attempt-chat 均未自查——取消中的响应被误分类 `invalid_response` 而非
   `canceled`）。收敛为结构保证：中止即错，`classifyChatFailure` 按
   `message === 'aborted'` 归类 canceled（与 fetchUpstream 同口径）。
   `internal/stream.ts` 的流式中继不受影响（流式部分交付是固有语义）。

回归：`__test__/upstream-redirect.test.ts`、`__test__/ipv6-edge-forms.test.ts`
（复核批次红测转绿）、transport-deep 的 abort 用例改锁新契约。
