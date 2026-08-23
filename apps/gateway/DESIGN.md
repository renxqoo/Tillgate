# @tokenlens/gateway 设计基线

> 状态：定稿（2026-08-23；gateway app 迁移波 = 重构方案 §3 目标树 `apps/gateway` + P5 第二个 app）
> 旧实现：`/Users/wrr/work/ai-getway/apps/gateway`（app 层约 3.1k 行 + 测试约 4.2k 行；
> pipeline/routing/quote/generation/billing/ai 六目录约 5.9k 行已由 P4 wave-4 `@tokenlens/inference` 承接）
> 施工图见 [IMPLEMENTATION.md](./IMPLEMENTATION.md)；行为规格与测试矩阵见 [MIGRATION.md](./MIGRATION.md)。

---

## 1. 定位与迁移单元

OpenAI/模型推理公网入口：协议适配（OpenAI / completions / responses / claude / gemini 原生 /
模态 multipart / 异步生成）+ 鉴权 + 限流 + 装配。**推理编排、候选循环、计价收据、渠道健康全部
来自 `@tokenlens/inference` facade——app 零第二套业务规则**（P5：app 只保留 config、assembly、
协议路由、中间件、presenter 与生命周期）。

迁移单元（垂直用例）：「客户端凭证经公网入口完成一次推理请求（含鉴权、限流、计费衔接、
协议出站）」。为闭合该用例，本波同时补齐五个能力包接缝（详见 §5 裁决）：
runtime 限流/爆破件、ai codec 出口、inference 目录端口扩展 + pg 任务存储、
control-plane 只读目录、accounts 资金来源解析器。

## 2. 外部契约

### 2.1 HTTP 面（v1 逐路径等价）

| 路径 | 形态 | 说明 |
| --- | --- | --- |
| `POST /v1/chat/completions` | chat，body.stream 分流 | SSE 透传字节流原样直传 |
| `POST /v1/embeddings`、`/v1/completions`、`/v1/responses`、`/v1/messages` | codec 端点 | 入站解码到规范形、出站按线格式编码（含流式） |
| `POST /v1/images/generations`、`/v1/audio/speech`、`/v1/rerank`、`/v1/moderations` | 模态 JSON 族 | 非流式，走同管线 |
| `POST /v1/engines/:model/embeddings` | 别名 | OpenAI pre-1.0 SDK |
| `POST /v1beta/models/:model:(generate\|streamGenerate)Content` | Gemini 原生 | 请求/响应/流式三向翻译 |
| `POST /v1/images/edits`、`/v1/audio/transcriptions`、`/v1/audio/translations` | multipart | MIME 白名单 + 单文件上界 |
| `POST /v1/video/generations`、`/v1/music/generations`；`GET /v1/videos/:id`、`/v1/musics/:id` | 异步生成 | 提交恒 201；查询归属校验（他人/异类/不存在一律 404） |
| `GET /v1/models`、`GET /v1/models/:model` | 目录 | OpenAI / Anthropic / Gemini 三协议形状；白名单过滤；404 不泄漏目录 |
| `POST /oauth/token` | OAuth 2.0 client_credentials | form/JSON/Basic 三形态；签发 App-JWT |
| `/healthz`、`/livez`、`/readyz` | 探针 | healthz/readyz 查 DB，readyz 另探 Redis；livez 纯 200 |

### 2.2 鉴权（双形态，v1 语义）

- **虚拟 Key**（`ag_` 前缀）：SHA-256 → `@tokenlens/accounts` `resolveKeyByHash`（key 活跃 +
  属主活跃 + 未过期，每调用直查无缓存）。爆破防护：keyHash 维 + IP 维双计数、阈值锁定。
- **App-JWT**（不以 keyPrefix 开头）：HS256 验签（算法白名单 + iss/aud），仅认 `typ='app_jwt'` +
  `app_id` + `sub`；`accounts.resolveApp` 校验 app 活跃且属主匹配；rpm/tpm/白名单取 payload.scope；
  恒 `allowPaygFallback=false`。爆破防护：IP 维计数。其他 JWT 形态（playground 等）一律 401。
- `requestId` **恒服务端 randomUUID**，不信任客户端 `X-Request-Id`（防限流 ZSET member 固定
  绕过 + 计费幂等键重放）；响应回显 `x-request-id`（SSE 响应同样带）。
- 鉴权按已注册端点逐路径挂载——未注册路径 404 而非 401。

