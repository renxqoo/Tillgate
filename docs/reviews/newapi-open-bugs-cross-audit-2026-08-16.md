# new-api 开放 Bug Issue 交叉审计（2026-08-16）

> 基线：https://github.com/QuantumNous/new-api/issues?q=is%3Aissue+state%3Aopen+label%3Abug（**全量 14 页 / 350 条**）
> 方法：逐条读取 issue 标题+正文 → 区分「真实 bug」与「变相需求/UI 投诉」→ 映射本项目
> 对应实现 → 对疑似同类问题读码验证 → 确认存在的写红测证明。
> 轮次一（第 1 页 / 49 条）：确认 BUG-A、BUG-B——**已修复**（红测转绿，见文末）。
> 轮次二（第 2-14 页 / 301 条）：子 agent 逐条分类（附录见
> `newapi-open-bugs-appendix-301.md`，301 条全量）→ 主 agent 对全部 APPLICABLE
> 候选逐项读码复核 → 新确认 BUG-C、BUG-D、BUG-E、BUG-F——**六个 bug 已全部修复**
> （红测全部转绿为回归锁）。

## 一、结论摘要（全量 350 条）

- **确认存在同类 bug：6 个，已全部修复**（BUG-A/B 于轮次一；BUG-C/D/E/F 于轮次二，
  均为红→绿 TDD 闭环）。
- **验证不存在 / 已有防护：120+ 类**（两轮合计，含 87 项子 agent 标记后经复核排除项）。
- **需求/改进类记录：10 条**（含 param 规则嵌套 path/delete 模式、订阅绑定展示一致性、
  前端金额浮点安全、orgs 剪贴板兜底等新增记录）。
- **不适用：~280 条**（无对应子系统：MJ/视频任务、协议转换、支付、分组、多 key、
  SQLite、RBAC、游乐场、供应商特定集成等）。

---

## 二、确认存在的同类 bug

### BUG-C（new-api #6412 / #2841 同类，高危）：evalsha 无 NOSCRIPT 回退 → Redis 重启后推理全量 500 直到网关重启

- **new-api 现象**：Redis 重启后限流请求持续返回 500。
- **本项目同类**：`apps/gateway/src/services/billing/rate-limit-service.ts` 的 4 个 Lua 脚本
  （check/checkAll/reserveTpm/releaseTpm）与 `infrastructure/ai-storage.ts` 的熔断 CAS，
  全部把 `SCRIPT LOAD` 的 sha 缓存在实例字段且**永不重载**。Redis 重启/故障转移/
  SCRIPT FLUSH 后脚本消失，evalsha 抛 NOSCRIPT——Redis 恢复健康后依然持续。
- **后果链**：`checkAll` 在管线（llm-pipeline.ts:133）**无 try/catch**，NOSCRIPT 异常
  直达 `appErrorHandler` → **全量推理请求 500**，唯一恢复手段是重启网关进程。
  熔断 CAS 的错误虽被 fireAndForget 吞掉（不 500），但 Redis 重启后熔断/死凭据
  状态写入静默失效（保护机制降级）。
- **红测**：`apps/gateway/src/services/billing/__tests__/rate-limit-noscript.red.test.ts`。
- **已修复**：新增 `infrastructure/redis-script-runner.ts`（组件化下沉，evalsha +
  NOSCRIPT 自愈——捕获 NOSCRIPT → 重新 LOAD → 重试），RateLimiter 4 脚本与
  ai-storage 熔断 CAS 全部改经运行器执行。Redis 重启/SCRIPT FLUSH 后自动恢复，
  不再出现全量 500 或熔断写入静默失效。

### BUG-D（new-api #6241 同类）：列表排序无唯一 tiebreaker → 非唯一键分页可能重复/遗漏

- **new-api 现象**：渠道列表按非唯一字段排序时分页结果可能重复或遗漏。
- **本项目同类**：`packages/http/src/list-query.ts` 的 `resolveOrderBy` 把 tiebreaker
  做成**可选项**，18 个调用点中 10 个未传——admin 的 plans/providers/keys/
  subscriptions/redeem×2/rate-cards×2/models 列表 + client 的 plans 列表。
  典型暴露面：套餐按 `sortOrder` 排序（sortOrder 大量并列），Postgres 对并列行
  顺序未定义，LIMIT/OFFSET 翻页可重复/漏行。
