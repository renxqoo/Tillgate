# 配置手册

> 本文档自 v1（ai-getway）同名文档适配至 v2 结构；配置键与部署拓扑以代码与 docker/ 目录为准。

> **配置分层**：只有「不配置就无法启动」的基础设施与密钥是必填（见根目录 `.env.example`）；
> 其余全部配置项在代码中带**最优默认值**（各 app 的 `src/config.ts` zod schema 是唯一声明处），
> 按需用同名环境变量覆盖。本手册列出全部键：默认值、语义与调优建议。与代码冲突时以代码为准。

## 配置形态

- **单 `.env` 多服务**：本地 `bun dev` 与 compose 部署共用一份 `.env`（仓库根）；服务专属键带前缀
  （`GATEWAY_` / `CLIENT_` / `ADMIN_` / `WORKER_` / `TRACE_`），共享键裸名。
- **compose 覆盖**：`docker/compose.yml` 各服务的 `environment` 段覆盖 `.env`
  （`DATABASE_URL` / `REDIS_URL` 由 compose 用 `POSTGRES_*` / `REDIS_PASSWORD` 拼装注入；
  `TRUSTED_PROXY_HOPS=1`；`OTEL_TRACES_MODE` 强制 `'off'`——启用链路需同步改 compose 或去掉该覆盖）。
- **server 形态注意**：`.env` 在仓库根而 compose 文件在 `docker/` 下，`docker/compose.server.yml`
  部署的所有 compose 命令都要带 `--env-file .env`（否则插值读不到）。
- 全部配置仅启动时读取，改值需重启对应服务。

v1→v2 键名差异速查见文末「v1 → v2 键名与语义变化」。

---

## 一、必填键（不配置 = 拒绝启动）

| 键 | 说明 |
|---|---|
| `NODE_ENV` | `development` / `test` / `production`——生产触发密钥强度、Secure Cookie、SSRF 强制校验（`Dockerfile.server` 内置 `production`） |
| `DATABASE_URL` | PostgreSQL 连接串（五个服务全消费；compose 部署由 compose 注入） |
| `REDIS_URL` | Redis 连接串（密码形态 `redis://:pass@host:6379`）。gateway / client-api / admin-api 必填；**worker 与 trace-receiver 不消费**（v2 变化：worker 的 Redis 依赖全退出，唤醒走 PG LISTEN/NOTIFY） |
| `JWT_SECRET` | 用户面会话 + 网关 App JWT 签发密钥；≥32 随机（开发 16） |
| `ADMIN_JWT_SECRET` | 管理面独立密钥（admin-api）；恒 ≥32。与 `JWT_SECRET` 仍应配不同随机值（v2 变化：不再启动时强校验「不相同」——identity realm 隔离使跨面 token 本就互不认账，见 `packages/identity/src/adapters/jwt/jose-tokens.ts`） |
| `ENCRYPTION_KEY` | ≥32 随机；运行时对称加密根密钥（AES-256-GCM `enc:v1`）。admin-api（渠道 Key 落库加密）与 client-api（密码信封）**必填**；gateway 未配 `CHANNEL_API_KEY_ENCRYPTION` 时回退用它 |
| `CHANNEL_API_KEY_ENCRYPTION` | ≥32 随机；渠道上游 Key 加密专用键。**worker 必配此键（无回退——只配 `ENCRYPTION_KEY` 时 worker 拒绝启动，以 `apps/worker/src/config.ts` schema 实测为准）**；gateway 优先用它、缺省回退 `ENCRYPTION_KEY` |
| `IDENTITY_CODE_PEPPER` | ≥16 随机（生产建议 ≥32）；管理面挑战/恢复码 HMAC pepper（admin-api 装配必填） |
| `CLIENT_CODE_PEPPER` | ≥16 随机（生产 32）；client-api 用户面验证码 HMAC pepper（与管理面 pepper 分离） |

密钥三道门（`packages/runtime/src/config/env-schemas.ts` 的 `secretSchema`）：长度下限、
已知弱值黑名单（`change-me` / `secret` / `password` 等）、≥4 种不同字符——启动时强制执行。

