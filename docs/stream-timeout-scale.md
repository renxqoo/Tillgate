# 流式上游超时的规模自适应与归因修复（stream timeout scale + attribution）

状态：**定稿**（默认裁决随实现提交落档，给否决窗口）
级别：中（跨 ai 包传输/重试层 + inference 装配 + gateway 配置面；错误契约
新增 timeout 归因字段——枚举加项级）
Issue：#73（档 2 已复现——见 issue 评论的 harness 分组数据）

## 1. 现象与根因（档 2 证据链，零上下文可重放）

生产：30 万 token 前缀流式请求 8 笔 timeout，lifetime 恒定 30-31s。
harness 双向复现（mock server + 生产配置形态）：

- A 组（connectMs=10s，首帧 45s hang）：30.7s 终结，mock 观测 3 次 body
  重传（6ms/10.2s/20.7s）——客户端 10s 处 abort ×3；
- B 组（connectMs=120s，首帧 75s hang）：75.0s 单次成功。

根因链：`fetchUpstream.connectMs` 计时器包住 fetch 到**响应头**（connect+TTFB
语义），10s 静态值对大 body 上传+上游预填结构性不足 → abort → kind=timeout
（retryable=true）→ withRetry 三连重试（每次同层 10s 失败）≈ 30s 全灭。

设计缺陷三处：
1. **主因**：connectMs 值按 TCP connect 设、语义覆盖到 TTFB——错配；
2. **次因**：timeout kind 归并 connect/TTFB/首帧/deadline 四层，502 信封
   `upstream_code: timeout` 无法归因（生产日志与 DB 均无法区分）；
3. **背景**：所有超时静态、无请求规模维度（30 万 token 与 3 千 token 同预算）。

## 2. 方案

### 2.1 主修复：connectMs 语义拆分（单一真相）

`FetchUpstreamOptions.connectMs` 拆两个正交预算：

- `connectMs`：真 connect（TCP/TLS 握手）——保留 10s 静态（握手与规模无关）；
- `responseHeaderMs`（新增）：响应头预算（含大 body 上传 + 上游 TTFB）——
  **按请求规模自适应**：`base(20s) + bodyBytes / 2MB/s`（1.3MB body →
  ~20.7s；10MB → 25s；上限 90s 封顶）。实现：fetchUpstream 内两段计时器
  （connect 完成时刻不可直接观测——undici 不暴露；用「响应头到达」作为
  两者共同的终点，connectMs 短计时器保留作为快失败层：10s 内连响应头
  都没有且 body 已发完的，大概率是连接层问题）。

非流式 `attempt-chat` 的 totalMs 不动（120s 覆盖全程，本次事故不涉及）。

### 2.2 次修复：timeout 归因透出（可观测性契约）

`UpstreamError` 新增可选 `stage`：`'connect' | 'response_header' |
'first_byte' | 'budget'`（四层各一处赋值，封闭词表）。传播链：
- ai failed 事件与 sanitize 前 message 带_stage_；
- inference failover 的 releaseAndFail 502 context 增 `timeout_stage`（仅
  timeout kind 时）；
- billing_requests 现有 failure_code 不动（超时归因走日志/context，不加列）。

### 2.3 不处理（归属）

- 流式 inactivity/firstByte 的规模自适应：firstByte=60s 在本次事故未触发
  （B 组证明响应头到达后首帧由 peek 层 60s 覆盖充足）；若未来触发另行票；
- nginx/Caddy 层：已核 360s 充足，不动；
- 重试策略（sameChannelMaxRetries=3 对 timeout 的合理性）：超时归因透出后
  按生产分布另行裁决——本票只修预算与观测。

## 3. 契约

- `aiConfig.timeout` 增 `responseHeaderBaseMs`(默认 20_000) /
  `responseHeaderPerMbMs`(默认 5_000，即 2MB/s) / `responseHeaderMaxMs`
  (默认 90_000)；zod + .env.example（GATEWAY_UPSTREAM_RESPONSE_HEADER_*
  三键）+ 配置测试；
- `UpstreamError.stage?: TimeoutStage`（可选字段——旧调用方零破坏）；
- inference 502 context: `upstream_code: timeout` 时附加 `timeout_stage`。

## 4. 测试口径（先于实现）

- 复现测试（#73 harness 测试化）：A 组（小 connectMs + 大 body 慢响应头 →
  kind timeout + stage response_header，不发生 3×10s 重试风暴——预算
  自适应后单次等待覆盖）+ B 组（自适应预算下大 body 75s hang 成功）；
- 归因矩阵：connect/response_header/first_byte/budget 四 stage 各一用例
  （mock 分别在握手/响应头/首帧/总预算处 hang）；
- 回归锚：小请求（<1MB）行为与现状一致（connectMs 10s 快失败不变）；
- 契约：zod 缺省值表 + UpstreamError.stage 词表封闭测试。

## 5. 实施顺序

P1 ai 层（fetchUpstream 拆预算 + stage 字段 + 归因矩阵测试 + 复现测试）
P2 inference/gateway（context 透出 + 三配置键 + 配置测试）
P3 四门 + pr-review-loop（按 skill 走）

## 6. 裁决

- [默认裁决，可否决] responseHeader 自适应公式 20s+5s/MB 上限 90s——
  生产观测 MiniMax 30 万 token 首帧 15-45s，公式给 1.3MB→20.7s 偏紧？
  B 组证明响应头到达是主延迟源，20s base 覆盖上传 + 排队；上限 90s
  防慢上游占满连接池。数值上线后按 timeout_stage 分布调。
- [默认裁决，可否决] failure_code 不加 timeout 归因列（观测走日志）。
- [环境事实，来源：用户] 单渠道无 fallback——超时预算必须容住上游真实时延。
