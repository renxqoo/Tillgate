# AI Gateway API 契约（v0.1）

> 配套文档：`requirements.md`（业务逻辑）、`data-model.md`（数据模型）
> 覆盖一期（P0）。接口分两层：**对外接口**（网关，供客户端/企业 Agent 调用）与**管理端接口**（供 Next.js 控制台调用）。

---

## 1. 通用约定

- 对外接口基础路径 `/v1`，格式完全遵循 OpenAI 风格，客户端零改动接入。
- 鉴权头：`Authorization: Bearer <凭证>`，凭证二选一：
  - 静态虚拟 Key：`ag_` 前缀
  - 网关签发 JWT（企业 Agent，经 `/oauth/token` 换取）
- 时间：UTC，ISO 8601。
- 金额对外展示为元（小数），内部存储厘（本契约不含金额字段，管理端接口按需）。
- 所有对外错误响应统一 OpenAI 风格信封：`{"error": {"message", "type", "code", "param", "request_id", "suggestion"}}`——`request_id` 供客户端凭 ID 查日志排障，`suggestion` 给可操作建议（如「渠道维护中，请稍后重试」）。
- 上游响应透传时**剥离上游敏感信息**（不暴露渠道内部错误细节给客户端，管理端日志可见完整原因）。

---

## 2. 对外接口

### 2.1 POST /v1/chat/completions — 对话补全

**请求**：OpenAI 标准格式（`model` / `messages` / `stream` / `temperature` / `max_tokens` / `top_p` / `stop` / `presence_penalty` / `frequency_penalty` / **`tools` / `tool_choice`（企业 Agent 工具调用，透传支持，不属于"未知参数忽略"范围）** / `user` 等），未知参数忽略。

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
- `usage` 缺失时网关按估算系数填充（1 token ≈ 3.5 字符，全部按未缓存输入计）。
- `model` 返回**真实模型名**（映射后）。

**流式响应**（`stream: true`）：`Content-Type: text/event-stream`，逐帧透传 OpenAI chunk 格式（`choices[].delta`），流尾 `data: [DONE]`。计量在流结束后进行（从流尾 usage 捕获，缺失则估算）。

**流式错误与中断语义**：
- 流开始前（首帧前）出错 → 返回正常 JSON 错误响应（错误码表格式）。
- 流开始后上游/网关出错 → 发送 OpenAI 风格错误 chunk：`data: {"error": {"message", "type", "code"}}` 后结束（不再发 `[DONE]`；客户端以 error chunk 为准）。
- 客户端中途断开 → 网关内部主动断开上游连接（停止生成、节省成本），客户端无感；计费按已收内容估算（requirements.md 5.11）。
- chunk 中 `model`/`id` 默认**不改写**（透传上游真实值）；"改写为对外模型名"为可配置开关。

### 2.2 GET /v1/models — 模型列表

```json
{ "object": "list", "data": [ { "id": "gpt-4o-mini", "object": "model", "created": 0, "owned_by": "ai-gateway" } ] }
```

- 返回当前凭证（含 scope 限制）**可用的上架模型**（`model_mappings.status = 0`）。

### 2.3 POST /oauth/token — 企业 Agent 换 Token（client_credentials）

**请求**（form-urlencoded 或 JSON；认证二选一：body 传参，或标准 Basic Auth `Authorization: Basic base64(client_id:client_secret)`）：

```
grant_type=client_credentials
client_id=<app.client_id>
client_secret=<app.client_secret>
```

**成功**：

```json
{ "access_token": "<JWT>", "token_type": "Bearer", "expires_in": 7200 }
```

**失败**：`400 invalid_request`（参数缺失）/ `401 invalid_client`（凭证错误或 App 已禁用）。

**爆破防护**：按 `client_id + IP` 维度限流（默认 10 次失败/分钟 → 临时锁定 10 分钟），锁定后返回 `429 rate_limit_exceeded`。

- JWT 载荷：`sub`=user_id、`app_id`、`scope`（App 限制项）、`coefficient`（费率卡系数快照）、`iat`/`exp`、`jti`、`iss`=`ai-gateway`。
- 撤销：**禁用 App**（清状态缓存，已签发 JWT 立即全部失效）；单令牌紧急吊销走 jti 黑名单（管理端功能，P1）。**轮换 client_secret 不撤销已签发 JWT**（JWT 由网关密钥签发）。

### 2.4 GET /healthz — 存活探针（无鉴权）