## 二、共享可选键（多服务消费）

| 键 | 默认 | 说明 |
|---|---|---|
| `LOG_LEVEL` | `info` | `trace`/`debug`/`info`/`warn`/`error`/`fatal`；client-api / admin-api / worker / trace-receiver 消费（**v2 变化：gateway 当前不读该键**） |
| `DB_POOL_MAX` | `10` | gateway / client-api / admin-api 的 PG 连接池上限。worker（20）与 trace-receiver（10）为部署定值不吃该键（v2 变化） |
| `TRUSTED_PROXY_HOPS` | `0` | 来源 IP 提取：0 = 不信 XFF；**nginx/LB 后置 `1`**（右数第 1 跳 = 真实客户端）。compose 已给各服务注入 `1`；前端 BFF 也消费（透传用户 IP 给 API）。不配对会让限流/爆破锁按代理 IP 计数 |
| `SESSION_TTL_SECONDS` | `86400` | 会话有效期（60 ~ 2592000）；client-api 与 admin-api 同键共用，前端 BFF 的会话 cookie 寿命也读它 |
| `KEY_PREFIX` | `sk_` | 虚拟 Key 前缀（client-api/admin-api 生成端与 gateway 识别端共用；字母开头 2-16 位 `[a-z0-9_-]`）。**仅限首次部署设定，运行中改值 = 存量 Key 全部失效** |
| `JWT_ISSUER` / `JWT_AUDIENCE` | `ai-gateway` / `ai-gateway-api` | 网关 App JWT 签发/验签主体（多套部署实例隔离用）。**运行中改值 = 在途 JWT 立即失效**（gateway 键） |
| `CORS_ORIGINS` | 空 | 跨域白名单（逗号分隔；空 = 不放行跨域）；client-api 与 admin-api 消费。网关另有独立键 `GATEWAY_CORS_ORIGINS` |
| `OTEL_TRACES_MODE` | `off` | `off`/`otlp`（gateway、client-api）；admin-api / worker / trace-receiver 另支持 `memory`/`console`，缺省开发 `memory`、生产 `off`（worker 恒 `off`，除非显式配）。`otlp` 必配 `OTEL_EXPORTER_OTLP_ENDPOINT`。compose 各服务的 `environment` 把它固定为 `'off'`——启用链路需同步改 compose |
| `TRACE_RECEIVER_TOKEN` | 空 | 链路鉴权（见「可选功能组」） |
| `OTEL_METRICS_INTERVAL_MS` | gateway/admin/worker/trace `10000`；client-api `60000` | OTLP 指标推送周期（otlp 模式生效） |
| `OTEL_SERVICE_VERSION` | `0.1.0` | OTel 资源版本（admin-api / worker / trace-receiver） |
| `SMTP_PORT` | `465` | 邮件出站端口（三处 SMTP 消费方同键） |

## 三、网关（gateway）——`apps/gateway/src/config.ts`

