# TokenLens API 契约（v0.2）

> 本文档自 v1（ai-getway）同名文档适配至 v2 结构；接口与结构以代码为准。
> 配套文档：[project-structure-refactoring.md](./project-structure-refactoring.md)（结构目标态）、`billing-flow-deep-dive.md`（[计费全链路](./billing-flow-deep-dive.md)）、`gateway-pipeline.md`（[网关管线](./gateway-pipeline.md)）
> 接口分两层：**对外接口**（`apps/gateway`，供客户端/企业 Agent 调用）与**控制台接口**（`apps/client-api` 用户面 + `apps/admin-api` 管理面，供前端经服务端代理调用）。

---

## 1. 通用约定

- 对外接口基础路径 `/v1`，格式完全遵循 OpenAI 风格，客户端零改动接入。
- 鉴权头：`Authorization: Bearer <凭证>`，凭证二选一：
  - 静态虚拟 Key：`sk_` 前缀（`KEY_PREFIX` 可配，默认 `sk_`；SHA-256 落库，明文仅创建时展示一次）
  - 网关签发 App JWT（企业 Agent，经 `/oauth/token` 换取；`typ=app_jwt`，其他 JWT 形态一律 401——信任根分离）
- 时间：UTC，ISO 8601。
- 金额对外展示为元（小数），内部 `numeric(38,18)` 元 + Decimal 全精度（`packages/billing/src/domain/money.ts` 单一真相；本契约不含金额字段，控制台接口按需）。
- 所有对外错误响应统一信封：`{"error": {"code", "message", "context"?}}`。**code 为命名空间目录码**（`gateway.invalid_body` / `http.unauthorized` / `inference.model_not_found` / `billing.insufficient_balance` 等）——码表由各能力包错误目录在 app 错误面装配期合成（见 §3）。
- 上游响应透传时**剥离上游敏感信息**（内容层脱敏：内部寻址替换为 `[upstream]`、真实模型名替换为对外目录名、长度截断默认 200 字符；细节层只进日志关联 requestId，`apps/gateway/src/http/sanitize.ts`）。
- 请求体上限默认 **10MB**（`GATEWAY_BODY_LIMIT_BYTES`，超出 413）；multipart 上传文件上限 16MB（`GATEWAY_UPLOAD_MAX_FILE_BYTES`，且被请求体上限钳制）。
- 鉴权按已注册端点路径挂载：未注册路径 404 而非 401。

---

## 2. 对外接口（apps/gateway）

### 2.1 POST /v1/chat/completions — 对话补全（规范形）

**请求**：OpenAI 标准格式（`model`（1~64 字符）/ `messages`（1~1000 条）/ `stream` / `max_tokens` / `max_completion_tokens`（正整数 ≤1e6）/ `n`（≤16）等），schema 校验后**未知参数原样透传**（`tools` / `tool_choice` 不属于「未知参数忽略」范围，完整透传）。负数/非整数输出预算参数在入口拒绝（不得流向上游与预扣口径）。