返回 `{"status":"ok"}`；K8s/Docker healthcheck 用。

### 2.5 POST /v1/embeddings — 向量化（一期）

OpenAI 标准格式（`model` / `input` / `encoding_format`），透传 + usage 计量（规则同 2.1）；embedding 模型经 `/v1/models` 一并列出。五家一期供应商均支持，企业 Agent 向量化场景直接可用。

---

## 3. 对外错误码（OpenAI 风格）

| HTTP | code | 场景 |
|---|---|---|
| 400 | invalid_request | 请求格式错误（不合法 JSON / 缺 messages） |
| 401 | invalid_api_key | 凭证不存在 / 已吊销 / 已过期 / 已冻结 |
| 402 | insufficient_balance | 可用余额不足，**预扣失败**（请求前拦截，不产生上游调用） |
| 404 | model_not_found | 模型不存在或未上架 |
| 413 | payload_too_large | 请求体超过上限（默认 16MB） |
| 429 | rate_limit_exceeded | 网关限流（RPM/TPM/QPS 超限），响应带 `Retry-After`（可选附 `X-RateLimit-*` 头） |
| 429 | upstream_rate_limited | 上游 429 透传（渠道级，网关会尝试换渠道） |
| 500 | upstream_error | 上游异常（错误信息脱敏后透传） |
| 503 | no_available_channel | 模型映射的所有渠道不可用（禁用/熔断中） |

---

## 4. 管理端接口（控制台后端 REST，前缀 `/api`）

> 调用方：Next.js 控制台（服务端调用，不直接暴露公网）。会话鉴权：HttpOnly Cookie 中的面板 JWT（24h），管理端接口校验 `role=admin`。
> 分页统一：`?page=&page_size=`（**page_size 上限 100**），返回 `{list, total, page, page_size}`。时间范围统一 `?from=&to=`（UTC）。

### 4.1 会话与用户（普通用户 + 管理员共用）

| 方法/路径 | 说明 |
|---|---|
| `GET /api/me` | 当前用户信息（含余额、订阅摘要、状态） |
| `POST /api/auth/login` | 登录：一期本地账号（用户名+密码） |
| `POST /api/auth/oidc-login` `{id_token}` | OIDC 建会话（P1）：**OIDC 重定向流程由 Next.js 服务端执行**（code 换 token、校验 IdP 签名），再调本接口由 admin-api 建立会话——admin-api 不直接对接 IdP |
| `POST /api/auth/logout` | 注销 |
| `GET /api/me/transactions?from&to&page` | 自己的资金流水 |
| `POST /api/redeem` `{code}` | 兑换充值码（成功 → 余额增加并返回新余额）；失败：`400 invalid_code`（不存在）/ `400 code_expired`（已过期）/ `409 code_already_used`（已使用） |
| `GET /api/me/subscription` | 当前订阅信息（套餐/生效期/剩余额度），无订阅返回 null |
| `POST /api/subscriptions` `{plan_id}` | 用余额购买套餐（扣余额，写 transactions type=subscribe；余额不足 402） |

### 4.2 用户侧：Key 与应用

| 方法/路径 | 说明 |
|---|---|
| `GET /api/keys` | 自己的 Key 列表 |
| `POST /api/keys` `{name, remark?, expires_at?, rpm_limit?, tpm_limit?}` | 创建，**明文 Key 仅在响应中出现一次** |
| `PATCH /api/keys/:id` | 改名/限流/过期调整（不可修改 Key 本身） |
| `DELETE /api/keys/:id` | 吊销（立即失效） |
| `GET /api/apps` / `POST /api/apps` | 应用列表 / 创建（返回 `client_id` + `client_secret`，**secret 仅此一次**） |
| `DELETE /api/apps/:id` | 禁用应用（清 App 状态缓存，所有已签发 JWT 立即失效） |
| `POST /api/apps/:id/rotate-secret` | 轮换 secret（旧 secret 不能再换新 JWT；**不影响已签发 JWT**） |

### 4.3 用户侧：用量

| 方法/路径 | 说明 |
|---|---|
| `GET /api/usage?from&to&model&page` | 自己的用量明细（tokens、费用、模型、时间；含 billed_by/plan_amount/payg_amount） |
| `GET /api/usage/summary?from&to` | 按日聚合（图表用） |

### 4.4 管理端：用户

