# 配置手册

> **配置分层**：只有「不配置就无法启动」的基础设施与密钥是必填（见 `.env.example`）；
> 其余全部配置项在代码中带**最优默认值**（`config.ts` 是唯一声明处），按需用同名环境变量覆盖。
> 本手册列出全部键：默认值、语义与调优建议。与代码冲突时以代码为准。

## 配置形态

- **单 `.env` 多服务**：本地 `bun dev` 与 compose 部署共用一份 `.env`；服务专属键带前缀
  （`GATEWAY_` / `CLIENT_` / `ADMIN_` / `WORKER_` / `TRACE_`），共享键裸名。
- **compose 覆盖**：`docker/compose.yml` 的 `environment` 段覆盖 `.env`
  （如 gateway 容器端口 8083、数据库/Redis 连接串由 compose 注入）。
- 全部配置仅启动时读取，改值需重启对应服务。

---

## 一、必填键（不配置 = 拒绝启动）

| 键 | 说明 |
|---|---|
| `NODE_ENV` | `development` / `production`——生产触发密钥强度、Secure Cookie、SSRF 等强制校验 |
| `DATABASE_URL` | PostgreSQL 连接串（compose 部署由 compose 注入） |
| `REDIS_URL` | Redis 连接串（密码形态 `redis://:pass@host:6379`） |
| `JWT_SECRET` | ≥32 随机；用户面会话 + 网关 App JWT 共用签发密钥 |
| `ADMIN_JWT_SECRET` | ≥32 随机；管理面独立密钥（不得与 JWT_SECRET 相同） |
| `ENCRYPTION_KEY` | ≥32 随机；渠道上游 Key / webhook secret 落库 AES 加密；轮换走双 key 窗（deployment-checklist） |

弱值黑名单（`change-me` / `secret` / `password` 等）与字符多样性校验在启动时强制执行。

---

## 二、共享可选键（全服务）

| 键 | 默认 | 说明 |
|---|---|---|
| `LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error`/`fatal` |
| `DB_POOL_MAX` | `10` | 每服务 DB 连接池上限（五个服务各持一池，按库容量调） |
| `TRUSTED_PROXY_HOPS` | `0` | 来源 IP 提取：0 = 不信 XFF；**nginx/LB 后置 `1`**（右数第 1 跳 = 真实客户端）。不配对会让限流/爆破锁按代理 IP 计数 |
| `KEY_PREFIX` | `ag_` | 虚拟 Key 前缀（client-api 生成端与 gateway 识别端共用；字母开头 2-16 位 `[a-z0-9_-]`，如 `sk-`）。**仅限首次部署设定，运行中改值 = 存量 Key 全部失效** |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `ai-gateway` / `ai-gateway-api` | App JWT 签发/验签主体（多套部署实例隔离用）。**运行中改值 = 在途 JWT 立即失效** |
| `OTEL_TRACES_MODE` | `off` | `otlp` 接观测栈（须配 `OTEL_EXPORTER_OTLP_ENDPOINT`；compose `--profile obs`） |
| `CLIENT_API_BASE` | `http://localhost:8081` | 用户面板（client）→ client-api 基地址；本地直跑用默认即可，compose 部署由容器注入网络地址 |
| `ADMIN_API_BASE` | `http://localhost:8082` | 管理后台（admin）→ admin-api 基地址；同上 |

## 三、网关（gateway）

