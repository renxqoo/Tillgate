# 生产部署检查清单

> 本文档自 v1（ai-getway）同名文档适配至 v2 结构；配置键与部署拓扑以代码与 docker/ 目录为准。

> 代码已就位、**配置不配等于没修**。逐项打勾后再上线。开发环境默认值已可跑通，
> 生产必须按本清单收紧。逐键语义与默认值见 [configuration.md](configuration.md)。

## 一、环境变量（生产必配）

| 变量 | 必配值/规则 | 不配的后果 |
|---|---|---|
| `TRUSTED_PROXY_HOPS` | nginx 单层反向代理 = `1`；直连 = `0`（默认） | 配 0 又在代理后：限流/爆破锁按 nginx IP 聚合，防御退化。compose 已给 gateway/client-api/admin-api/两个前端注入 `1`；脱离 compose 自跑别漏 |
| `JWT_SECRET` / `ADMIN_JWT_SECRET` | ≥32 随机且建议互不相同 | 生产 <32 拒绝启动。v2 变化：不再启动时强校验「不相同」——identity realm（`tillgate:admin`）使跨面 token 互不认账，但仍应独立随机值（同值扩大单键泄露的爆炸半径） |
| `ENCRYPTION_KEY` | ≥32 字符，一次性生成、最高等级保管 | admin-api / client-api 拒绝启动；gateway 无 `CHANNEL_API_KEY_ENCRYPTION` 时也靠它 |
| `CHANNEL_API_KEY_ENCRYPTION` | ≥32 字符（worker 专用） | **worker 拒绝启动**（无 `ENCRYPTION_KEY` 回退，以 `apps/worker/src/config.ts` schema 为准）。gateway 侧可省（回退根键） |
| `IDENTITY_CODE_PEPPER` / `CLIENT_CODE_PEPPER` | ≥16 随机（生产建议 ≥32） | admin-api / client-api 拒绝启动（v2 新增必填，两把 pepper 必须不同值——管理面/用户面分离） |
| `REDIS_PASSWORD` | 强随机（compose 用它建 Redis `requirepass` 并拼 `REDIS_URL`） | 缺省 `root123` = Redis 裸奔弱口令（仅开发默认） |
| `POSTGRES_PASSWORD` | 强随机（compose 用它拼 `DATABASE_URL`） | 缺省 `postgres`，数据目录卷沿用旧值时改键不生效——首次建库前设好 |
| `TRACE_RECEIVER_TOKEN` | ≥16 字符随机串（openssl rand -hex 24） | 生产无此值 trace-receiver 拒绝启动（fail-fast，属预期）。另注意 compose.yml 各服务 `OTEL_TRACES_MODE` 固定 `'off'`（覆盖 env_file）——启用链路要同步改 compose 或去掉覆盖，否则配了 token 也不推流 |
| `WORKER_HEALTH_TOKEN` | ≥16 字符随机串 | 不配 = `/health` 深度报告一律 403（`/livez` `/readyz` 不受影响） |
| `SECURE_COOKIE=true` | 生产必设（默认即生产 true） | 显式配 `false` = client-api 拒绝启动；缺 Secure 位 cookie 明文链路可被截获 |
| `SMTP_HOST/PORT/USER/PASS` | 个人邮箱（QQ/163 开 SMTP 拿授权码）或企业邮箱；三要素半配 = 启动失败 | 不配 = 管理员 2FA 与用户验证码功能 fail-closed（503，不降级单密码，属预期防线）；worker 告警邮件渠道不装配 |
| `CAPTCHA_SITE_KEY` + `CAPTCHA_SECRET_KEY` | Cloudflare Turnstile 成对配置（Dashboard → Turnstile → Add site）；只配一半拒绝启动 | 不配 = 注册面人机验证关闭：分布式刷号可薅首登赠额（单 IP 限流 5 次/时挡不住僵尸网络）。开发可用官方测试键（恒过） |
| `REGISTER_ENABLED` | 默认 `true`。设 `false` = 关闭邮箱自助注册，只留 GitHub/Google OAuth 建号（防多账号薅赠额的运营闸门；存量账号登录不受影响） | 不动即开启；关闭后 `POST /api/auth/register*` 一律 403，前端注册页显示关闭态 |
| `GRAFANA_ADMIN_PASSWORD` | 强随机（启用 `--profile obs` 观测栈时必配） | obs profile 未设此值 compose 直接拒绝启动（匿名访问已关闭，弱密码默认已移除） |
| `REQUEST_LOG_RETENTION_DAYS` / `TRACE_RETENTION_DAYS` | 默认 90 / 7（worker 分区滚动窗口） | v2 变化：v1 清单写 30，以 `apps/worker/src/config.ts` schema 默认 90 为准；调整保留期改此值 |
| `GLOBAL_RPM` | 按容量评估（默认 2000；生产硬顶 5000，超配自动钳回并告警） | 默认即生效；0 = 不限（生产慎用） |

