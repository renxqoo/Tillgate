# AI Gateway

多供应商 LLM API 中转站：统一 OpenAI 兼容入口，双凭证鉴权（静态 Key / 网关签发 JWT），官方价 × 费率卡定价，缓存 token 计价，预扣模式计费（DB 权威账本）。

## 文档（设计已定稿）

| 文档                                         | 内容                          |
| -------------------------------------------- | ----------------------------- |
| [AGENT.md](AGENT.md)                         | **工作规则**（AI 协作铁律、分层/资金域规范） |
| [CHANGELOG.md](CHANGELOG.md)                 | **修复与演进日志**（审计历史、施工留痕） |
| [docs/requirements.md](docs/requirements.md) | 业务逻辑与需求（最终评审版）  |
| [docs/data-model.md](docs/data-model.md)     | 数据模型（含 billing_requests）  |
| [docs/billing-flow-deep-dive.md](docs/billing-flow-deep-dive.md) | **v2 扣款全流程**（预扣/实扣公式、刷费用五向量防线） |
| [docs/api-contract.md](docs/api-contract.md) | API 契约（对外 + 管理端）     |
| [docs/tech-stack.md](docs/tech-stack.md)     | 技术选型 / 观测 / 运维 / 安全 |
| [docs/architecture.md](docs/architecture.md) | 架构与流程图                  |
| [docs/ai-package.md](docs/ai-package.md)     | packages/ai 传输层包设计      |

## 仓库结构

```
apps/
  gateway/         # 对外代理（Hono，dev 端口 8080）：/v1/* + /v1beta(Gemini) + /oauth/token + 预扣管线
  worker/          # 后台循环：结算/回收/生成轮询/对账哨兵/告警投递/分区维护（BullMQ 仅做唤醒）
  admin-api/       # 管理端 REST（8082，仅内网）
  client-api/      # 用户面 REST（8081，仅内网）
  client/          # 端用户面板（Next.js，端口 3001）—— 见 apps/client/README.md
  admin/           # 运营后台（Next.js，端口 3002）—— 见 apps/admin/README.md
  trace-receiver/  # OTLP span 接收端（PG 存储，管理台链路追踪页）
packages/
  core/            # Redis 基建（滑动窗口限流/爆破锁/Lua 运行器）+ 环境变量校验 + 对称加密
  wallet/          # 资金钱包内核（唯一资金事实源：复式账本 + 两阶段冻结 + tx 注入 + allowCredit）
  service/         # 全部用例编排（billing/settlement/funding/subscription/channel-budget…）
  domain/          # 全部业务规则纯函数（rating 计价/结算分配/订阅规则…）
  repository/      # 全部 SQL（唯一允许 SQL 的包）
  db/              # Drizzle schema + migrations + seed 脚本
  ledger-core/     # 通用幂等操作内核（operationId + canonical 指纹 + 回执重放）
  ai/              # 上游 LLM 传输层（自研，见 docs/ai-package.md）
  ui/              # 共享 shadcn 原语 + 主题 + 字体注册（前端用）
  api-client/      # 共享 REST 调用封装（apiFetch / ApiError / formatters，前端用）
  identity/        # 会话/JWT/鉴权（admin-api/client-api 共用，双身份物理隔离）
  identity-core/   # 身份内核（会话锚点 + 验证码挑战）
docker/            # compose.yml（生产）+ compose.dev.yml + nginx
docs/              # 设计文档
```

TypeScript 配置收敛在根目录：`tsconfig.base.json`（后端）+ `tsconfig.next.json`（前端/React）。

## 快速开始

```bash
pnpm install              # 安装依赖
cp .env.example .env      # 配置环境变量（本地开发用默认值即可启动）
pnpm db:migrate           # 执行迁移（迁移已随仓库入库——首次不需要也不应该跑 db:generate）
pnpm dev                  # 启动四个后端服务（gateway/worker/client-api/admin-api）
```

任务编排使用 **Turborepo**（turbo.json）：`pnpm build` / `typecheck` / `test` / `lint`
均走 turbo 缓存（第二次执行 FULL TURBO）；`pnpm dev:all` 才是全部 app（含前端）。

按需启动单独服务：

```bash
pnpm dev:gateway   # 对外代理（dev 端口 8080）
pnpm dev:worker    # 结算/回收消费者（健康端口 8792）
pnpm dev:client    # 端用户面板（端口 3001）
pnpm dev:admin     # 运营后台（端口 3002）
pnpm dev:admin-api # 管理端 REST（8082，仅内网）
pnpm dev:client-api# 用户面 REST（8081，仅内网）
```