| 键 | 默认 | 说明 |
|---|---|---|
| `GATEWAY_PORT` | `8080` | 监听端口（compose 容器形态覆盖为 8083） |
| `GATEWAY_CURRENCY` | `CNY` | 计费币种 |
| `GLOBAL_RPM` | `2000` | 全站每分钟请求闸（生产硬顶 5000，超配自动钳回） |
| `AUTH_KEY_FAILURE_THRESHOLD` / `WINDOW_S` / `LOCK_S` | 5 / 600 / 600 | 同 Key 失败 5 次（10 分钟窗）锁 10 分钟 |
| `AUTH_IP_FAILURE_LIMIT` / `WINDOW_S` | 30 / 300 | 同 IP 失败 30 次即锁 |
| `BILLING_RESERVATION_MAX` | `1000` | 单请求预扣上限（元，只拒绝不截断） |
| `BILLING_RESERVATION_MODE` | `full` | `fixed` 需同时配 `BILLING_FIXED_RESERVATION_AMOUNT` 且不超 MAX |
| `BILLING_AUTHORIZATION_TTL_MS` | `300000` | 预扣租约（流式按 1/3 TTL 续租） |
| `DEFAULT_MAX_OUTPUT_TOKENS` | `4096` | 请求未传 `max_tokens` 的缺省 |
| `GATEWAY_OUTPUT_EXPOSURE_CAP` | `32768` | 单请求输出 token 总封顶 |
| `ADMISSION_MAX_PENDING` / `ADMISSION_MAX_OLDEST_MS` | `10000` / `300000` | 结算积压背压（保护资金域） |
| `GATEWAY_UPSTREAM_DEADLINE_MS` | `120000` | 上游调用总预算（重试/熔断共享 deadline） |
| `GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS` | `10000` | 连接 + 首字节（TTFB）；慢上游长生成需放宽 |
| `GATEWAY_BODY_LIMIT_BYTES` | `10485760` | 请求体上限（字节，按实际流量计数防 chunked 谎报，413） |
| `GATEWAY_UPLOAD_MAX_FILE_BYTES` | `16777216` | multipart 单文件上限（与 bodyLimit 取小生效） |
| `GATEWAY_UPLOAD_IMAGE_MIME` / `GATEWAY_UPLOAD_AUDIO_MIME` | 见 config.ts | multipart 文件类型白名单（逗号分隔） |
| `SIGNAL_FINALIZE_ATTEMPTS` / `SIGNAL_FINALIZE_BASE_DELAY_MS` | `5` / `500` | 终态落账退避重试（DB 抖动不漏收已交付请求） |
| `GENERATION_TASK_TTL_MS` / `GENERATION_LEASE_GRACE_MS` | `3600000` / `30000` | 异步任务超时上界 / 轮询租约安全垫 |
| `JWT_TOKEN_TTL_SECONDS` | `3600` | `/oauth/token` 签发 JWT 有效期 |
| `GATEWAY_SHUTDOWN_GRACE_MS` | `60000` | 优雅停机在途等待（覆盖流式长尾） |
| `GATEWAY_AI_ALLOW_LOCAL_URL` | `false` | SSRF 逃生门（允许上游寻址私网）；**生产恒 false** |

## 四、用户面（client-api）

| 键 | 默认 | 说明 |
|---|---|---|
| `CLIENT_API_PORT` | `8081` | 监听端口 |
| `CLIENT_CURRENCY` | `CNY` | 展示币种 |
| `CLIENT_BODY_LIMIT_BYTES` | `8388608` | 请求体上限 |
| `SESSION_TTL_SECONDS` | `86400` | 会话有效期 |
| `REGISTER_ENABLED` | `true` | 公开注册开关 |
| `REGISTER_IP_LIMIT_PER_HOUR` | `5` | 注册频控 |
| `REDEEM_PER_MINUTE_LIMIT` | `10` | 兑换码频控 |
| `LOGIN_*` 五键 | 5/600/600/50/300 | 登录爆破锁（语义同网关） |
| `CORS_ORIGINS` | 空 | 跨域白名单（逗号分隔；空 = 不放行跨域） |
| `TOPUP_MIN` / `TOPUP_MAX` / `TOPUP_EXCHANGE_RATE` | `1` / `100000` / `1` | 充值边界与汇率 |
| `PAYMENT_ORDER_TTL_MS` | `1800000` | 支付订单有效期 |
| `EMAIL_CODE_REQUIRED` | `auto` | `auto`/`always`/`never` 邮箱验证码策略 |
| `SECURE_COOKIE` | 开发 `false` / **生产 `true`（强制，配置 false 拒绝启动）** | 会话 cookie 安全位 |
| `ALLOW_LOCAL_UPSTREAM` | `false` | SSRF 出口限制 |
| `SMTP_PORT` | `465` | 邮件出站端口 |
| `CLIENT_SHUTDOWN_GRACE_MS` | `10000` | 优雅停机 |

## 五、管理面（admin-api）

`ADMIN_API_PORT`（8082）、`ADMIN_CURRENCY`（CNY）、`ADMIN_BODY_LIMIT_BYTES`（4194304）、
`ADMIN_SHUTDOWN_GRACE_MS`（10000）、`CHANNEL_IMPORT_MAX`（1000，渠道入货上限）、
`CATALOG_FREE_CHANNEL_RPM`（20）/ `CATALOG_FREE_CHANNEL_BUDGET`（1000000，公共目录渠道配额）、
`CATALOG_CACHE_TTL_MS`（600000）、`VOUCHER_MAX_BYTES`（2097152，凭证截图上限）。