| 键 | 默认 | 说明 |
|---|---|---|
| `GATEWAY_PORT` | `8080` | 监听端口（v2 变化：compose 容器也固定 8080，v1 的 8083 覆盖已取消；nginx upstream 即 `gateway:8080`） |
| `GATEWAY_CURRENCY` | `CNY` | 计费币种（3 字母） |
| `GLOBAL_RPM` | `2000` | 全站每分钟请求闸（0 = 不限；生产硬顶 5000，超配钳回并打告警日志） |
| `AUTH_KEY_FAILURE_THRESHOLD` / `_WINDOW_S` / `_LOCK_S` | 5 / 600 / 600 | 同 Key 失败 5 次（10 分钟窗）锁 10 分钟 |
| `AUTH_IP_FAILURE_LIMIT` / `_WINDOW_S` | 30 / 300 | 同 IP 失败 30 次即锁 |
| `BILLING_RESERVATION_MAX` | `1000` | 单请求预扣上限（元；正金额十进制串，20 位整数 + 18 位小数；只拒绝不截断） |
| `BILLING_RESERVATION_MODE` | `full` | `fixed` 需同时配 `BILLING_FIXED_RESERVATION_AMOUNT`（正金额串）且不超 MAX |
| `BILLING_AUTHORIZATION_TTL_MS` | `300000` | 预扣租约（流式按 1/3 TTL 续租） |
| `DEFAULT_MAX_OUTPUT_TOKENS` | `4096` | 请求未传 `max_tokens` 的缺省 |
| `GATEWAY_OUTPUT_EXPOSURE_CAP` | `32768` | 单请求输出 token 总封顶 |
| `ADMISSION_MAX_PENDING` / `ADMISSION_MAX_OLDEST_MS` | `10000` / `300000` | 结算积压背压（保护资金域） |
| `GATEWAY_UPSTREAM_DEADLINE_MS` | `120000` | 上游调用总预算（重试/熔断共享 deadline） |
| `GATEWAY_UPSTREAM_CONNECT_TIMEOUT_MS` | `10000` | 连接 + 首字节（TTFB）；慢上游长生成需放宽 |
| `GATEWAY_UPSTREAM_ALLOWED_HOSTS` | 空 | 上游受信 provider 主机名白名单（逗号分隔）；**生产必填——缺失启动即拒**。命中白名单后仍逐地址拒绝 DNS 私网解析（防 rebinding）；渠道新增 provider 域名需同步扩充 |
| `GATEWAY_BODY_LIMIT_BYTES` | `10MB` | 请求体上限（v2 变化：字节量串 `10MB`/`512kb` 形，不再是不带单位的数字；按实际流量计数防 chunked 谎报，413） |
| `GATEWAY_UPLOAD_MAX_FILE_BYTES` | `16MB` | multipart 单文件上限（同上字节量串；与 bodyLimit 取小生效） |
| `GATEWAY_UPLOAD_IMAGE_MIME` | `image/png,image/jpeg,image/webp` | multipart 图片类型白名单（逗号分隔） |
| `GATEWAY_UPLOAD_AUDIO_MIME` | `audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/webm,audio/mp4,audio/x-m4a,audio/m4a` | 音频类型白名单 |
| `SIGNAL_FINALIZE_ATTEMPTS` / `SIGNAL_FINALIZE_BASE_DELAY_MS` | `5` / `500` | 终态落账退避重试（DB 抖动不漏收已交付请求） |
| `GENERATION_TASK_TTL_MS` / `GENERATION_LEASE_GRACE_MS` | `3600000` / `30000` | 异步任务超时上界 / 轮询租约安全垫 |
| `JWT_TOKEN_TTL_SECONDS` | `3600` | `/oauth/token` 签发 JWT 有效期（下限 60） |
| `GATEWAY_SHUTDOWN_GRACE_MS` | `60000` | 优雅停机在途等待（覆盖流式长尾；compose `stop_grace_period 30s`） |
| `GATEWAY_AI_ALLOW_LOCAL_URL` | `false` | SSRF 逃生门（允许上游寻址私网）；**生产恒关——即使误配 `true` 也被装配层强制关闭** |
| `GATEWAY_CORS_ORIGINS` | 空 | 网关面跨域白名单（逗号分隔；空 = 不放行） |

**废弃键告警**（配置了只打告警并忽略，用户级限流无兜底默认）：
`DEFAULT_USER_RPM` / `DEFAULT_USER_TPM` / `FREE_MODEL_DAILY_LIMIT` / `GENERATION_MAX_ACTIVE_PER_USER`。

## 四、用户面（client-api）——`apps/client-api/src/config.ts`