### 2.3 错误信封与码表

- 信封 `{"error":{"code","message"}}`（v2 目录渲染，`context` 仅在必要提示时携带，如 415 改配提示）。
- **码表演进（R-E1）**：v1 裸码（`insufficient_balance`）→ v2 命名空间目录码
  （`billing.insufficient_balance` / `inference.model_not_found` / `gateway.*`）。status 与触发
  条件逐项保持 v1 语义（24 条 instance 映射表核销于 MIGRATION §4）；inference 目录已按
  v1 wire 码建码（`no_available_channel` 503 / `upstream_failed` **502 face override** /
  `finalize_unavailable` 503 / `model_not_found` 404 / `model_not_allowed` 403）。
- app 自有目录 `gateway.*`：`invalid_body`(400)、`rate_limit_exceeded`(429，Retry-After 头)、
  `unsupported_grant_type`(400)、`invalid_client`(401，OAuth 标准错误形)、`not_found`(404)。
- 上游错误出站三层（§3.6）：502/504 网关语义 + 内容脱敏（剥 URL/host、真实模型名替换为对外名、
  截断）+ 细节只进日志关联 requestId——`openai-error-face` + `sanitize` 承接。
- 基建 fail-closed：Redis 限流/爆破件不可用 → 503（`runtime.*` infrastructure 渲染）。

### 2.4 装配形态

- Redis **必配**（多副本共享：熔断/死凭据健康状态、滑动窗口限流、爆破防护）；
  启动期 `assertRedisReachable` 连通性验证，连不上拒绝启动。单副本开发形态同款必配（v1 语义）。
- OTel `off|otlp`（observability `initOtel`；otlp 缺端点启动期 fail-fast）。
- 结算唤醒：signal 转入 settlement_pending 后 `pg_notify('settle-wake', requestId)` 纯门铃，
  投递失败不阻断，丢失由 worker 兜底扫描覆盖（worker 波消费）。

## 3. 问题域（处理 / 不处理）

**处理**：HTTP 协议适配与入参校验、鉴权双形态、RPM/TPM/全局/渠道维限流闸（并罚制）、
爆破防护、请求日志（一切 `/v1` 请求，鉴权前挂载）、目录列表、OAuth 签发、装配与生命周期。

**不处理**（归属）：

| 不处理项 | 归属 |
| --- | --- |
| 候选循环 / 换渠 / 输出钳制 / 收据 / 渠道健康 | `@tokenlens/inference` |
| 钱包预扣 / 结算状态机 / 渠道敞口 / 资金瀑布 | `@tokenlens/billing`（经 BillingPort 桥） |
| 模型映射 / 渠道候选 / 费率卡系数读取 | `@tokenlens/control-plane` 只读目录（经 CatalogPort 桥） |
| 上游协议执行 / 传输 / 重试 / 事件总线 | `@tokenlens/ai`（inference 内部持有；app 运行时不 import ai——§3.6） |
| Key/App 凭证事实与鉴权读模型 | `@tokenlens/accounts` |
| 请求日志/审计的持久化与查询 | `@tokenlens/observability` |
| 生成任务轮询与结算落账 | worker 波（显式挂账，见 MIGRATION §5） |
| 死凭据永久拉黑与告警 | control-plane/observability 后续波 |

## 4. 并发与性能预算

- SSE 透传：上游 chunk 逐块直通，网关不缓冲不改写（§3.6 数据面契约；codec 端点仅做线格式
  转换流）；`x-accel-buffering: no` 防 nginx 缓冲。
- 请求体上界 **10 MiB**（content-length 快路径 413 + 流式计数兜底）；multipart 单文件 **16 MiB**
  （与请求体上界取 min）；MIME 白名单 image 3 种 / audio 8 种。
- 限流并罚制：任一维（key RPM/TPM、user RPM/TPM、global RPM、model TPM、channel RPM/TPM）
  超限即 429，不做凭证>用户择优；TPM 预占全败归还。
- 生产 `GLOBAL_RPM` 硬顶 5000（超配钳制并告警）。
- 爆破阈值缺省：key 5 次/600s 锁 600s；IP 30 次/300s。
- 停机宽限 60s：drain 顺序 server.close → otel → closeables（inference 退订、settle-wake、
  request-log）→ redis → db；宽限耗尽 exit(1)。
- PG 池 10；上游连接超时 10s、整体 deadline 120s（可配）。

## 5. 装配边界与跨包裁决