本地开发（仅依赖 Redis + PostgreSQL）：

```bash
docker compose -f docker/compose.dev.yml up -d   # 起 redis + postgres
pnpm dev
```

生产部署（docker compose 全套命令）：

```bash
# ═══ 0. 前置 ═══
# 服务器已装 Docker 24+ 与 compose 插件；防火墙放行 80/443
# 两个域名的 A 记录都已指向服务器（示例：app.example.com / admin.example.com）
git clone https://github.com/renxqoo/TokenLens.git && cd TokenLens

# ═══ 1. 生产 .env（唯一配置面）═══
cp .env.example .env && vim .env
# 必改项：
#   POSTGRES_PASSWORD / REDIS_PASSWORD   # 强随机值（compose 用它建库/建 Redis 密码）
#   JWT_SECRET            # ≥32 随机（gateway+client-api 共用：playground JWT 签发/验签同源）
#   ADMIN_JWT_SECRET      # ≥32 随机（管理面独立密钥，勿与 JWT_SECRET 相同）
#   ENCRYPTION_KEY        # ≥32 随机（渠道密钥/webhook secret 落库加密；全服务同值，
#                         #  也是 worker/gateway 的 CHANNEL_API_KEY_ENCRYPTION 回落源）
#   SECURE_COOKIE=true    # 生产会话 cookie 安全位
#   OAUTH_FRONTEND_URL=https://app.example.com
#   EPAY_* 或 STRIPE_*    # 支付渠道成组配置（要用充值才配；部分配置=启动失败 fail-closed）
# 注：DATABASE_URL/REDIS_URL/端口等由 compose 注入，无需手填；NODE_ENV 由镜像内置 production

# ═══ 2. 起基础设施 + 一次性迁移 ═══
docker compose -f docker/compose.yml up -d postgres redis
docker compose -f docker/compose.yml up --build migrate
#   migrate 服务：identity-core/ledger-core provision + 全量 drizzle 迁移 + wallet 建账，
#   跑完自动退出（迁移幂等，重复执行安全）；看结果：... logs migrate | tail -20

# ═══ 3. 首次 TLS 证书（standalone 模式——此刻 80 端口还空着）═══
#   --cert-name gateway 必须带：nginx 按 /etc/letsencrypt/live/gateway/ 路径挂载
docker compose -f docker/compose.yml run --rm --entrypoint certbot -p 80:80 certbot certonly \
  --standalone --cert-name gateway \
  -d app.example.com -d admin.example.com \
  --email you@example.com --agree-tos --no-eff-email

# ═══ 4. 全量启动（首次构建 6 个镜像，约 10 分钟）═══
docker compose -f docker/compose.yml up -d --build

# ═══ 5. 验证 ═══
curl -s http://localhost/livez                          # {"ok":true}
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost/   # 200（真实证书应不带 -k）
docker compose -f docker/compose.yml ps                 # 全部 Up（migrate 为 Exited(0) 正常）

# ═══ 6.（可选）观测栈 ═══
docker compose -f docker/compose.yml --profile obs up -d
```

上线后必做的三件运维事：
1. **支付回调地址**：EPAY 后台 notify_url 与 Stripe webhook 端点指向
   `https://app.example.com/v1/payments/notify/epay|stripe`——旧路径已 404，漏配 = 充值不入账
2. **证书续期**（90 天有效，到期前 30 天可续；建议 cron 每周）：
   `docker compose -f docker/compose.yml exec certbot certbot renew --webroot -w /var/www/certbot \
   && docker compose -f docker/compose.yml exec nginx nginx -s reload`
3. 从 v1 时代升级的机器：`up -d` 加 `--remove-orphans` 清掉旧容器名（gateway-v2 等）

## 验证

```bash
pnpm regress      # 全仓门禁（typecheck/lint/test，31 任务）
pnpm typecheck    # 仅类型检查
pnpm test         # vitest
pnpm build        # 各包构建
```

## 前端

两个独立 Next.js 部署，详见各自 README：

- **用户面板** [`apps/client`](apps/client/README.md)：API Key / 充值码 / 用量 / 账单流水（端口 3001）
- **运营后台** [`apps/admin`](apps/admin/README.md)：用户 / 渠道 / 模型映射 / 费率卡 / 充值码批次 / 统计（端口 3002）

技术栈：Next.js 16.3 + React 19 + Tailwind v4 + shadcn `radix-nova` style + React Hook Form + Zod + TanStack Table 风格的原生 `<Table>` + Sonner + Lucide。视觉/组件跟 [`next-shadcn-admin-dashboard`](https://github.com/ArhamKhan09/studio-admin) 模板同款。