| 键 | 默认 | 说明 |
|---|---|---|
| `CLIENT_API_PORT` | `8081` | 监听端口 |
| `CLIENT_CURRENCY` | `CNY` | 展示币种 |
| `CLIENT_DB_IDLE_TIMEOUT_MS` / `CLIENT_DB_CONNECT_TIMEOUT_MS` / `CLIENT_DB_MAX_USES` | `30000` / `5000` / `1000` | PG 池调优（v2 新增） |
| `CLIENT_BODY_LIMIT_BYTES` | `8388608` | 请求体上限（字节，纯数字） |
| `CLIENT_CHALLENGE_TTL_MS` / `CLIENT_CHALLENGE_COOLDOWN_MS` / `CLIENT_CHALLENGE_MAX_ATTEMPTS` | `600000` / `60000` / `5` | 邮箱验证码挑战：有效期 / 发送冷却 / 最大尝试（v2 新增） |
| `CLIENT_PASSWORD_MIN_LENGTH` | `10` | 密码下界（上界 128 固定） |
| `CLIENT_TOTP_ISSUER` | `Tillgate` | TOTP 发行方（MFA 预留） |
| `REGISTER_ENABLED` | `true` | 公开注册开关（关闭后 `POST /api/auth/register*` 一律 403，只留 OAuth 建号） |
| `REGISTER_IP_WINDOW_SECONDS` / `REGISTER_IP_LIMIT_PER_HOUR` | `3600` / `5` | 注册频控（窗口即 Retry-After 口径） |
| `REDEEM_PER_MINUTE_LIMIT` | `10` | 兑换码频控（防暴力猜码） |
| `CLIENT_TOPUP_ORDERS_PER_MINUTE` | `10` | 充值下单频控（v2 新增） |
| `LOGIN_FAILURE_THRESHOLD` / `_WINDOW_S` / `_LOCK_S` / `LOGIN_IP_FAILURE_LIMIT` / `LOGIN_IP_FAILURE_WINDOW_S` | 5 / 600 / 600 / 50 / 300 | 登录爆破锁（语义同网关） |
| `TOPUP_MIN` / `TOPUP_MAX` / `TOPUP_EXCHANGE_RATE` | `1` / `100000` / `1` | 充值边界与汇率（正金额十进制串；MIN > MAX 拒绝启动） |
| `PAYMENT_ORDER_TTL_MS` | `1800000` | 未支付订单超时关单 |
| `EMAIL_CODE_REQUIRED` | `auto` | `auto`/`on`/`off` 邮箱验证码策略（v2 变化：v1 值域 `auto/always/never`）。`auto` = SMTP 已配置即强制 |
| `SECURE_COOKIE` | 开发 `false` / **生产 `true`（强制，显式配 `false` 拒绝启动）** | 会话 cookie 安全位 |
| `CLIENT_CORS_MAX_AGE_SECONDS` | `600` | 预检缓存 |
| `CLIENT_INVITATION_TTL_MS` / `CLIENT_INVITATION_PENDING_FACTOR` / `CLIENT_INVITATION_PENDING_CAP` | `604800000` / `2` / `20` | 邀请装配 policy（v2 新增） |
| `CLIENT_RPM_LIMIT_MAX` / `CLIENT_TPM_LIMIT_MAX` | `1000000` / `100000000` | Key 限额上界（v2 新增） |
| `CLIENT_REFERRAL_INVITEE_LIMIT` | `100` | 推荐被邀名单上界（v2 新增） |
| `CLIENT_USAGE_TZ` | `Asia/Shanghai` | 用量日汇总日界时区（IANA 名，白名单字形校验） |
| `PRICING_CACHE_TTL_MS` | `30000` | 公开定价目录共享缓存（redis 多副本一份；v2 新增） |
| `CLIENT_SETTLE_MAX_ATTEMPTS` / `_BASE_DELAY_MS` / `_MAX_DELAY_MS` | `8` / `1000` / `300000` | 结算失败策略（装配形状；worker 兜底同源语义） |
| `CLIENT_TX_MAX_ATTEMPTS` / `_BASE_DELAY_MS` / `_MAX_JITTER_MS` | `5` / `15` / `20` | DB 事务重试 |
| `CLIENT_REDIS_LOG_THROTTLE_MS` / `CLIENT_STARTUP_PROBE_TIMEOUT_MS` | `60000` / `5000` | Redis 告警节流 / 启动连通性探测（**Redis 不可达拒绝启动，fail-closed**） |
| `CLIENT_SHUTDOWN_GRACE_MS` | `10000` | 优雅停机 |