v2 变化：v1 清单中的 `INTERNAL_API_TOKEN`（BFF 内部令牌）与 `FREE_MODEL_DAILY_LIMIT`
（已废弃、配置只告警忽略）不再适用，已从表中去掉。

## 二、网络边界

- [ ] **trace-receiver(:8793) / worker(:8792) 不对公网暴露**——compose 未给两者发布端口，
      只允许内网/容器网络访问；对外只有 nginx 80/443（server IP 形态另加 8443 管理后台）。
- [ ] gateway 经 nginx 对外：`limit_req`（每 IP 20r/s；`/v1/` 与支付回调 burst 40、
      `/v1/oauth/` 与 `/oauth/token` burst 20）已在 `docker/nginx/nginx.conf` 配置，确认线上
      nginx 加载了同款配置。
- [ ] 各服务端口只经反代暴露：gateway 443、两个面板 443（`server_name admin.*` 子域隔离，
      子域 cookie 默认不共享 = 用户/管理员会话物理隔离）；`client_max_body_size 16m` 与网关
      上传上限对齐。
- [ ] **支付回调**：EPAY 后台 notify_url 与 Stripe webhook 指向 `https://<域名>/v1/payments/notify/epay|stripe`
      （nginx 已按该路径分流到 client-api；旧路径 404，漏配 = 充值不入账）。
- [ ] **证书首签**（standalone，80 端口空闲时）：
      `docker compose -f docker/compose.yml run --rm --entrypoint certbot -p 80:80 certbot certonly
      --standalone --cert-name gateway -d <域名>…`；续期走 webroot + `nginx -s reload`
      （两条命令模板在 compose.yml certbot 注释里）。无域名 IP 部署用 `docker/compose.server.yml`
      （自签证书 + 8443，certbot 归入 profile 永不启动），且所有 compose 命令带 `--env-file .env`。

## 三、密钥管理（ENCRYPTION_KEY / CHANNEL_API_KEY_ENCRYPTION）

> v2 变化：v1 的「双 key 窗在线轮换」（`ENCRYPTION_KEY_OLD` + `scripts/rotate-encryption-key.ts`）
> **尚未移植到 v2**。v2 密文格式 `enc:v1` 与 v1 逐字节兼容（同密钥互解，见
> `packages/runtime/src/crypto/cipher.ts`），但运行中改 `ENCRYPTION_KEY` / `CHANNEL_API_KEY_ENCRYPTION`
> = 存量渠道上游 Key 密文全部无法解密（渠道调用即刻失败）。因此：

- [ ] 首次部署一次性生成 ≥32 强随机值，写入密码管理器最高等级条目——**丢失 = 渠道密文永久不可解**。
- [ ] 确需换 key：安排停机/低峰窗口，改值 → 重启 gateway/admin-api/worker →
      在管理台逐渠道重录上游 Key（重新落库加密）。换 key 前先核对存量渠道数量。
