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
- `usage` 缺失或校验失败时不得估算扣费：该请求的授权转 `uncertain`，等待供应商证据恢复或人工审计。
- `model` 返回**真实模型名**（映射后）。

**流式响应**（`stream: true`）：`Content-Type: text/event-stream`，逐帧透传 OpenAI chunk 格式（`choices[].delta`），流尾 `data: [DONE]`。计量在流结束后从可信 usage 捕获；缺失则进入 uncertain。

**流式错误与中断语义**：
- 流开始前（首帧前）出错 → 返回正常 JSON 错误响应（错误码表格式）。
- 流开始后上游/网关出错 → 发送 OpenAI 风格错误 chunk：`data: {"error": {"message", "type", "code"}}` 后结束（不再发 `[DONE]`；客户端以 error chunk 为准）。
- 客户端中途断开 → 网关内部主动断开上游连接（停止生成、节省成本）；有可信 usage 才精确结算，否则冻结预扣进入 uncertain，禁止估算扣费。
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

### 2.4 GET /livez、GET /readyz — 存活与就绪探针（无鉴权）

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
| 503 | server_draining | 网关滚动发布停机窗口（拒新请求；在途请求在宽限期结束前由服务端中止，全额释放不计费） |
| 408 | request_cancelled | 请求中止（重试预算耗尽 / TTFB 期取消；用户侧取消按已透传内容估算结算，见 requirements 5.11） |

---

## 4. 管理端接口（控制台后端 REST，前缀 `/api`）

> 调用方：Next.js 控制台（服务端调用，不直接暴露公网）。会话鉴权：HttpOnly Cookie 中的面板 JWT（24h），管理端接口校验 `role=admin`。

### 列表接口统一约定（R10，api-contract §4）

所有「记录列表」接口（admin-api 与 client-api）统一三件套：

| 参数 | 说明 |
|---|---|
| `?page=&page_size=` | 分页（page 从 1 起，**page_size 上限 100**），响应统一 `{list, total, page, page_size}` |
| `?q=` | 文本搜索（1~100 字符，ilike 模糊；`%`/`_`/`\` 按字面匹配；按接口白名单列生效，无文本列的列表不提供） |
| `?sort_by=&order=asc\|desc` | 排序（字段白名单，白名单外 **400 INVALID_SORT_FIELD**）；不传时默认时间倒序（`created_at desc`，无该列的表为 `id desc`），多主排序附加 `id desc` 保证分页稳定 |

实现组件：后端 `@ai-gateway/http` 的 `paginationQuerySchema` + `searchQuerySchema`/`searchCondition` + `sortQuerySchema`/`resolveOrderBy`；前端 `@ai-gateway/ui` 的 `DataTable`（排序表头）+ `ListPage`（搜索/筛选/分页骨架）+ `@ai-gateway/api-client/list`（`fetchAdminList`/`fetchUserList`）。
分组统计类接口（`stats/usage`、`usage/summary`、`usage/by-model`、`tracing/topology`）与外部目录（`model-catalog`）不是记录列表，不适用本约定。
时间范围统一 `?from=&to=`（UTC）。

### 4.1 会话与用户（普通用户 + 管理员共用）

| 方法/路径 | 说明 |
|---|---|
| `GET /api/me` | 当前用户信息（含余额、订阅摘要、状态） |
| `POST /api/auth/login` | 登录第一步：邮箱+密码 → 发 6 位邮箱验证码（强制两步）→ `200 {ok,twoFactorRequired:true,challengeId}`（不签会话；SMTP 未配置 → 503 fail-closed；60s 限发/账号） |
| `POST /api/auth/login/verify` `{challengeId, code}` | 第二步：验 6 位邮箱码（5 分钟有效，错 5 次作废，一次性消费）→ 签发 ag_session；首登赠额/lastLogin 在此步 |
| `POST /api/auth/register` `{email, password}` | 邮箱自助注册第一步 → 发验证码 → `200 {ok,challengeId}`（邮箱占用 409；同 IP >5 次/小时 429；SMTP 未配置 503） |
| `POST /api/auth/register/verify` `{challengeId, code}` | 第二步：验码通过建号（subject=email）+ 签发 ag_session + 首登赠额（并发撞邮箱由唯一索引兜底 → 409） |
| `GET /api/auth/oauth/providers` | 已配置的第三方登录方式 `{providers:[github?,google?]}`（前端显隐按钮的单一真相） |
| `GET /api/auth/oauth/:provider/authorize?next=` | 302 到 GitHub/Google 授权页（state 双提交：HttpOnly cookie + Redis 单次 10 分钟；未配置 404） |
| `PATCH /api/me/display-name` `{displayName}` | 自助修改显示名称（1-32 字符去空白；审计 user.display_name_change） |
| `GET /api/auth/oauth/:provider/callback?code&state` | 验 state（不符 403）→ 换码取 profile → find-or-create（issuer=provider, subject=平台 id；邮箱不与本地账号合并）→ ag_session → 302 前端（next 仅站内） |
| `POST /api/auth/oidc-login` `{id_token}` | OIDC 建会话（P1）：**OIDC 重定向流程由 Next.js 服务端执行**（code 换 token、校验 IdP 签名），再调本接口由 admin-api 建立会话——admin-api 不直接对接 IdP |
| `POST /api/auth/logout` | 注销 |

### 管理员二次登录（R8，默认关闭）

| 接口 | 说明 |
|---|---|
| `POST /api/admin/auth/login`（开启 2FA 时） | 密码正确 → `200 {twoFactorRequired:true, challengeId}`（不签会话；SMTP 未配置 → 503 fail-closed；60s 限发） |
| `POST /api/admin/auth/login/verify` `{challengeId, code}` | 验 6 位邮箱码（5 分钟有效，错 5 次作废）→ 签发 ag_admin_session |
| `POST /api/admin/auth/two-factor` `{enabled}` | 自助开关（需管理员会话；开启要求 SMTP 已配置） |

### 用量列表计费来源拆分（R9）

`GET /api/usage` 行新增 `billedBy`（`plan` | `payg`）、`planAmount`、`paygAmount`——
前端区分展示：套餐消耗显示积分（planAmount），余额消耗显示金额（paygAmount，¥）。

### org 邀请撤销（R7）

| 接口 | 说明 |
|---|---|
| `POST /api/orgs/:id/invitations/:invitationId/revoke` | owner 撤销待接受邀请（0→2 revoked；幂等 404） |
| `GET /api/orgs/:id` 变更 | owner 附带 `invitations[]`（pending 列表，不含 token） |
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
| `GET/POST/PATCH /api/admin/plans` | 套餐 CRUD（价格、周期、金额额度、席位模式、状态）；kind 创建后不可变 |
| `GET /api/admin/tracing/recent` | 最近 traces（24h；service/errorsOnly/minDurationMs/requestId/limit/beforeMs 过滤） |
| `GET /api/admin/tracing/traces/:traceId` | 单 trace 全部 span（瀑布图数据） |
| `GET /api/admin/tracing/by-request/:requestId` | 按 request_id 关联（计费复核「查链路」入口） |
| `GET /api/admin/tracing/stats` | trace 存储统计（分区列表、保留水位） |
| `GET /api/admin/tracing/topology?hours=24` | 渠道健康拓扑（尝试/错误/均延迟/最近错误聚合） |
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
