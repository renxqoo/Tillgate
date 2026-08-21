# 生产部署检查清单（安全审计六轮收口后的必做项）

> 代码已就位、**配置不配等于没修**。逐项打勾后再上线。开发环境默认值已可跑通
> （兼容期行为），生产必须按本清单收紧。

## 一、环境变量（生产必配）

| 变量 | 必配值/规则 | 不配的后果 |
|---|---|---|
| `TRUSTED_PROXY_HOPS` | nginx 单层反向代理 = `1`；直连 = `0`（默认） | 配 0 又在代理后：限流/authfail 按 nginx IP 聚合，防御退化（正确密码豁免保住可用性） |
| `INTERNAL_API_TOKEN` | ≥16 字符随机串（openssl rand -hex 24） | 不配 = CSRF「Origin/Referer 双缺失」仍放行（兼容期）；配后 BFF/脚本自动携带、浏览器拿不到 |
| `WORKER_HEALTH_TOKEN` | ≥16 字符随机串 | 不配 = `/health` 深度报告一律 403（`/livez` `/readyz` 不受影响） |
| `TRACE_RECEIVER_TOKEN` | ≥16 字符随机串 | 生产无此值 trace-receiver 拒绝启动（fail-fast，属预期） |
| `JWT_SECRET` / `ADMIN_JWT_SECRET` | ≥32 字符且互不相同 | 生产 <32 拒绝启动；相同值拒绝启动（双平面隔离） |
| `ENCRYPTION_KEY` | ≥32 字符，一次性生成永不直改 | 轮换走双 key 窗流程（见下） |
| `SECURE_COOKIE=true` | 生产必设（NODE_ENV 由镜像内置） | 不配 = 会话 cookie 缺 Secure 位，明文链路可被截获 |
| `SMTP_HOST/PORT/USER/PASS` | 个人邮箱（QQ/163 开 SMTP 拿授权码）或企业邮箱均可；不配则管理员邮箱验证码二次登录不可用（fail-closed） | 管理员开了 2FA 但没配 SMTP → 登录 503（不降级单密码，属预期防线） |
| `CAPTCHA_SITE_KEY` + `CAPTCHA_SECRET_KEY` | Cloudflare Turnstile 成对配置（Dashboard → Turnstile → Add site）；只配一半拒绝启动 | 不配 = 注册面人机验证关闭：分布式刷号可薅首登赠额（单 IP 限流 5 次/时挡不住僵尸网络）。开发可用官方测试键（恒过） |
| `REGISTER_ENABLED` | 默认 `true`。设 `false` = 关闭邮箱自助注册，只留 GitHub/Google OAuth 建号（防多账号薅赠额的运营闸门；存量账号登录不受影响） | 不动即开启；关闭后 `POST /api/auth/register*` 一律 403，前端注册页显示关闭态 |
| `FREE_MODEL_DAILY_LIMIT` | 按产品策略（默认 500/天/用户；0=不限） | 默认值即生效，无需动作 |
| `REQUEST_LOG_RETENTION_DAYS` | 默认 30（分区滚动窗口） | 无需动作；调整保留期时改此值 |

## 二、网络边界

- [ ] **trace-receiver(:8793) / worker(:8792) 不对公网暴露**——只允许内网/容器网络访问。
- [ ] gateway 经 nginx 对外：`limit_req`（/v1/ 20r/s burst 40）已在 `docker/nginx/nginx.conf` 配置，确认线上 nginx 加载了同款配置。
- [ ] 各服务端口只经反代暴露：gateway 443、两个面板 443；admin 面板域名与用户面域名隔离。
- [ ] **支付回调**：EPAY 后台 notify_url 与 Stripe webhook 指向 `https://<域名>/v1/payments/notify/epay|stripe`
      （旧路径 404，漏配 = 充值不入账）。
- [ ] **证书首签**（standalone，80 端口空闲时）：`docker compose -f docker/compose.yml run --rm
      --entrypoint certbot -p 80:80 certbot certonly --standalone --cert-name gateway -d <域名>…`；
      续期见 compose.yml certbot 注释。

## 三、密钥轮换（ENCRYPTION_KEY）

按 `scripts/rotate-encryption-key.ts` 头部四步流程执行：
1. `.env` 加 `ENCRYPTION_KEY_OLD=<现值>`，`ENCRYPTION_KEY=<新值>`（openssl rand -hex 32）
2. 重启 gateway + admin-api（双 key 窗生效：新写 `enc:v2`，存量 v1 用 OLD 解密，不中断）
3. `bun scripts/rotate-encryption-key.ts`（事务化迁移，可并发、幂等可重跑）
4. 报「全部完成」后移除 `ENCRYPTION_KEY_OLD` 并重启（收窗）
注意：双 key 窗一次只支持一个世代（v1→v2）；再次轮换前必须完成上一次收窗。

## 四、数据与容灾

- [ ] **PG 备份**：每日基础备份 + WAL 归档（资金账本 `transactions/usage_logs/billing_requests`
      不可丢）；每月做一次恢复演练（备份没验证过 = 没有备份）。
- [ ] Redis 数据可丢（结算以 DB poll 为权威，队列只是唤醒）——AOF/RDB 按需，非资金关键。
- [ ] 迁移策略：生产用 `docker compose -f docker/compose.yml up --build migrate`
      （一次性服务：provision + 全量迁移 + wallet 建账，幂等可重跑）；`request_logs` 为分区表（见
      `packages/db/src/schema/logs.ts` 顶部警示，不要对该表跑 db:generate）。

## 五、监控与告警

- [ ] `/readyz`（gateway/worker）探活；`/health`（带 `x-health-token`）入监控面板
      （关注 `pending/dead/uncertain/oldestPendingMs` 结算积压）。
- [ ] 告警项建议：billing dead/uncertain 增长率、reconcile_discrepancies 新增、
      429 比例突增、渠道 `status=4`（死凭据）出现。
- [ ] 审计留存：audit_logs / request_logs 分区 30 天滚动；资金类审计（audit_logs）建议
      长期归档策略。

## 六、容量

- [ ] 首次上线压测：dev 单实例参考 `/v1/models` ≈4600 rps；生产按预期 QPS × 3 余量
      评估实例数与 PG 连接池（`DATABASE_URL` pool 参数）。
- [ ] PG 连接数 = Σ(各服务 pool max)× 实例数 < `max_connections` - 运维保留。

## 七、上线后自检（5 分钟）

```bash
# 1. 会话平面隔离（用户 cookie 打 admin 面应 401）
# 2. worker 深度健康口未带令牌应 403
curl -s http://<worker-host>:8792/health        # → WORKER_HEALTH_TOKEN_REQUIRED
# 3. 生产依赖漏洞
bun audit --prod                                 # → No known vulnerabilities
# 4. 审计脚本抽检（生产只读类：01/03/07/19；写数据类脚本勿对生产跑）
```