- [ ] 两把 pepper（`IDENTITY_CODE_PEPPER` / `CLIENT_CODE_PEPPER`）同理：运行中改值 = 已发
      挑战/恢复码与验证码 HMAC 全部失效，用户在途验证码作废一次性重发即可，但不要频繁轮换。

## 四、数据与容灾

- [ ] **PG 备份**：每日基础备份 + WAL 归档（资金账本 `billing_requests/billing_reservations`
      等不可丢）；每月做一次恢复演练（备份没验证过 = 没有备份）。HA 形态的 WAL 归档卷配置见
      [ha-deployment.md](ha-deployment.md) §4。
- [ ] Redis 数据可丢（v2 worker 已无 Redis 依赖，结算唤醒走 PG LISTEN/NOTIFY；Redis 只承载
      限流/爆破锁/会话吊销/OAuth state/定价缓存）——AOF/RDB 按需，非资金关键。
- [ ] 迁移策略：生产用 `docker compose -f docker/compose.yml up migrate`
      （一次性服务；v2 变化：收敛为 `packages/db` 的 drizzle-kit migrate 单入口，v1 的
      identity/ledger/wallet 多段 provision 已并入迁移 SQL，幂等可重跑；server 形态带 `--env-file .env`）。
- [ ] `request_logs` 为分区表（自迁移 0040 起 `PARTITION BY RANGE (created_at)`，
      见 `packages/db/src/schema/logs.ts` 顶部警示，不要对该表跑 db:generate）；
      `trace_spans` 按日分区（迁移 0028），分区由 worker 每小时维护。

## 五、监控与告警

- [ ] `/readyz`（gateway :8080 / worker :8792）探活——compose healthcheck 已配；
      `/health`（带 `x-health-token`）入监控面板（关注结算积压 pending/dead、
      `balance_low`、`reconcile_discrepancy` 告警事件——经 worker notify 渠道投递，
      `WORKER_NOTIFY_ENABLED=false` 会静音，生产保持 true）。
- [ ] 链路观测二选一：内置 trace-receiver（`OTEL_TRACES_MODE=otlp` + endpoint 指向
      `http://trace-receiver:8793` + `TRACE_RECEIVER_TOKEN`，管理台「链路追踪」页查看）；
      或 `--profile obs` 全家桶（collector+tempo+grafana，须配 `GRAFANA_ADMIN_PASSWORD`，
      各服务 endpoint 改指 `otel-collector:4318`）。
- [ ] 审计留存：request_logs 月分区按 `REQUEST_LOG_RETENTION_DAYS`（默认 90 天）滚动、
      trace_spans 日分区 7 天；资金类审计建议长期归档策略。

## 六、容量

- [ ] 首次上线压测（v1 单实例参考 `/v1/models` ≈4600 rps；v2 未复测，仅作量级参考）；
      生产按预期 QPS × 3 余量评估实例数。
- [ ] PG 连接数 = Σ(各服务 pool：gateway/client-api/admin-api 各 `DB_POOL_MAX`=10、
      worker 定值 20、trace-receiver 定值 10、migrate 一次性) × 副本数 < `max_connections` - 运维保留。

## 七、上线后自检（5 分钟）

```bash
# 1. 会话平面隔离（用户 cookie 打 admin 面应 401——identity realm 隔离）
# 2. worker 深度健康口未带令牌应 403
curl -s http://<worker-host>:8792/health        # → WORKER_HEALTH_TOKEN_REQUIRED
# 3. 生产依赖漏洞
bun audit                                        # → No known vulnerabilities
# 4. HTTP 强跳 HTTPS、健康口直出
curl -sI http://<域名>/livez                     # → 200（不 301）
curl -sI http://<域名>/                          # → 301 https
```

> v2 变化：v1 自检第 4 条的「审计脚本抽检」（scripts/01…19 编号脚本）未随仓移植，
> v2 `scripts/` 仅存 `check-package-boundaries.ts` 与 `fetch-models-dev.ts`，此条暂缺位。