## 五、管理面（admin-api）——`apps/admin-api/src/config.ts`

| 键 | 默认 | 说明 |
|---|---|---|
| `ADMIN_API_PORT` | `8082` | 监听端口 |
| `ADMIN_LOGIN_FAILURE_THRESHOLD` / `_WINDOW_S` / `_LOCK_S` | 5 / 3600 / 900 | 管理面 (email,ip) 爆破锁（v2 变化：键名从 v1 的 `LOGIN_*` 加 `ADMIN_` 前缀；Redis 必配——不可达 fail-closed） |
| `ADMIN_LOGIN_IP_FAILURE_LIMIT` / `_WINDOW_S` | 30 / 3600 | per-IP 鉴权失败锁 |
| `CHANNEL_IMPORT_MAX` | `1000` | 渠道批量导入单次上限 |
| `CATALOG_FREE_CHANNEL_RPM` / `CATALOG_FREE_CHANNEL_BUDGET` | `20` / `1000000` | 目录导入：免费渠道限流/进货额度预填 |
| `CATALOG_CACHE_TTL_MS` | `600000` | 目录源拉取缓存 |
| `OPENROUTER_CATALOG_URL` | `https://openrouter.ai/api/v1/models` | 目录在线源地址（v2 新增，v1 常量升配置） |
| `CATALOG_FETCH_TIMEOUT_MS` | `10000` | 目录拉取超时（v2 新增） |
| `VOUCHER_MAX_BYTES` | `2097152` | 凭证截图上传上限 |
| `ADMIN_WEBHOOK_ALLOW_LOCAL_URL` | `false` | 通知渠道 webhook 本地地址逃生门（与 worker 同语义；生产恒 false） |
| `FX_SOURCE_URL` / `FX_AUTO_TTL_MS` / `FX_FETCH_TIMEOUT_MS` | frankfurter / `14400000` / `10000` | 汇率行拉取源/懒检查 TTL/超时（v2 新增） |
| `SETTLE_MAX_ATTEMPTS` / `_BASE_DELAY_MS` / `_MAX_DELAY_MS` | `5` / `1000` / `60000` | 结算失败策略装配形状（管理面不触发结算） |
| `ADMIN_BODY_LIMIT_BYTES` | `4194304` | 请求体上限（批量导入/凭证内联批次较大） |
| `ADMIN_SHUTDOWN_GRACE_MS` | `10000` | 优雅停机 |

> v2 变化：`ADMIN_CURRENCY` 不再是环境键（部署定值 `CNY`）；`REDIS_URL`/`TRUSTED_PROXY_HOPS`
> 升为管理面必填键（P2 登录波）；新增 `IDENTITY_CODE_PEPPER`、`JWT_SECRET`（identity realms
> 词表一致性，本面不签发用户会话）。

## 六、结算 worker——`apps/worker/src/config.ts`