| 方法/路径 | 说明 |
|---|---|
| `GET /api/admin/users?q&status&page` | 用户列表（搜索/筛选） |
| `PATCH /api/admin/users/:id` `{status?, rate_card_id?}` | 封禁/解封、绑定费率卡 |
| `POST /api/admin/users/:id/adjust` `{amount, remark}` | 手动调额（正负皆可，写 transactions + audit） |

### 4.5 管理端：供应商 / 渠道

| 方法/路径 | 说明 |
|---|---|
| `GET/POST/PATCH/DELETE /api/admin/providers` | 供应商 CRUD（base_url、协议类型） |
| `GET/POST/PATCH/DELETE /api/admin/channels` | 渠道 CRUD（上游 Key 加密存储，编辑不回显；**PATCH 更换上游 Key 后自动清除「凭据无效」状态**） |
| `POST /api/admin/channels/:id/test` | 连通性测试：优先 `GET /v1/models`（快），失败回退最小补全请求（max_tokens=1）；返回耗时/结果/错误原因 |
| `POST /api/admin/channels/:id/cooldown-clear` | 手动解除熔断 |
| `POST /api/admin/channels/import` | 批量导入渠道（JSON 数组：provider/name/api_key/models/weight/priority），返回成功/失败逐条明细 |

### 4.6 管理端：模型映射

| 方法/路径 | 说明 |
|---|---|
| `GET/POST/PATCH/DELETE /api/admin/models` | 映射 CRUD（external_name、real_model、官方单价：输入/输出/缓存输入、fallback 模型链、参数规则、上下架） |
| `PATCH /api/admin/models/:id/channels` | 绑定/调整该模型可用渠道与权重（关联表维护） |

### 4.7 管理端：充值码

| 方法/路径 | 说明 |
|---|---|
| `POST /api/admin/redeem-batches` `{count, amount, expires_at?}` | 生成批次（返回该批码明文，一次性） |
| `GET /api/admin/redeem-batches` | 批次列表（含已用数） |
| `GET /api/admin/redeem-batches/:id/codes?status&page` | 批次内码明细（脱敏哈希/状态/兑换人） |

### 4.8 管理端：报表与日志

| 方法/路径 | 说明 |
|---|---|
| `GET /api/admin/stats/overview` | 仪表盘：今日请求量/tokens/费用/成功率/各渠道健康状态 |
| `GET /api/admin/stats/usage?from&to&group=user\|model\|channel` | 多维度用量与费用聚合 |
| `GET /api/admin/logs?from&to&user_id&status_code&model&page` | 请求日志查询（30 天） |
| `GET /api/admin/audit-logs?page` | 管理操作审计 |

### 4.9 管理端：费率卡（定价档位）

| 方法/路径 | 说明 |
|---|---|
| `GET/POST/PATCH /api/admin/rate-cards` | 费率卡 CRUD（名称、状态、系数；一期全局系数，按模型覆盖二期） |
| `GET /api/admin/rate-cards/:id/users` | 查看绑定该卡的账户 |

### 4.10 管理端：套餐与订阅（二期）

| 方法/路径 | 说明 |
|---|---|
| `GET/POST/PATCH /api/admin/plans` | 套餐 CRUD（价格、周期、金额额度、fallback_to_balance 开关、状态） |
| `GET /api/admin/subscriptions?plan_id&status&page` | 订阅列表 |
| `POST /api/admin/subscriptions/:id/renew` | 续费（开启新订阅期） |
| `POST /api/admin/subscriptions/:id/cancel` | 取消（剩余额度作废） |

---

## 5. 会话与权限（控制台）

| 角色 | 可见范围 | 可访问 |
|---|---|---|
| 管理员 | 全部 | 4.4 ~ 4.8 + 4.1~4.3 |
| 普通用户 | 自己 | 4.1 ~ 4.3 |

- 面板 JWT：HttpOnly Cookie、24h、`{sub, role, iat, exp}`。
- 管理员角色由超级管理员在 `users.role` 上标记（0 普通 / 1 管理员，二期再做角色表）。

---

## 6. 二期预留

| 接口 | 说明 |
|---|---|
| `POST /api/pay/callback` | 在线支付回调（P2） |
| `POST /v1/messages` | Anthropic Messages 入站表面（Claude 生态客户端直连，按需） |
| `GET /health` | 深健康：上游可达性 + 熔断状态 + 滚动错误率，异常 503（P1） |
| `POST /api/webhooks` | 事件推送：余额不足提醒、充值成功通知（P2） |
| `GET /api/admin/stats/export` | 报表导出 CSV（P1） |