- **红测**：`packages/http/src/__tests__/list-query-total-order.red.test.ts`。
- **已修复**（结构性）：resolveOrderBy 的 tiebreaker 从可选改为**必选编译期参数**，
  「无全序的排序」在调用点不可表达；16 处 `{ tiebreaker: X }` 形式简化为直传，
  4 处缺失调用点（admin/client plans、admin redeem codes）补上 id 列。

### BUG-E（new-api #3133 同类）：baseUrl 携带版本段时路径重复拼接

- **new-api 现象**：OpenAI 兼容渠道 baseUrl 带 `/v2` 版本段时路径拼接失败。
- **本项目同类**：`packages/ai/src/create-ai.ts` 的 `joinUrl` 仅剥尾斜杠后直拼
  `/v1/chat/completions`；admin 端对 baseUrl 无版本段规范化/校验——管理员按业界
  惯例填 `https://host/v1`（复制自 OpenAI 文档的形态）时，实际请求变成
  `/v1/v1/chat/completions` → 404，报错与配置根源无关、极难排查。
- **红测**：`packages/ai/test/integration/baseurl-version-dup.red.test.ts`。
- **已修复**：joinUrl 拼接时对「baseUrl 尾段版本段 == 适配器路径首段」去重
  （`https://host/v1` + `/v1/chat/completions` → `https://host/v1/chat/completions`）；
  版本段之外的内容（如 openrouter 的 `/api`）不受影响。单一真相在 join 层。

### BUG-F（new-api #2463 / #2443 同类）：embeddings input 校验过窄拒绝合法生态形态

- **new-api 现象**：多模态 embedding 的结构化 input 无法通过（豆包/千问 VL 等）。
- **本项目同类**：`apps/gateway/src/routes/inference-endpoints.ts:40` 的
  `input: z.union([z.string(), z.array(z.string())])`——
  (a) OpenAI **官方规范**的 token 数组 `number[]` 被 400；
  (b) 多模态结构化数组被 400。与我们对未知参数的 passthrough 哲学自相矛盾，
  直接断送多模态 embedding 供应商接入。
- **红测**：`apps/gateway/src/routes/__tests__/embeddings-multimodal-input.red.test.ts`。
- **已修复**：input 放宽为 `string | Array<string | number | number[] | 未知对象>`
  （官方 token 数组/批 + 多模态结构化形态全收），仅保留 ≤2048 数量上界
  （防内存放大语义不变），结构不做白名单（与未知参数 passthrough 哲学一致）。

### BUG-A（new-api #6649 同类）：已完成流被误分类为 client_disconnect（已修复）

- **new-api 现象**：客户端在收到 `data: [DONE]` 后立即关闭 TCP（HTTP/1.1 标准行为），
  `stream_status.end_reason` 记为 `client_gone`，前端展示「流状态：错误」——实际流正常完成。
- **本项目同类**：`packages/ai/src/transport/relay-stream.ts:202-216` 的 `cancel()` 回调
  **不检查 scanner 是否已收到 `[DONE]`/终止帧**——readable 被 cancel 一律发
  `terminated='client_disconnect'`。
- **下游影响链**（`apps/gateway/src/services/pipeline/attempt-runner.ts:233-256`、
  `makeReceipt(..., !!e.terminated, ...)`）：
  1. `usage_logs.stream_aborted = true`——正常完成的请求在用量页被打上「中断」标；
  2. trace span 记 `stream.terminated='client_disconnect'`（用户取消）；
  3. 若供应商未回 usage 帧（不 honoring `include_usage`），走 `recordEstimatedCancel`
     按估算结算，而非 G1 的 uncertain 挂账——计费语义被污染。