| 键 | 默认 | 说明 |
|---|---|---|
| `WORKER_HEALTH_PORT` / `WORKER_HEALTH_TOKEN` | `8792` / 空 | 健康口端口（0 = 关闭）与令牌；空令牌 = `/health` 恒 403（`/livez` `/readyz` 不受影响） |
| `WORKER_CURRENCY` | `CNY` | 计价币种 |
| `WORKER_OWNER_ID` | `worker-<pid>` | 认领归属。缺省自动唯一；**多副本部署建议显式命名**（否则重启后 pid 撞名租约语义混乱） |
| 循环节拍 | 见左 | `WORKER_SETTLE_INTERVAL_MS`（30s）/ `WORKER_RECOVER_INTERVAL_MS`（15s）/ `WORKER_GENERATION_INTERVAL_MS`（5s）/ `WORKER_NOTIFY_INTERVAL_MS`（15s）/ `WORKER_REFERRAL_INTERVAL_MS`（1h 日结）/ `WORKER_RECONCILE_INTERVAL_MS`（1h 对账）/ `WORKER_PARTITION_INTERVAL_MS`（1h 分区维护） |
| 批量/租约 | 见左 | `WORKER_BATCH_SIZE`（20）/ `WORKER_CLAIM_LEASE_MS`（60s）/ `WORKER_RECOVERY_BATCH_SIZE`（50）/ `WORKER_GENERATION_BATCH_SIZE`（20）/ `WORKER_GENERATION_LEASE_MS`（30s，须 ≥ 2× 轮询间隔）/ `WORKER_NOTIFY_CLAIM_LEASE_MS`（60s，须覆盖 webhook/SMTP 上界） |
| 重试策略 | 见左 | `WORKER_MAX_ATTEMPTS`（10）× `WORKER_BASE_DELAY_MS`（15s）分钟级退避 ≈ 85 分钟耐受，`WORKER_MAX_DELAY_MS`（600s） |
| 生成任务执行 | 见左 | `WORKER_GENERATION_DEADLINE_MS`（300s，上游代执行预算）/ `WORKER_GENERATION_MAX_RETRIES`（2）——v1 藏在适配器内的常量升为显式键 |
| `WORKER_GENERATION_EXPIRE_REASON` | `任务超时（TTL 到期）` | 任务过期文案 |
| `WORKER_REFERRAL_BACKFILL_DAYS` | `7` | 佣金日结回看窗口（1-62；v1 写死 7） |
| 告警投递 | 见左 | `WORKER_NOTIFY_ENABLED`（true，静音开关）/ `WORKER_NOTIFY_MAX_ATTEMPTS`（3）/ `WORKER_NOTIFY_LOOP_BATCH_LIMIT`（50）/ `WORKER_NOTIFY_WEBHOOK_TIMEOUT_MS`（10s）/ `WORKER_NOTIFY_BACKOFF_BASE_MS`（15s）/ `WORKER_NOTIFY_BACKOFF_CAP_MS`（600s）——投递参数 v1 写死、v2 显式化 |
| 数据保留 | `7` / `90` | `TRACE_RETENTION_DAYS`（trace_spans 日分区）/ `REQUEST_LOG_RETENTION_DAYS`（request_logs 月分区滚动） |
| `WORKER_SETTLE_WAKE` | `true` | PG LISTEN `settle-wake` 低延迟唤醒（生产端 = gateway `pg_notify`；v2 变化：v1 键名 `WORKER_SETTLE_WAKEUP`，且唤醒由 BullMQ 改为 PG NOTIFY） |
| `WORKER_BALANCE_LOW_THRESHOLD` | `5` | balance_low 预警阈值（元） |
| `WORKER_SHUTDOWN_GRACE_MS` | `15000` | 优雅停机 |
| SSRF | `false` | `WORKER_AI_ALLOW_LOCAL_URL` / `WORKER_WEBHOOK_ALLOW_LOCAL_URL`（生产恒 false） |
| `WORKER_UPSTREAM_ALLOWED_HOSTS` | 空 | 生成任务轮询的上游受信主机名白名单（逗号分隔）；**生产必填——缺失启动即拒**（与 gateway `GATEWAY_UPSTREAM_ALLOWED_HOSTS` 同语义） |
| `CHANNEL_API_KEY_ENCRYPTION` | 必填 | ≥32；渠道 Key 解密专用键，**无 ENCRYPTION_KEY 回退** |

> v2 变化：worker 的 `REDIS_URL` 配置项已删除（Redis 全退出——唤醒走 PG NOTIFY、熔断存储用内存实现）。

## 七、链路接收（trace-receiver）——`apps/trace-receiver/src/config.ts`

| 键 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | 必填 | v2 变化：v1 藏默认连接串，v2 db 包零缺省、必配 fail-fast |
| `TRACE_RECEIVER_PORT` | `8793` | 监听端口（内网诊断服务，不对公网） |
| `TRACE_RECEIVER_TOKEN` | 空 | 接收端与推流端共用同键（见「可选功能组」）；生产无此值拒绝启动 |
| `TRACE_BATCH_MAX` | `500` | 批量写库行数 |
| `TRACE_FLUSH_INTERVAL_MS` | `2000` | 落库刷写间隔 |
| `TRACE_QUEUE_MAX` | `10000` | 过载丢弃阈值——超限即丢绝不反压业务 |