**非流式响应**（OpenAI 标准）：

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "created": 1750000000,
  "model": "deepseek-chat",
  "choices": [{ "index": 0, "message": { "role": "assistant", "content": "..." }, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30 }
}
```

- `usage` 透传供应商原值（含各家缓存字段：OpenAI 风格 `prompt_tokens_details.cached_tokens`、DeepSeek 风格 `prompt_cache_hit_tokens` 等）；网关内部按标准化字段（未缓存输入/缓存输入/输出）计量计费（官方价 × 费率卡系数）。
- `usage` 缺失或校验失败时按估算结算并留 `estimated`/`estimateReason` 留痕（`uncertain` 状态已删除）。
- `model` 字段：**响应侧 model 字段替换为对外目录模型名**（可配置开关；与错误脱敏中的真实模型名替换共同维护模型目录抽象，防止暴露上游真实部署名——与 v1「返回真实模型名」相反，属契约变化，见 §7）。

**流式响应**（`stream: true`）：`Content-Type: text/event-stream`，上游 chunk **逐块直通**（不缓冲、不逐帧改写；`x-accel-buffering: no` 防 nginx 缓冲，显式带 `x-request-id` 响应头供客户端对齐账单/日志）。流尾 `data: [DONE]`。计量在流结束后从可信 usage 捕获；缺失则按估算结算并留 `estimated`/`estimateReason` 留痕。

**流式错误与中断语义**：
- 流开始前（首帧前）出错 → 返回正常 JSON 错误响应（§3 错误码表格式）。
- 流开始后出错 → 发送 OpenAI 风格错误 chunk：`data: {"error": {"message", "type", "code"}}` 后结束（客户端以 error chunk 为准）。
- 客户端中途断开 → 网关主动断开上游连接（停止生成、节省成本）；有可信 usage 精确结算，缺 usage / 用户取消按估算结算并留痕（用户侧取消归因词表：`client_disconnect` / `request_cancelled` / `aborted`）。
- 上游 4xx 错误体按线协议翻译后**原状态码 + 脱敏消息透传**（ADR-0004）；上游 5xx / 网络类错误经候选循环全败后以 502 网关语义出站（不透传单一上游状态码）。

### 2.2 GET /v1/models、GET /v1/models/:model — 模型目录

```json
{ "object": "list", "data": [ { "id": "gpt-4o-mini", "object": "model", "owned_by": "ai-gateway", "pricing_unit": "token" } ] }
```

- 数据源 = `control-plane` 只读目录（`listEnabledMappings`，仅上架模型）；按当前凭证 scope（App JWT `scope.models` 白名单）过滤。
- **三协议形状**：带 `anthropic-version` 头返回 Anthropic 原生列表形；带 `x-goog-api-key` 头返回 Gemini 原生形（`models/{name}`）；OpenAI 形为缺省。
- `GET /v1/models/:model` 详情：白名单外与不存在**同口径 404**（不泄漏目录）；Gemini 风格 `models/` 前缀自动剥离。

### 2.3 POST /oauth/token — 企业 Agent 换 Token（client_credentials）

**请求**（form-urlencoded / JSON / 标准 Basic Auth 三选一传递凭证）：

```
grant_type=client_credentials
client_id=<app.client_id>
client_secret=<app.client_secret>
```

**成功**：

```json
{ "access_token": "<JWT>", "token_type": "Bearer", "expires_in": 3600 }
```

**失败**（OAuth 标准错误形 `{error, error_description}`，非 OpenAI 信封）：
- `400 unsupported_grant_type`（仅支持 client_credentials）
- `401 invalid_client`（凭证错误 / App 已禁用 / 凭证缺失）

**爆破防护（双锁）**：IP 维（`AUTH_IP_FAILURE_LIMIT` 默认 30 次/300s）+ `client:{client_id}` 维（`AUTH_KEY_FAILURE_THRESHOLD` 默认 5 次失败/600s → 锁 600s）——IP 可轮换，按 clientId 锁定才能挡撞 secret；锁定后 401 invalid_client。

- JWT：HS256、`iss`=`JWT_ISSUER`（默认 `ai-gateway`）、`aud`=`JWT_AUDIENCE`（默认 `ai-gateway-api`）、有效期 `JWT_TOKEN_TTL_SECONDS`（默认 3600s，最小 60s）。
- 载荷：`sub`=user_id、`app_id`（apps.app_id 字符串）、`typ=app_jwt`、`scope`（全量入令牌：models 白名单 / rpm / tpm——网关准入与模型列表过滤的执行依据）、`iat`/`exp`。
- 撤销：**禁用 App 后已签发 JWT 立即失效**（每次请求 `resolveApp` 复核应用状态与属主）；**轮换 client_secret 不影响已签发 JWT**（JWT 由网关密钥签发）。

### 2.4 GET /healthz、/livez、/readyz — 探针（无鉴权）

- `/livez`：纯 200（存活，LB 用，不查依赖）。
- `/healthz`：查 PostgreSQL。
- `/readyz`：查 PostgreSQL + Redis（装配了 Redis 探针时）。
- worker 进程另有 `/health` 深度报告（`x-health-token` 守卫：per-job 快照、Redis/DB 依赖状态）。

### 2.5 推理端点矩阵（协议入站表面）

鉴权同 §1（Bearer sk_ Key / App JWT）。管线内部恒为规范形（OpenAI 线格式）：入站协议在路由边界双向翻译（codec 单一真相在 `@tokenlens/ai` protocol，`apps/gateway/src/http/contracts/inference-endpoints.ts` 注册）。

| 端点 | 说明 |
|---|---|
| POST /v1/chat/completions | OpenAI chat（规范形本体） |
| POST /v1/completions | legacy text completions（codec 翻译） |
| POST /v1/responses | OpenAI Responses（codec 翻译，非流式/流式） |
| POST /v1/messages | Claude Messages（codec 翻译，非流式/流式） |
| POST /v1beta/models/{model}:generateContent / :streamGenerateContent | Gemini 原生（路径参数形态；流式） |
| POST /v1/embeddings、/v1/engines/{model}/embeddings | 向量（含 pre-1.0 SDK 引擎别名，路径段模型名注入 body.model，同管线计费） |
| POST /v1/images/generations | 图像生成（JSON，按张计费） |
| POST /v1/images/edits | 图像编辑（multipart，file 字段 `image`，MIME 白名单默认 png/jpeg/webp） |
| POST /v1/audio/speech | TTS（JSON 入 / 二进制出，按字符计费） |
| POST /v1/audio/transcriptions、/v1/audio/translations | STT（multipart，file 字段 `file`，音频 MIME 白名单，按秒计费） |
| POST /v1/rerank、/v1/moderations | 重排 / 审核（按次计费） |
| POST /v1/video/generations、POST /v1/music/generations | 异步生成任务提交（见 2.6） |
| GET /v1/videos/{id}、GET /v1/musics/{id} | 任务查询（见 2.6） |

- 计费单位：模型目录 `pricingUnit` ∈ token / request / image / second / char + unit_price；金额 =（token 部分 + units × unit_price）× 系数（`packages/billing/src/domain/rating` 单一真相）。
- 费率卡系数解析优先级 model > group（pricing_group 匹配）> global。
- 上游协议族（vendor 注册表，管理面 GET /v1/vendor-catalog）：openai-compatible / anthropic / gemini / azure-openai / aws-bedrock（SigV4+eventstream）/ vertex-ai（SA JWT）等，adapter 注册表在 `@tokenlens/ai`。
- 入口 schema 钳制：messages ≤1000、embeddings input 数组 ≤2048、prompt ≤32000 字符、n ≤16 等越界值 400 拒绝。

### 2.6 异步生成任务（video / music）

- 提交 `POST /v1/video/generations` / `POST /v1/music/generations` → `201 {id, object, model, status:"queued"}`（id 即任务号；按次或按秒计费）。受理前失败（余额 402 / 白名单 403 / 模型 404 / 限流 429）按 §3 信封出站。
- 查询 `GET /v1/videos/:id` / `GET /v1/musics/:id`：status / video_url / audio_url / 尺寸 / 失败原因；**归属校验**（非属主 404 `inference.task_not_found`）。
- 计费语义：提交即预留（两阶段账本 authorize），worker 轮询驱动终态——succeeded 按收据实扣（units=1 或 duration 快照）、failed/expired 释放不扣（无「真扣+退款」双轨）。
- 任务 TTL 默认 1h（`GENERATION_TASK_TTL_MS`），轮询租约宽限 30s（`GENERATION_LEASE_GRACE_MS`）。
- 管理端任务列表：GET /v1/generation-tasks（§4.12）。

### 2.7 数据面透传契约（§3.6 摘要）

- 上游 chunk 逐块直通 C 端（`pipeThrough`、不缓冲、不解析改写）；心跳注入与静默超时是保护性注入，不是业务处理。C 端 TTFB 与流速不得被网关自身处理拖慢。
- 触碰「不改写」的仅有三种透传例外：① 跨协议最小必要转换（请求体/响应流/**错误体**，codec 端点）；② 响应侧 model 字段替换（可配置开关）；③ 错误出站三层（结构层翻译为 OpenAI 错误信封；内容层保留上游原文仅脱敏；细节层只进日志）。
- 计费取证（usage 捕获）、审计、trace、渠道健康一律经 `onEvent` 订阅 `AiEvent` 旁路消费，不阻塞数据面。

---

## 3. 对外错误码（v2 错误目录体系）

渲染机制（`packages/errors` + `packages/http/src/errors`）：

- 错误码分命名空间目录（`gateway.*` / `http.*` / `inference.*` / `billing.*` / `accounts.*` / `observability.*` …），各能力包自有目录在 app 错误面装配期合成全量目录（`composeErrorCatalogs`，命名空间冲突装配期即抛）。
- 每码归入 **category 七项闭集**，category → 默认 status：`invalid_input` 400 / `not_found` 404 / `conflict` 409 / `forbidden` 403 / `quota_exhausted` 402 / `rate_limited` 429 / `unavailable` 503。
- status 解析链：**face override > http 自有码修正表 > category 默认表**（`http.payload_too_large`→413、`http.unauthorized`→401、`http.unsupported_media_type`→415；gateway face 将 `inference.upstream_failed` 升 502）。
- 环境故障（infrastructure）出站恒 503 通用文案（身份码保留）；缺陷/未知恒 500 `errors.unhandled` 通用文案（细节只进日志——内外分际）。
- 限流错误携带 `retryAfterMs`，由 handler 统一渲染 `Retry-After` 响应头（秒，向上取整）。

网关对外错误码表（常用项）：

| HTTP | code（目录码） | 场景 |
|---|---|---|
| 400 | gateway.invalid_body | 请求体 schema 校验失败（缺 model/messages、参数越界） |
| 400 | http.validation_failed / http.invalid_json / http.invalid_request | 参数校验失败 / 非法 JSON / 无效请求 |
| 401 | http.unauthorized | 凭证缺失/不存在/已吊销/过期/冻结；Key 失败锁定；JWT 形态不支持（仅 app_jwt） |
| 402 | billing.insufficient_balance | 可用余额不足，**预扣失败**（请求前拦截，不产生上游调用；信用口径 = 余额+授信−在途） |
| 403 | inference.model_not_allowed | 凭证模型白名单（App scope）拒绝 |
| 404 | inference.model_not_found | 模型不存在或未上架 |
| 404 | http.not_found | 路径未注册 |
| 413 | http.payload_too_large | 请求体超过上限（默认 10MB） |
| 415 | http.unsupported_media_type | multipart 端点 Content-Type / 文件类型不在支持集 |
| 429 | gateway.rate_limit_exceeded | 网关限流（RPM/TPM 超限），响应带 `Retry-After` |
| 上游原码 | （信封 message 位） | 上游 4xx 原码 + 已翻译/脱敏消息透传（ADR-0004） |
| 500 | errors.unhandled | 未知缺陷兜底（通用文案，细节进日志） |
| 502 | inference.upstream_failed | 上游 5xx/网络类故障候选循环全败（网关语义） |
| 503 | inference.no_available_channel | 模型映射的所有渠道不可用（禁用/熔断中/预算耗尽） |
| 503 | inference.finalize_unavailable | 非流式结算重试耗尽：未交付不结算，宁可让用户重试 |
| 503 | inference.billing_receipt_unavailable | 生成任务收据持久化暂不可用（预留保留交 recover 兜底） |

> 与 v1 的差异：v1 的 `408 request_cancelled`、`503 server_draining` 在 v2 **不再是对外错误码**——请求中止与停机语义保留在计费归因词表（`billing/domain/rating` 的 USER_SIDE_CANCELS / `server_draining`）与停机宽限（`GATEWAY_SHUTDOWN_GRACE_MS` 默认 60s，SIGTERM 拒新请求 + 宽限排空），不入错误目录。

---

## 4. 控制台接口（client-api 用户面 + admin-api 管理面，前缀均为 `/v1`）

> 调用方：Next.js 控制台（apps/client / apps/admin，服务端代理调用）。admin-api 不暴露公网（nginx 不发布端口）；client-api 仅 `/v1/oauth/*` 与 `/v1/payments/notify/*` 回调经 nginx 选择性暴露。
> 会话鉴权（v2 变化）：`Authorization: Bearer <会话 JWT>`——**无 Cookie、无 CSRF**，控制台类客户端自持 Bearer；会话经验签 + jti + 吊销线 + 账户状态复核，TTL 默认 24h（`SESSION_TTL_SECONDS` 可配 60s~30d）。用户面与管理员会话为 identity 双 realm（物理隔离），401 不区分原因（防账号枚举）。

### 列表接口统一约定（R10）

所有「记录列表」接口统一三件套：

| 参数 | 说明 |
|---|---|
| `?page=&page_size=` | 分页（page 从 1 起，**page_size 上限 100**），响应统一 `{list, total, page, page_size}`；非法值容错回退默认，超上限 clamp |
| `?q=` | 文本搜索（1~100 字符，ilike 模糊；`%`/`_`/`\` 按字面匹配；按接口白名单列生效，无文本列的列表不提供） |
| `?sort_by=&order=asc\|desc` | 排序（字段白名单，白名单外 **400 admin.invalid_sort_field**，不静默回退）；不传时默认时间倒序，多主排序附加 `id desc` 保证分页稳定 |

实现组件：后端 `@tokenlens/http` 的 `listQuerySchema`（pagination + search + sort 合成，`packages/http/src/pagination/list-query.ts`）；前端 `@tokenlens/ui` 的 `DataTable` + `ListPanel`（`packages/ui/src/components/data/`）+ `@tokenlens/api-client` 的 `core/pagination`（`Paginated<T>` / `buildListQuery`）。
分组统计类接口（`stats/*`、`usage/summary`、`usage/by-model`、`tracing/topology`）与外部目录（`model-catalog`）不是记录列表，不适用本约定。时间范围统一 `?from=&to=`（UTC）。

### 4.1 用户面：会话与账户（apps/client-api/src/http/routes/）

| 方法/路径 | 说明 |
|---|---|
| `GET /v1/auth/capabilities` | 登录能力探测（公开；前端显隐按钮的单一真相） |
| `POST /v1/auth/login` | 登录第一步：邮箱+密码 → 发 6 位邮箱验证码（强制两步）→ `200 {ok, twoFactorRequired:true, challengeId}`（不签会话；SMTP 未配置 → 503 fail-closed；60s 限发/账号） |
| `POST /v1/auth/login/verify` `{challengeId, code}` | 第二步：验 6 位邮箱码（5 分钟有效，错 5 次作废，一次性消费）→ 签发会话 Bearer JWT；首登赠额/lastLogin 在此步 |
| `POST /v1/auth/register` `{email, password}` | 邮箱自助注册第一步 → 发验证码 → `200 {ok, challengeId}`（邮箱占用 409；同 IP 超限 429；SMTP 未配置 503）；可选 `aff` 推荐码 |
| `POST /v1/auth/register/verify` `{challengeId, code}` | 第二步：验码通过建号（subject=email）+ 签发会话 + 首登赠额（并发撞邮箱由唯一索引兜底 → 409） |
| `POST /v1/auth/logout` | 注销（吊销当前 jti） |
| `POST /v1/auth/password` | 自助改密（改后全网会话下线） |
| `GET /v1/me` | 当前用户信息（含余额、订阅摘要、状态） |
| `PATCH /v1/me/display-name` `{displayName}` | 自助修改显示名称（1-32 字符去空白；审计 user.display_name_change） |
| `GET /v1/oauth/providers` | 已配置的第三方登录方式 `{providers:[github?,google?]}`（公开） |
| `GET /v1/oauth/:provider/authorize?next=` | 302 到 GitHub/Google 授权页（state 双提交：一次性 state + Redis 10 分钟；未配置 404） |
| `GET /v1/oauth/:provider/callback?code&state` | 验 state（不符 403）→ 换码取 profile → find-or-create（issuer=provider, subject=平台 id；邮箱不与本地账号合并）→ 会话 → 302 前端（next 仅站内） |

管理员二次登录（admin-api，默认关闭；SMTP 未配置时开启请求 503 fail-closed）：

| 接口 | 说明 |
|---|---|
| `POST /v1/auth/login`（开启 2FA 时，admin-api） | 密码正确 → `200 {twoFactorRequired:true, challengeId}`（不签会话；60s 限发） |
| `POST /v1/auth/login/verify`（admin-api） | 验 6 位邮箱码 → 签发 admin realm 会话 Bearer JWT |
| `POST /v1/me/two-factor` `{enabled}`（admin-api） | 管理员自助开关 |
| `GET /v1/me`、`POST /v1/me/password`（admin-api） | 管理员资料 / 自助改密 |

### 4.2 用户面：Key 与应用

| 方法/路径 | 说明 |
|---|---|
| `GET /v1/keys` | 自己的 Key 列表 |
| `POST /v1/keys` `{name, remark?, expires_at?, rpm_limit?, tpm_limit?}` | 创建，**明文 Key 仅在响应中出现一次** |
| `PATCH /v1/keys/:id` | 改名/限流/过期调整（不可修改 Key 本身） |
| `POST /v1/keys/:id/rotate` | 轮换 Key（新明文仅此一次，旧 Key 立即失效） |
| `DELETE /v1/keys/:id` | 吊销（立即失效） |
| `GET /v1/apps` / `POST /v1/apps` | 应用列表 / 创建（返回 `client_id` + `client_secret`，**secret 仅此一次**） |
| `POST /v1/apps/:id/disable` | 禁用应用（禁用即时生效，所有已签发 JWT 立即失效） |
| `POST /v1/apps/:id/rotate` | 轮换 secret（旧 secret 不能再换新 JWT；**不影响已签发 JWT**） |

### 4.3 用户面：用量与钱包

| 方法/路径 | 说明 |
|---|---|
| `GET /v1/usage?from&to&model&page` | 自己的用量明细（tokens、费用、模型、时间；含 `billedBy`（plan\|payg）/ `planAmount` / `paygAmount`——套餐消耗显示积分、余额消耗显示金额） |
| `GET /v1/usage/summary?from&to` | 按日聚合（图表用） |
| `GET /v1/usage/by-model?from&to` | 按模型聚合 |
| `GET /v1/usage/rate` | 实时速率（近 60 秒窗口的请求数与 tokens 数） |
| `GET /v1/wallet/accounts` | 自己的资产账户（余额/授信/在途） |
| `GET /v1/wallet/statement?from&to&page` | 自己的资金流水 |

### 4.4 用户面：订阅、支付、定价、推荐、组织

| 方法/路径 | 说明 |
|---|---|
| `GET /v1/plans` | 套餐目录（公开） |
| `GET /v1/subscriptions` | 当前订阅信息（套餐/生效期/剩余额度），无订阅返回 null |
| `POST /v1/subscriptions` `{plan_id}` | 用余额购买套餐（余额不足 402） |
| `POST /v1/subscriptions/:id/change` / `:id/renew` | 换套餐 / 续费（开启新订阅期） |
| `POST /v1/payments/orders`、`GET /v1/payments/orders`、`GET /v1/payments/orders/:id` | 支付下单 / 订单列表 / 详情（会话保护） |
| `GET /v1/payments/channels` | 可用支付渠道 |
| `POST /v1/payments/notify/:provider` | 支付回调（**公开**；按 provider 验签，回 success/fail） |
| `GET /v1/pricing` | 官方价目（公开） |
| `GET /v1/pricing/personal` | 会话个性化到手价（费率卡系数已应用） |
| `GET /v1/referrals` / `GET /v1/referrals/config` | 邀请概览 / 规则配置；注册 verify 增可选 `aff` 字段 |
| `POST /v1/redeem` `{code}` | 兑换充值码（成功 → 余额增加并返回新余额；失败：不存在 / 已过期 400，已使用 409） |
| `GET /v1/redeem/history` | 兑换历史 |
| `GET /v1/orgs`、`GET /v1/orgs/:id` | 组织列表 / 详情（owner 详情附带 `invitations[]` pending 列表，不含 token） |
| `POST /v1/orgs/:id/invitations` | 发邀请 |
| `POST /v1/orgs/:id/invitations/:invitationId/revoke` | owner 撤销待接受邀请（幂等 404） |
| `POST /v1/orgs/invitations/accept` | 受邀人接受 |
| `DELETE /v1/orgs/:id/members/:memberUserId` | owner 移除成员 |

### 4.5 管理面：用户与资金（apps/admin-api/src/http/routes/）

| 方法/路径 | 说明 |
|---|---|
| `GET /v1/users?q&status&page`、`GET /v1/users/:id` | 用户列表 / 详情 |
| `PATCH /v1/users/:id` `{status?, rate_card_id?}` | 封禁/解封、绑定费率卡 |
| `POST /v1/users/:id/set-password` | 管理员重置用户密码（全网会话下线） |
| `POST /v1/users/:id/adjust` `{amount, remark}` | 手动调额（正负皆可，写 transactions + audit） |
| `POST /v1/users/:id/gift` | 赠送（同调账链路） |
| `GET /v1/users/:id/transactions` | 用户资金流水 |
| `GET /v1/users/:id/audit-logs` | 用户维度审计 |
| `GET /v1/admin-keys`、`PATCH /v1/admin-keys/:id` | 管理面访问 Key 台账 |

### 4.6 管理面：供应商 / 渠道 / 渠道资金

| 方法/路径 | 说明 |
|---|---|
| `GET/POST/PATCH/DELETE /v1/providers` | 供应商 CRUD（base_url、协议类型） |
| `GET/POST/PATCH/DELETE /v1/channels` | 渠道 CRUD（上游 Key 加密存储，编辑不回显；PATCH 更换上游 Key 后自动清除「凭据无效」状态） |
| `POST /v1/channels/import` | 批量导入渠道（JSON 数组），返回成功/失败逐条明细 |
| `POST /v1/channels/:id/test` | 连通性测试（probe；返回耗时/结果/错误原因） |
| `GET /v1/channel-funds` | 渠道资金台账 |
| `POST /v1/channel-funds/recharge` / `adjust` | 渠道充值 / 调整 |

### 4.7 管理面：模型映射与目录

| 方法/路径 | 说明 |
|---|---|
| `GET/POST/PATCH/DELETE /v1/models` | 映射 CRUD（external_name、real_model、官方单价：输入/输出/缓存输入、fallback 模型链、参数规则、上下架） |
| `POST /v1/models/:id/channels` | 绑定/调整该模型可用渠道与权重 |
| `POST /v1/models/:id/test` | 模型连通性测试 |
| `GET /v1/model-catalog/sources` | 外部价目源列表（models.dev 等） |
| `GET /v1/model-catalog/price-history`、`GET /v1/model-catalog/:sourceId` | 价目历史 / 源内模型明细 |
| `POST /v1/model-catalog/import` | 从外部源导入官方价 |
| `GET /v1/vendor-catalog` | vendor/协议注册表（协议族 + 供应商 baseUrl 预设，装配自 `@tokenlens/ai` 词表） |

### 4.8 管理面：费率卡与汇率

| 方法/路径 | 说明 |
|---|---|
| `GET/POST/PATCH/DELETE /v1/rate-cards` | 费率卡 CRUD（名称、状态、系数；优先级 model > group > global） |
| `GET /v1/rate-cards/:id/users` | 绑定该卡的账户 |
| `GET /v1/rate-cards/:id/health` | 卡生效健康（命中分布/异常） |
| `GET /v1/fx/catalog` | 汇率目录状态 |
| `POST /v1/fx/catalog/refresh` | 刷新汇率 |
| `PUT/DELETE /v1/fx/catalog/override` | 手工覆写 / 清除覆写 |
| `PUT /v1/fx/catalog/buffer` | 汇率缓冲系数 |

### 4.9 管理面：套餐与订阅

| 方法/路径 | 说明 |
|---|---|
| `GET/POST/PATCH/DELETE /v1/plans` | 套餐 CRUD（价格、周期、金额额度、席位模式、状态）；kind 创建后不可变 |
| `GET /v1/subscriptions?plan_id&status&page` | 订阅列表 |
| `POST /v1/subscriptions/:id/renew` | 续费（开启新订阅期） |
| `POST /v1/subscriptions/:id/change` | 换套餐 |
| `POST /v1/subscriptions/:id/cancel` | 取消（剩余额度作废） |
| `POST /v1/subscriptions/:id/grant` | 人工授予订阅 |

### 4.10 管理面：充值码

| 方法/路径 | 说明 |
|---|---|
| `POST /v1/redeem-batches` `{count, amount, expires_at?}` | 生成批次（返回该批码明文，一次性） |
| `GET /v1/redeem-batches`、`GET /v1/redeem-batches/:id` | 批次列表（含已用数）/ 详情 |
| `GET /v1/redeem-batches/:id/codes?status&page` | 批次内码明细（脱敏哈希/状态/兑换人） |
| `POST /v1/redeem-batches/codes/:codeId/revoke` | 作废单个码 |
| `GET /v1/vouchers/:key` | 凭证文件取回（按 key 返回存储的凭证数据与 MIME 类型；不存在 404） |

### 4.11 管理面：计费运维与结算复核

| 方法/路径 | 说明 |
|---|---|
| `GET /v1/billing-operations` | 计费请求运维视图（卡单/失败清单） |
| `POST /v1/billing-operations/:requestId/retry` | 重试结算（审计留痕） |
| `POST /v1/billing-operations/:requestId/abandon` | 弃单（释放预留，全额不计费） |
| `GET /v1/generation-tasks` | 异步生成任务列表（video/music 终态与结算金额） |
| `GET /v1/payment-orders`、`POST /v1/payment-orders/:id/close` | 支付订单列表 / 手动关单 |

### 4.12 管理面：报表与日志

| 方法/路径 | 说明 |
|---|---|
| `GET /v1/stats/overview` | 仪表盘：今日请求量/tokens/费用/成功率/各渠道健康状态 |
| `GET /v1/stats/usage?from&to&group=user\|model\|channel` | 多维度用量与费用聚合 |
| `GET /v1/stats/trends` | 趋势序列 |
| `GET /v1/analytics/channel-ttft` | 渠道首字延迟（TTFT）分析 |
| `GET /v1/logs?from&to&user_id&status_code&model&page` | 请求日志查询（30 天窗） |
| `GET /v1/usage-logs?from&to&user_id&model&estimated&page` | 用量明细（含 `estimated`/`estimateReason` 估算扣款标记；仅管理面） |
| `GET /v1/audit-logs?page` | 管理操作审计 |

### 4.13 管理面：链路追踪（数据来自 trace-receiver → observability.traces）

| 方法/路径 | 说明 |
|---|---|
| `GET /v1/tracing/recent` | 最近 traces（24h；service/errorsOnly/minDurationMs/requestId/limit/beforeMs 过滤） |
| `GET /v1/tracing/traces/:traceId` | 单 trace 全部 span（瀑布图数据） |
| `GET /v1/tracing/by-request/:requestId` | 按 request_id 关联（计费复核「查链路」入口） |
| `GET /v1/tracing/topology?hours=24` | 渠道健康拓扑（尝试/错误/均延迟/最近错误聚合） |
| `GET /v1/tracing/stats` | trace 存储统计（分区列表、保留水位） |

### 4.14 管理面：运营

| 方法/路径 | 说明 |
|---|---|
| `GET/PUT /v1/marketing/settings` | 营销位/开关配置 |
| `GET /v1/referrals/relations`、`PATCH /v1/referrals/relations/:id` | 推荐关系列表 / 状态处置 |
| `GET /v1/referrals/payouts` | 推荐分成发放记录 |
| `GET/POST /v1/notifications`、`PATCH/DELETE /v1/notifications/:id` | 告警/通知渠道 CRUD |
| `POST /v1/notifications/:id/test` | 渠道测试投递（入 outbox，worker 投递） |

---

## 5. 会话与权限（控制台）

| 面向 | 会话 | 可访问 |
|---|---|---|
| 管理员 | admin realm 会话 Bearer JWT（identity 双 realm 隔离） | 4.5 ~ 4.14 + 管理员 4.1 子表 |
| 普通用户 | user realm 会话 Bearer JWT | 4.1 ~ 4.4 |

- 会话 JWT 带 `jti` + 吊销线（logout/改密/封禁即刻失效），TTL 默认 24h。
- 管理员资料/角色/授权策略归 `packages/control-plane`；登录凭据与 MFA 由 `packages/identity` 按 admin realm 管理。

---

## 6. 预留

| 项 | 说明 |
|---|---|
| `GET /api/admin/stats/export` | 报表导出 CSV（P1，未实现） |
| 事件推送 webhooks | 通知渠道（邮件/webhook）已就绪；面向用户的余额不足提醒等事件订阅入口待定 |

---

## 7. v1 → v2 契约差异速查

| 项 | v1 | v2 |
|---|---|---|
| 错误码 | OpenAI 风格扁平码（`invalid_request` 等） | 命名空间目录码（`http.unauthorized` 等）+ category 七项闭集驱动 status；信封增 `context` |
| 错误信封外 OAuth | `/oauth/token` 失败也用 401 invalid_client（OpenAI 信封） | OAuth 标准错误形 `{error, error_description}`（非 OpenAI 信封）；增 `400 unsupported_grant_type` |
| 响应 `model` 字段 | 返回真实模型名（映射后） | 响应侧替换为对外目录模型名（可配置开关）；错误消息中真实模型名同样脱敏 |
| 上游 4xx | 透传（脱敏） | 原码 + 已翻译脱敏消息透传（ADR-0004）；5xx/网络类合成 502 `inference.upstream_failed`（v1 为 `upstream_error` 500 族） |
| 控制台会话 | HttpOnly Cookie（ag_session/ag_admin_session）+ CSRF 面 | `Authorization: Bearer <会话 JWT>`（无 Cookie 无 CSRF）；jti + 吊销线 |
| JWT 载荷 | 含 `coefficient` 快照、`jti` | 不含 coefficient（计价快照由 billing 收据持有）；`typ=app_jwt`、scope 全量（models/rpm/tpm）；jti 黑名单未实现（禁用 App 即全量失效） |
| App JWT 有效期默认 | 2h | 3600s（`JWT_TOKEN_TTL_SECONDS`，≥60 可配） |
| 请求体上限 | 16MB | 默认 10MB（`GATEWAY_BODY_LIMIT_BYTES`）；multipart 上传文件另限 16MB |
| 408 request_cancelled / 503 server_draining | 对外错误码 | 移除出错误码表；语义保留在计费归因词表与停机宽限 |
| 爆破防护 | client_id + IP 单锁（10 次/分钟 → 锁 10 分钟） | IP 维 + `client:{id}` 维双锁（默认 5 次/600s → 锁 600s；IP 30 次/300s） |
| 管理端模型 | — | 增 `POST /v1/models/:id/test`、模型目录导入族、汇率族、渠道资金族、admin-keys |
| 用户端 | — | 增 `GET /v1/auth/capabilities`、`POST /v1/auth/password`、`POST /v1/keys/:id/rotate`、`GET /v1/payments/channels`、`GET /v1/usage/by-model`、`GET /v1/usage/rate`、`GET /v1/wallet/accounts`、`GET /v1/redeem/history`、`GET /v1/subscriptions/:id/change`、组织成员管理 |
| 生成任务提交响应 | `201 {id, task_id, status}` | `201 {id, object, model, status:"queued"}` |
| Playground 代理 | `POST /v1/playground/chat/completions`（client-api） | **已移除**（gateway 仅认 `typ=app_jwt`，操练场等其他 JWT 形态一律 401——信任根分离） |
| 深健康 `GET /health` | gateway 侧预留（P1） | gateway 未实现；worker 有 `x-health-token` 守卫的 `/health` 深报告 |