- **红测**：`packages/ai/test/integration/client-gone-after-done.red.test.ts`。
- **已修复**：`relay-stream.ts` 的 `cancel()` 现按 flush 同优先级判定完成语义——
  `[DONE]` / 终止帧（无错误帧）已到 → 按正常完成归类（无 terminated、usage 保留）；
  有错误帧 → `upstream_error`；否则才是真正的 `client_disconnect`。

### BUG-B（new-api #6643 同类）：200 + 首帧即错误 → 无 failed 事件 → 不换渠道

- **new-api 现象**：上游以 HTTP 200 建流但 SSE 首帧即错误（code-only rate limit error），
  Responses-via-Chat 路径不重试——错误透传给客户端，无渠道切换。
- **本项目同类**：`packages/ai/src/create-ai.ts:459-460` 的 `peekFirstChunk` **只检测空流**，
  不识别「首帧即错误」；流建立后错误帧仅触发 `terminated='upstream_error'`，
  终态仍走 `success` 分支（create-ai.ts:519-541），**`failed` 事件永不发出**。
  而网关只凭 `failed` 事件换渠道（`attempt-runner.ts` 的 `state.failed` + `isChannelSwitchable`）。
- **后果**：部分供应商/二层代理用 200+流内错误报告限流（而非 HTTP 429）时——
  客户端收到上游错误原文、**无渠道切换**、按部分/零 usage 结算或挂 uncertain，
  可用性损失（明明有健康渠道却不切换）。
- **红测**：`packages/ai/test/integration/first-frame-error-failover.red.test.ts`
  （流式 + 非流式两个用例）。
  注：现有 `chat-stream-failover.test.ts` 用 mock Ai 层**手动重放** failed 事件，
  只覆盖了网关侧处理，未覆盖真实 ai 层在 200+流内错误时不产生 failed 的缺口。
- **已修复**（三个面）：
  1. 流式：`peekFirstChunk` 后扫描首帧（`internal/stream.ts` 的 `firstChunkStreamError`），
     命中完整错误帧 → `fail` 进入 withRetry（首字节未发给客户端，重试/换渠道安全）；
  2. 非流式：200 + JSON 错误体 → `classifyBodyOnlyError` 归类失败（此前按成功+估算计费）；
  3. 分类器：`errors/classify.ts` 新增 `classifyBodyOnlyError`（无状态码、纯 body 特征：
     配额耗尽 / 限流 / 死凭据 / 默认 upstream_error），复用既有 extract*/模式集。
  契约变化：首帧即错误从「透传 + stream_error」改为「failEarly 错误流 + failed 事件」；
  中流错误帧（先内容后错误）语义不变（`create-ai.test.ts` 已有两面用例锁定）。
  跨 chunk 分割的首帧错误检测不到，退回中流错误帧语义兜底（与 peek 同界，文档化）。

---

## 三、验证不存在 / 已有防护的同类问题