```
apps/gateway/src/assembly.ts（唯一装配根）
├── @tokenlens/db createDb ──┬─→ billing/composition createPostgresBilling
│                            ├─→ observability/composition（trace/audit/request-log stores）
│                            └─→ control-plane stores（新增 ./composition 出口）
├── runtime createRedisClient ──┬─→ inference createRedisHealthStore
│                               ├─→ runtime createSlidingWindowLimiter（本波新增）
│                               └─→ runtime createKeyBruteForceGuard / createAuthFailureGuard（本波新增）
├── @tokenlens/ai createAi ──→ inference createInference（catalog/billing 桥注入）
└── accounts createAccounts（鉴权读模型 + funding resolver 桥）
```

- **C-G1 CatalogPort 扩展（inference 小修）**：`findMapping(externalModel, pricing: { userId,
  body })`——费率卡系数按用户解析、模态单位上界按请求体推导（v1 buildQuote 语义），目录快照
  的 coefficient/unitPrice/unitUpperBound 因此是「请求时点已解析」值。resolveChannels 不带
  用户维度（渠道路由无用户语义）。同迁移单元修订 inference 文档附录。
- **C-G2 报价解析住在装配桥**：gateway `adapters/catalog-port` 组合 control-plane 映射读 +
  费率卡上下文 + `@tokenlens/billing` 纯函数（`pickCoefficient`/`measurementOf`/
  `reservationStrategyOf`/`strategyOf`，单一真相不复制）→ inference 快照。control-plane 不
  反向依赖 billing（§5.2 无此边）；app 只做调用序列编排，不做规则（P5 红线）。
- **C-G3 BillingPort 桥**（gateway `adapters/billing-port`）：inference 候选 → `BillingQuote`
  （inputTokenUpperBound 逐候选盖章 + maxOutputTokens + explicitlyFree）；signal 蛇形→点分
  词表映射 + 收据字段对齐；reserveChannel 以 `estimateMaxCost`（官方价口径 coefficient=1）
  自算 amount。reservationLimit/Policy 由 gateway config 持有（铁律 3）。
- **C-G4 FundingSourceResolver 归 accounts**：`@tokenlens/accounts/composition` 新增
  `createPgFundingSourceResolver(db)`（api_keys/users 凭证→订阅绑定/转按量/日限额；SQL 住
  accounts 的 postgres adapter——billing 文档 §8 明示「resolver 桥接在 app assembly 完成」，
  本波落位到 accounts 侧 composition 出口，gateway assembly 只取件，SQL 不进 app）。
- **C-G5 限流/爆破机制归 runtime**：v1 core 的 sliding window limiter（RPM ZSET + TPM 预占
  hash + Lua）与 key/IP 双爆破 guard（含 degraded 本地粗限）平移 `@tokenlens/runtime`
  （`createRedisScriptRunner` 底座的自然消费者；client-api/admin-api 后续同源消费）。
  限流**策略**（维度组装、并罚制、global 维）住 gateway `http/middleware/rate-limit`。
- **C-G6 App-JWT 归 gateway**：目标树 routes 含 `oauth`；identity 会话令牌是控制台 user/admin
  realm 形态（无 app_id/scope/audience），机器凭证 App-JWT 的签发/验签是网关协议面
  （payload 与 v1 线格式逐字段一致），依赖 jose；凭证事实校验走 accounts。
- **C-G7 错误码命名空间化**（§2.3 R-E1）：status/触发条件与 v1 逐项等价，码字符串升级为
  目录码；e2e 与测试矩阵同步采纳。
- **C-G8 settle-wake 生产端**归 gateway `adapters/settle-wake`（`pg_notify`，通道名单一真相
  常量；消费端 worker 波建 LISTEN）。
- **C-G9 生成任务 pg 存储**归 inference（自家端口的 adapter，`createPostgresGenerationTaskStore`
  根出口导出，与 `createRedisHealthStore` 同范式）；表已建（migration 0053/0054）。

## 6. 演进与显式不迁

- 废弃键告警（`DEFAULT_USER_RPM` 等 v1 遗留 env）保留告警不保留语义（用户级限流无兜底默认）。
- `GENERATION_MAX_ACTIVE_PER_USER` 同上（生成并发上限未迁，见 MIGRATION §5 挂账）。
- overflow-alert / dead-credential 告警订阅（v1 wire*Alert）：observability/control-plane
  后续波，本波不迁（inference B9 同裁决）。
