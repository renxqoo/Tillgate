# 全接口清单（第四轮逐接口审计基线，2026-08-15）

> 来源：代码路由定义（非文档）。鉴权列：`pub`=无认证，`key`=网关 Key/JWT，
> `sess`=用户会话 cookie，`admin`=管理员会话 cookie。逐接口实测见脚本 23-25。

## 一、gateway `:8787`

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/livez` / `/readyz` | pub | 存活/就绪 |
| POST | `/oauth/token` | pub | client_credentials 换 JWT（form/json/Basic） |
| GET | `/v1/models` | key | 模型列表（authMiddleware） |
| POST | `/v1/chat/completions` | key | 对话补全（流式/非流式） |
| POST | `/v1/embeddings` | key | 向量 |
| GET | `/debug/traces` | pub(?) | 调试端点（dev 挂载，需核） |

## 二、admin-api `:8790`（前缀 `/api/admin`；`auth` 公开，其余过 adminAuthMiddleware + CSRF）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/auth/login`（两步：2FA 开启时返回 challenge）、`/auth/login/verify`（R8 邮箱验证码）、`/auth/logout` `password`；`/two-factor`（R8 开关，admin） | pub/admin | 管理员认证（公开组同样过 CSRF，R7） |
| GET | `/auth` `/me` | admin | 当前管理员 |
| GET | `/users`、`/users/:id` | admin | 列表/详情 |
| PATCH | `/users/:id` | admin | 改用户（余额/状态/限额/企业标志…） |
| POST | `/users/:id/adjust` `/gift` `/set-password` | admin | 调账/赠送/重置密码 |
| GET | `/users/:id/audit-logs` `/transactions` | admin | 用户审计/流水 |
| GET/PATCH | `/keys`、`/keys/:id` | admin | Key 列表/启停（无创建/删除——用户自建） |
| GET/POST/PATCH/DELETE | `/providers(/:id)` | admin | 厂商 CRUD |
| GET/POST/PATCH/DELETE | `/channels(/:id)`、`POST /channels/:id/test`、`POST /channels/import` | admin | 渠道 CRUD/测试/导入 |
| GET | `/channel-funds`；POST `/channel-funds/recharge` `/adjust` | admin | 渠道资金 |
| GET | `/vouchers/:key` | admin | 凭证截图读取（VoucherStorage 白名单） |
| GET/POST/PATCH/DELETE | `/models(/:id)`、`POST /models/:id/test`、`POST /models/:id/channels` | admin | 模型映射 CRUD/测试/绑渠道 |
| GET | `/model-catalog/sources` `/:sourceId`；POST `/model-catalog/import` | admin | 目录源/导入 |
| GET/POST/PATCH/DELETE | `/rate-cards(/:id)`、GET `/:id/health` `/:id/users` | admin | 计费卡 |
| GET/POST/PATCH/DELETE | `/plans(/:id)`、`POST /plans/:id/grant` | admin | 套餐 CRUD/直发 |
| GET | `/subscriptions`；POST `/:id/cancel` `/change` `/renew` | admin | 订阅管理 |
| GET | `/redeem-batches` `/:id` `/:id/codes`；POST `/`、`/codes/:codeId/revoke` | admin | 兑换码批次 |
| GET | `/stats/overview` `/stats/usage` | admin | 看板 |
| GET | `/logs`、`/audit-logs` | admin | 请求日志/审计日志 |
| GET | `/billing-operations`（R10 起标准分页 envelope，status 必填）；POST `/:requestId/retry` `/resolve` `/abandon` | admin | 账单处置 |
| GET | `/tracing/recent`（R10 起标准分页 envelope）`/by-request/:requestId` `/traces/:traceId` `/stats` `/topology` | admin | 链路 |
| GET | `/healthz` | pub | 存活 |

> **R10 列表统一**：上表所有 GET 记录列表（users(+detail 两子列表)/keys/providers/channels/models/rate-cards(+/:id/users)/plans/subscriptions/channel-funds/redeem-batches(+codes)/logs/audit-logs/billing-operations/tracing recent）统一 `?page=&page_size=&q=&sort_by=&order=`，响应 `{list,total,page,page_size}`；sort_by 白名单外 400 INVALID_SORT_FIELD。

## 三、client-api `:8791`（前缀 `/api`；`auth/login` 公开，其余过 userAuthMiddleware）

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/auth/login` | pub（限流+CSRF） | 登录（公开组同样过 Origin/内部令牌校验，R7） |
| POST | `/auth/logout` `/auth/password` | sess | 登出/改密（改密吊销会话） |
| GET | `/auth/session` | sess | 会话信息 |
| GET | `/me` `/me/subscription` `/me/transactions` | sess | 个人信息/订阅/流水 |
| GET/POST | `/keys`；PATCH/DELETE `/keys/:id`；POST `/keys/:id/rotate` | sess | API Key 全生命周期 |
| GET/POST | `/apps`；POST `/apps/:id/rotate-secret`；DELETE `/apps/:id` | sess | OAuth App |
| GET | `/usage` `/by-model` `/summary` `/rate` | sess | 用量 |
| POST | `/redeem`；GET `/redeem/history` | sess | 兑换码 |
| GET | `/plans` | sess | 套餐列表 |
| POST | `/subscriptions`；POST `/:id/change` `/:id/renew` | sess | 购买/升降档/续费 |
| GET | `/orgs` `/orgs/:id`（owner 附 pending 邀请列表）；POST `/orgs/:id/invitations`、`/orgs/:id/invitations/:invitationId/revoke`（R7）、`/orgs/invitations/accept`；PATCH/DELETE `/orgs/:id/members/:userId` | sess | 组织/成员/邀请（邀请上限 min(剩余席位×2,20)） |

> **R10 列表统一**：`/keys`（q 搜索本轮真正生效——此前后端不接收）、`/apps`、`/usage`、`/me/transactions`、`/redeem/history`、`/plans`、`/orgs` 统一 `?page=&page_size=&q=&sort_by=&order=` + `{list,total,page,page_size}`。

## 四、trace-receiver `:8793` / worker `:8792`

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| POST | `/v1/traces` | pub(?) | OTLP 上报（需核认证） |
| GET | `/readyz`、`/internal/stats` | pub | 内部 |

> 审计重点（本轮逐接口过）：横向越权（资源归属链）、鉴权面覆盖、输入校验完整性
> （400/404/409 vs 500）、幂等/竞态、金额边界、状态机非法迁移、信息泄漏。

## 五、轮次补充说明

- R6 起 gateway/网关三面 IP 提取统一 `TRUSTED_PROXY_HOPS` 语义（右数第 N 跳）。
- R7 起用户面/管理面「公开认证组」也挂 csrfProtection（受信 Origin / INTERNAL_API_TOKEN）。
- R8 管理员邮箱验证码二次登录：`POST /api/admin/auth/login/verify`、`POST /api/admin/auth/two-factor`。