| new-api issue | 本项目对应实现 | 验证结论 |
|---|---|---|
| #6609 TOCTOU 并发超额扣费 | 余额/额度/渠道三维预留全部「守卫内联 UPDATE WHERE」原子 CAS + F4 咨询锁 | ✅ 不存在（上一轮红测转绿） |
| #6412/#2841 限流失效/重启 500（核心） | 限流判定本身是 Lua 原子（无竞态）；但脚本恢复见 BUG-C | ⚠️ 核心安全、恢复缺口=BUG-C |
| #6333 限流易被绕过 | requestId 永远服务端生成（request-id.ts 显式防此攻击面），ZSET member 去重不可被客户端固定 ID 稀释 | ✅ 不存在 |
| #5139 建令牌缺归属校验可越权 | client 建 Key 绑订阅必过 `assertCanUseSubscription`（owner 或 org 成员）；更新不允许改绑 | ✅ 不存在 |
| #2217 模型禁用后仍可调用 | 路由查询过滤 `model_mappings.status=0` + `channels.status=0`；PATCH/DELETE 均 bumpRouteCache | ✅ 不存在 |
| #6353/#6144/#5756/#6230/#6265 供应商 usage 字段漏计 | normalizeUsage 覆盖 OpenAI `prompt_tokens_details.cached_tokens` + DeepSeek hit/miss（单测锁定）；无 Claude/Cloudflare/xAI 原生面 | ✅ 已覆盖 |
| #6239 部分输出后超时补 usage+[DONE] 调用方无感 | 我们 inactivity/截断路径注入错误帧后再补 [DONE]，调用方可感知（failWithErrorFrame） | ✅ 不存在 |
| #5446 同用户跨请求响应混合 | 管线无跨请求共享响应状态；requestId 全链路隔离（计量/幂等/流） | ✅ 结构上不可能 |
| #4274 并发数据库死锁 | 锁序固定（advisory lock → 行锁；users 行 → 订阅插入），上轮 F1-F4 修复时验证 | ✅ 不存在 |
| #5698/#4733 长输出 OOM/内存增长 | SseScanner O(1)（显式不缓存行内容）；request-log 不克隆响应体；非流式 8MB 读上限 | ✅ 不存在 |
| #4168 client_gone 且 0 输出仍扣 prompt 费 | 设计差异：用户侧取消按 input 估算结算（G1，已消费上游算力），非 bug | ➖ 语义不同（有意） |
| #5661 订阅用尽不切余额 | 设计差异：订阅/余额是 Key 绑定的独立计费源（单一真相），非自动回退 | ➖ 语义不同（有意） |
| #5877 quota int 溢出 | numeric(38,18) + decimal.js 全精度 | ✅ 不适用 |
| #5815 失败请求占限流额度 | RPM 计数的是「准入」而非「成功」——策略差异 | ➖ 语义不同 |
| #6610 路由先于鉴权中间件注册 | gateway 端点表驱动前置挂载 auth（app.ts:96-99）；/debug token 门禁；/oauth 自带凭证校验 | ✅ 不存在 |
| #6574 代理追加上游 CORS 头致重复 | 响应头全部自建（sseResponse 仅 4 个头；非流式解析后重建），不复制上游响应头 | ✅ 不适用（结构不同） |
| #6732 限流器大限额 OOM / 流式输出全量累积 | RPM ZSET 每次先 `ZREMRANGEBYSCORE` 清窗口 + `PEXPIRE`（rate-limit-service.ts:23-31）；TPM 键 600s TTL；SseScanner O(1) 内存；request-log 不克隆响应体 | ✅ 不存在 |
| #6724 上游价格同步崩溃 | `mapOpenAiCompatibleCatalog` 全字段类型防御、非数组返回 []、非 '0' 价格跳过、fetch 15s 超时 | ✅ 不存在 |
| #6659 额度计费显示 | 展示直读 usage_logs（amount = plan + payg 有 DB CHECK 约束一致），无二次换算 | ✅ 不适用 |
| #6661 密钥状态筛选把启用/过期合并互斥枚举 | status 与 expires_at 本就是两个正交字段，列表原样返回 | ✅ 不存在（见需求 R3） |
| #6700 加余额日志 user 显示为操作管理员 | transactions.userId=被操作人；audit 事件 targetType='user'+targetId=被操作人，adminId 单独记录（ledger.ts:343-350） | ✅ 不存在 |
| #6594 流内终端失败事件被记为成功 EOF | 我们的中流 `{"error":...}` 帧会触发 `aborted`(计熔断) + `success(terminated='upstream_error')`；无 usage 挂 uncertain，不伪装干净成功 | ✅ 不存在（chat 语义；BUG-B 是它相邻的缺口） |
| #6860 客户端断开后上游继续推理 | pipeTo cancel 传播：transform.readable 被 cancel → writable error → pipeTo 取消上游源 | ✅ 设计正确 |
| #6547 单条 SSE 行 >64KB 截断（bufio 上限） | eventsource-parser 无行长上限，不截断（超长行仅瞬时缓冲） | ✅ 不适用 |
| #6822 /v1/responses 浮点 created_at 丢帧 | 无 /v1/responses 端点；usage 提取只按帧内容 | ✅ 不适用 |
| #6510 内存缓存与 DB 路径权重口径不一致 | 单一选路路径（SQL ORDER BY priority/weight），无双实现 | ✅ 不适用 |
| #6552 渠道不按优先级调度 | 选路确定性排序，无随机路径 | ✅ 不适用 |
| #6503 禁用最后一个渠道后重试报一致性破坏 | 渠道禁用与在途预留有状态守卫（reserveChannel 终态 0 行回滚） | ✅ 不存在 |
| #6781 使用日志不显示缓存 token | usage 路由返回 cachedInputTokens（明细+汇总） | ✅ 不存在 |

