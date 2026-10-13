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
  **按请求规模自适应（v3 定稿式）**：`connectMs + 5s/MB，封顶 90s`
  （小 body → 精确 10s 等值 main；1.3MB → 16.5s；4MB → 30s；10MB → 60s；
  字节按 UTF-8 实际字节数）。审查 A#1 两轮修正：max/min 复合式无法同时
  满足「小 body 等值 + 大 body 起步 20s」，定稿为叠加式（连接预算已含于
  connectMs；gateway 的 BASE_MS 键已随 v3 移除——裸调用下限由 ai 侧 zod default 兜底）。
  响应头前 connect/TTFB 不可观测分离，「快失败层」设计已废弃。

非流式 `attempt-chat` 的 totalMs 不动（120s 覆盖全程，本次事故不涉及）。

### 2.2 次修复：timeout 归因透出（可观测性契约）

`UpstreamError` 新增可选 `stage`：`'connect' | 'response_header' |
'first_byte' | 'budget'`（四层各一处赋值，封闭词表）。传播链：
- ai failed 事件与 sanitize 前 message 带_stage_；
- inference failover 的 releaseAndFail 502 context 增 `timeout_stage`（仅
  timeout kind 时）；
- billing_requests 现有 failure_code 不动（超时归因走日志/context，不加列）。

### 2.3 扩展实施与残余缺口（v2——用户裁决「多方面考虑」+ 审查处置）

- **firstByte 规模自适应已实施**（用户裁决扩展）：`firstByteTimeoutMs +
  perMb×mb`，封顶 `firstByteTimeoutMs + responseHeaderMaxMs`（独立封顶
  ——不借 header 封顶钳静态基线，审查 A#2）。慢首 token 服务器（头秒回
  但 100 万 token 预填超 60s）不再误杀；小 body 静态语义不变。
- **multipart（FormData）路径不注入预算（残余缺口，登记）**：serializeBody
  对 FormData 返回 undefined → 响应头预算仍静态 connectMs。上传（16MB 上限）
  与 #73 同构的误杀风险存活——正确修法是 FormData 字节估算（form.forEach
  累计），另行票处理；触发条件：大文件 + 慢响应头 > 10s。
- nginx/Caddy 层：已核 360s 充足，不动；
- 重试策略（sameChannelMaxRetries=3 对 timeout 的合理性）：超时归因透出后
  按生产分布另行裁决——本票只修预算与观测。

## 3. 契约

- `aiConfig.timeout` 增 `responseHeaderBaseMs`(默认 20_000) /
  `responseHeaderPerMbMs`(默认 5_000 = 0.2MB/s 的保守上传+预填速率) / `responseHeaderMaxMs`
  (默认 90_000)；zod + .env.example（PER_MB/MAX 二键）+ 配置测试
  （BASE_MS 键已废弃移除——设置无效）；
- `UpstreamError.stage?: TimeoutStage`（可选字段——旧调用方零破坏）；
- inference 502 context: `upstream_code: timeout` 时附加 `timeout_stage`。

## 4. 测试口径（先于实现）

- 复现测试（#73 harness 测试化，v3 口径）：复现组（生产形态 connectMs 10s +
  12MB body → 自适应预算 70s 覆盖 45s 慢响应头，单次成功零重连风暴——旧
  实现同配置 10s 预算三连全灭）+ 出厂默认锚（zod 全缺省下小 body 精确
  等值 connectMs）+ 4MB/20s 大 body 区分度用例；
- 归因矩阵：connect/response_header/first_byte/budget 四 stage 各一用例
  （mock 分别在握手/响应头/首帧/总预算处 hang）；
- 回归锚：小请求（<1MB）行为与现状一致（connectMs 10s 快失败不变）；
- 契约：zod 缺省值表 + UpstreamError.stage 词表封闭测试。

## 5. 实施顺序

P1 ai 层（fetchUpstream 拆预算 + stage 字段 + 归因矩阵测试 + 复现测试）
P2 inference/gateway（context 透出 + 三配置键 + 配置测试）
P3 四门 + pr-review-loop（按 skill 走）

## 6. 裁决

- [默认裁决，可否决] responseHeader 自适应公式 **v3 叠加式**：
  connectMs + 5s/MB 封顶 90s（5s/MB = 0.2MB/s 保守上传+预填速率假设；
  中文按 UTF-8 字节计——30 万 CJK token ≈ 0.9MB 字节 → ~14.3s）。
  数值上线后按 timeout_stage 分布调。
- [用户裁决 2026-10-12] firstByte 自适应 + 异常场景矩阵（100 万 token/
  超慢首 token 服务器形态）随本票实施——原「不处理」裁决作废。
- [默认裁决，可否决] failure_code 不加 timeout 归因列（观测走日志）。
- [环境事实，来源：用户] 单渠道无 fallback——超时预算必须容住上游真实时延。