## 八、前端 BFF（console-client / console-admin）

Next.js 前端不读业务配置，仅 BFF 装配层（`packages/api-client/src/next/`）消费少量键，
compose 部署由 `environment` 段注入：

| 键 | 默认 | 说明 |
|---|---|---|
| `CLIENT_API_BASE` | `http://localhost:8081` | 用户面板（client）→ client-api 基地址；compose 注入 `http://client-api:8081` |
| `ADMIN_API_BASE` | `http://localhost:8082` | 管理后台（admin）→ admin-api 基地址；compose 注入 `http://admin-api:8082` |
| `TRUSTED_PROXY_HOPS` | `0` | FE 在 nginx 后解入站 XFF，透传真实用户 IP 给 API（compose 注入 `1`） |
| `SESSION_TTL_SECONDS` | `86400` | 会话 cookie 寿命（与后端同键对齐） |
| `NEXT_PUBLIC_DISPLAY_TZ` | `Asia/Shanghai` | 面板展示时区 |
| `DEV_FAKE_ME` | 未设 | 开发期伪造登录身份（生产 NODE_ENV 下无效） |

容器端口：console-client `3001`、console-admin `3002`（各自 Dockerfile 内置，非配置键）。

---

## 可选功能组（不启用则整组不配）

| 组 | 键 | 说明 |
|---|---|---|
| **第三方集成（动态配置）** | `integration_settings` 表 | OAuth（GitHub/Google 含回调基地址）/ SMTP / Turnstile / 易支付 / Stripe 凭据全部迁入 DB 动态配置（设计：[integration-settings/DESIGN.md](integration-settings/DESIGN.md)）：admin 端 `/dashboard/settings` 可视化管理，secret 以 `enc:v1` 密文落库（根密钥与渠道 Key 同一部署契约），写入留同事务审计，改后最迟 60s 全进程生效、无需重启。**例外**：`oauth.base` 为装配期读取（回调白名单契约），变更需重启。存量部署迁移：`bun run integrations:import`（幂等；半配组跳过并警告——对齐原启动期成组校验）。原 env 键已删除，仅保留 `OAUTH_{GITHUB,GOOGLE}_ENDPOINTS_JSON`（e2e/私有化端点覆盖逃生门）与 `OAUTH_STATE_TTL_SECONDS`（默认 600）。支付验签密钥轮换自带 96h 双读窗（旧密钥回调不丢）；渠道停用不停验签（在途订单归账不中断） |
| 链路鉴权 | `TRACE_RECEIVER_TOKEN` | 接收端与推流端（gateway/client-api/admin-api 的 OTLP Bearer）共用同一 `.env` 键自动对齐：生产接收端无此值拒绝启动；有 token 时缺它 = 推送全部 401。注意 compose.yml 各服务 `OTEL_TRACES_MODE` 缺省 `'off'`（覆盖 env_file）——启用链路需同步改 compose。生成：`openssl rand -hex 24` |
| Redis HA | `REDIS_SENTINELS` / `REDIS_SENTINEL_NAME` / `REDIS_SENTINEL_PASSWORD` | Sentinel 拓扑（见 [ha-deployment.md](ha-deployment.md)）。配置节点列表必须带主名（缺 `REDIS_SENTINEL_NAME` 拒绝启动）；`REDIS_URL` 继续作凭证载体。**v2 现状：仅 client-api 消费该组键**——gateway/admin-api 仍直连（详见 ha 手册「已知边界」） |

## compose 插值键（仅 `docker/compose.yml` 消费，应用不读）