---

## 四、需求/改进类记录（从 bug 单剥离，本项目对应缺口）

| 编号 | 来源 issue | 诉求 | 本项目现状 |
|---|---|---|---|
| R1 | #6715 | 渠道测试误报成功（未真正走转换/推理路径） | 我们的 `POST /channels/:id/test` 只 probe `GET /v1/models`——**key 有效 ≠ 推理可用**，存在假阳性；建议加真实最小 completion 探测 |
| R2 | #6752 | 按 Key 的 IP 白名单 | 无 per-key IP 限制（此前对比审计已列为差距） |
| R3 | #6661 | 按「已过期」筛选密钥 | keys 列表无状态/过期筛选器（数据模型支持，缺查询参数） |
| R4 | #6681 | 数值输入框 backspace 强制显示 0 | 管理端兑换码/金额输入未验证同类 UX（前端待查） |
| R5 | #6775 | 模型元信息（vendor 等）不准确 | 目录导入仅有价格/上下文长度，无 vendor 维护 |

---

## 五、不适用清单（无对应子系统）

- **MJ/Suno/视频任务**：#6864、#6505、#6860(部分)、#6639（高级自定义路由）
- **协议转换**（Claude/Gemini/Responses 互译）：#6859、#6715(主体)、#6615、#6602、#6643(主体，但衍生出 BUG-B)
- **支付**：#6857（Stripe SDK）、#6633（Waffo webhook）
- **分组/多分组**：#6640、#6804
- **SQLite/集群**：#6805、#6840
- **RBAC**：#6688（本项目单管理员角色，无分层）
- **纯前端 UI**：#6872、#6650、#6555、#6544、#6646
- **供应商特定集成**：#6565（硅基流动余额）、#6516（TLS 指纹）、#6746（rerank）、#6744（cgroup 内存监控）
- **表达式计价/定价页**：#6491、#6521
- **运维任务系统**：#6782（task lease）

---

## 六、红测清单

```
全部已修复（回归锁，绿）：
packages/ai/test/integration/client-gone-after-done.red.test.ts      # BUG-A
packages/ai/test/integration/first-frame-error-failover.red.test.ts  # BUG-B（流式 + 非流式）
apps/gateway/src/services/billing/__tests__/rate-limit-noscript.red.test.ts   # BUG-C
packages/http/src/__tests__/list-query-total-order.red.test.ts                 # BUG-D
packages/ai/test/integration/baseurl-version-dup.red.test.ts                  # BUG-E
apps/gateway/src/routes/__tests__/embeddings-multimodal-input.red.test.ts     # BUG-F
```

六个 bug 修复后全量回归：全仓 15 个测试任务、typecheck、lint 全绿
（gateway 46 文件/150 测试，含新增回归锁）。第 2-14 页 301 条的逐条分类见
附录 `newapi-open-bugs-appendix-301.md`。

## 七、轮次二（第 2-14 页 / 301 条）方法与复核说明

流程：并行 5 个子 agent 各读 61 条（标题+正文摘要，剥模板样板）→ 逐条输出
分类与映射 → 合计标记 89 项 APPLICABLE → 主 agent 对每一项做代码级复核
（其中多数在轮次一已验证：request-id 服务端生成、key 越权校验、模型禁用缓存
bump、usage 归一化、释放路径原子性、锁序、限流覆盖面、探针超时、大小写一致性、
兑换码熵、TPM 释放、订阅聚合派生等）→ 净新增确认 BUG-E、BUG-F；另记录 5 条
新需求/待查（param 规则嵌套 path 与 delete 模式 #2400/#2376、订阅绑定展示一致性
#6222、控制台金额浮点 #3177、orgs 剪贴板 #4014）。