## 六、结算 worker

| 键 | 默认 | 说明 |
|---|---|---|
| `WORKER_HEALTH_PORT` / `WORKER_HEALTH_TOKEN` | `8792` / 空 | 健康口端口与令牌（生产建议设） |
| `WORKER_CURRENCY` | `CNY` | 计价币种 |
| 循环节拍 | 见 config.ts | `WORKER_SETTLE_INTERVAL_MS`（30s）/ `RECOVER`（15s）/ `GENERATION`（5s）/ `NOTIFY`（15s）/ `REFERRAL`（1h 日结）/ `RECONCILE`（1h 对账）/ `PARTITION`（1h 分区维护） |
| 批量/租约 | 见 config.ts | `WORKER_BATCH_SIZE`（20）/ `CLAIM_LEASE_MS`（60s）/ `RECOVERY_BATCH_SIZE`（50）/ `GENERATION_BATCH_SIZE`·`LEASE_MS` / `NOTIFY_CLAIM_LEASE_MS` |
| 重试策略 | 见 config.ts | `WORKER_MAX_ATTEMPTS`（10）/ `BASE_DELAY_MS`（15s）/ `MAX_DELAY_MS`（600s） |
| 数据保留 | `7` / `90` | `TRACE_RETENTION_DAYS` / `REQUEST_LOG_RETENTION_DAYS` |
| 开关 | `true` | `WORKER_SETTLE_WAKEUP`（PG LISTEN/NOTIFY 唤醒）/ `WORKER_NOTIFY_ENABLED`（告警投递） |
| SSRF | `false` | `WORKER_AI_ALLOW_LOCAL_URL` / `WORKER_WEBHOOK_ALLOW_LOCAL_URL`（生产恒 false） |
| 其它 | — | `WORKER_BALANCE_LOW_THRESHOLD`（5，低余额告警线）、`WORKER_GENERATION_EXPIRE_REASON`、`WORKER_SHUTDOWN_GRACE_MS`（15s）、`SMTP_PORT`（465） |

> 唯一进程计算默认：`WORKER_OWNER_ID`（`worker-<pid>`，多实例认领身份自动唯一——手写固定值反而撞名）。

## 七、链路接收（trace-receiver）

`TRACE_RECEIVER_PORT`（8793）、`TRACE_BATCH_MAX`（500，批量写库行数）、
`TRACE_FLUSH_INTERVAL_MS`（2000）、`TRACE_QUEUE_MAX`（10000，过载丢弃阈值——超限即丢绝不反压业务）。

---

## 可选功能组（不启用则整组不配）

| 组 | 键 | 说明 |
|---|---|---|
| 邮箱验证码 | `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` | 成组配置即启用；**配置不完整拒绝启动**；未配置时验证码功能 503（不降级为单密码） |
| EPAY 充值 | `EPAY_PID` / `EPAY_KEY` / `EPAY_GATEWAY_URL` / `EPAY_NOTIFY_URL` / `EPAY_RETURN_URL` | 五键成组；部分配置 = 启动失败 |
| Stripe 充值 | `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_SUCCESS_URL` / `STRIPE_CANCEL_URL` | 四键成组 |
| 第三方登录 | `OAUTH_FRONTEND_URL` / `OAUTH_API_BASE` / `OAUTH_GITHUB_*` / `OAUTH_GOOGLE_*` | 配置后前端按钮显隐自动跟随 |
| 上游白名单 | `UPSTREAM_HOST_ALLOWLIST` | 逗号分隔域名；接默认六家之外的供应商（dashscope/moonshot 等）必须追加，否则被 SSRF 防护拦截 |
| 链路鉴权 | `TRACE_RECEIVER_TOKEN` | 接收端与推送端共用（同一 `.env` 键自动对齐）：接收端生产无此值拒绝启动；gateway/worker/admin/client-api 推 OTLP 时自动带 `Authorization: Bearer <token>`。生成：`openssl rand -hex 24` |
| Redis HA | `REDIS_SENTINELS` / `REDIS_SENTINEL_NAME` / `REDIS_SENTINEL_PASSWORD` | Sentinel 拓扑（见 ha-deployment.md） |