| 键 | 默认 | 说明 |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `postgres` / `postgres` / `ai_gateway` | 容器 PG 超级用户/密码/库名；compose 同时用它们拼 `DATABASE_URL`。生产必改强随机密码 |
| `REDIS_PASSWORD` | `root123`（仅开发） | compose 用它建 Redis `requirepass` 并拼 `REDIS_URL`；HA 形态的 replica/sentinel 凭证同源。生产务必覆盖强随机值 |
| `TILLGATE_TAG` | `local` | 自建镜像标签（`tillgate/<svc>:<tag>`）；server 形态「本地构建 → save/load」用它对齐两端 |
| `GRAFANA_ADMIN_PASSWORD` | 无默认 | obs profile（`--profile obs`）必配——未设时 compose 直接拒绝启动（弱密码默认已移除） |

## v1 → v2 键名与语义变化

| v1 | v2 | 说明 |
|---|---|---|
| `UPSTREAM_HOST_ALLOWLIST` | （移除） | v2 SSRF 防护为 `packages/ai` 机械基线（https-only + 禁私网/回环 + DNS 逐地址判定防 rebinding），受信域名从渠道目录数据派生，不再维护静态白名单键 |
| `ALLOW_LOCAL_UPSTREAM`（client-api） | （移除） | 用户面无上游直连消费方，键不落地 |
| `INTERNAL_API_TOKEN` | （移除） | v1 的 BFF 内部令牌机制未迁入 v2；BFF 出站靠会话 cookie + 容器网络隔离 |
| `WORKER_SETTLE_WAKEUP` | `WORKER_SETTLE_WAKE` | 键名缩短；实现由 BullMQ 唤醒改为 PG LISTEN/NOTIFY |
| `EMAIL_CODE_REQUIRED=always/never` | `on`/`off` | 值域更名（`auto` 不变） |
| `ENCRYPTION_KEY`（全服务一把） | `ENCRYPTION_KEY` + `CHANNEL_API_KEY_ENCRYPTION` | 渠道 Key 加密拆出专用键：worker 必配专用键，gateway 专用键优先/回退根键，admin-api/client-api 仍用根键 |
| —（v1 无） | `IDENTITY_CODE_PEPPER` / `CLIENT_CODE_PEPPER` | identity 挑战/验证码域 HMAC pepper（管理面/用户面分离） |
| `GATEWAY_BODY_LIMIT_BYTES=10485760` | `GATEWAY_BODY_LIMIT_BYTES=10MB` | 网关两个 body/upload 键从纯数字改为字节量串（`b/kb/mb/gb`） |
| `LOGIN_*`（client-api 与 admin-api 同键） | client-api 保留 `LOGIN_*`；admin-api 改 `ADMIN_LOGIN_*` | 管理面爆破锁独立成键（阈值/窗口默认亦不同：1h 窗/15m 锁） |
| `ADMIN_CURRENCY` | （移除） | 管理面币种为部署定值 `CNY` |
| `FREE_MODEL_DAILY_LIMIT` 等 | （废弃） | `DEFAULT_USER_RPM`/`DEFAULT_USER_TPM`/`FREE_MODEL_DAILY_LIMIT`/`GENERATION_MAX_ACTIVE_PER_USER` 配置只告警忽略 |
| `GATEWAY_PORT`（compose 8083） | `GATEWAY_PORT`（compose 8080） | v1 的容器 8083 覆盖取消，统一 8080 |
| `ENCRYPTION_KEY_OLD` + `scripts/rotate-encryption-key.ts` | （未移植） | v2 密文格式 `enc:v1` 与 v1 逐字节兼容（同密钥互解），但双 key 在线轮换窗机制暂缺（见 [deployment-checklist.md](deployment-checklist.md)） |
| —（v1 worker 用 Redis） | worker 无 `REDIS_URL` | Redis 依赖全退出 |
| trace-receiver `DATABASE_URL` 可省 | 必填 | v1 藏默认连接串，v2 fail-fast |

相关文档：[deployment-checklist.md](deployment-checklist.md) · [ha-deployment.md](ha-deployment.md) · [api-contract.md](api-contract.md) · [tech-stack.md](tech-stack.md) · [project-structure-refactoring.md](project-structure-refactoring.md)
