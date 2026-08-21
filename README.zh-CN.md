# TokenLens

**[English](README.md)** | [文档](docs/) | [CHANGELOG](CHANGELOG.md)

TokenLens 是一个可自托管的生产级 **LLM API 网关**：用统一的 OpenAI 兼容入口代理多家上游供应商，内置钱包计量计费、订阅体系、限额管控与全链路可观测。全链构建于 [Bun](https://bun.com)——后端 Hono + Drizzle + PostgreSQL + Redis，控制台 Next.js 16 + React 19 + Tailwind v4 + shadcn/ui。

```
客户端 / Agent ──> 网关 (/v1，OpenAI 兼容)
                     ├── 路由与故障转移 ──> OpenAI / DeepSeek / MiniMax / 通义千问 / Gemini / Anthropic …
                     ├── 预扣 → 结算计费（双分录账本，PostgreSQL 权威）
                     └── 链路追踪 / TTFT / 用量日志 ──> 管理后台
```

## 快速开始

### 安装

前置条件：[Bun](https://bun.com) ≥ 1.4 与 Docker（跑 PostgreSQL + Redis）。

```bash
git clone https://github.com/renxqoo/TokenLens.git && cd TokenLens
bun install                        # 安装依赖（bun.lock）
cp .env.example .env               # 本地默认值即可启动
docker compose -f docker/compose.dev.yml up -d   # 起 postgres + redis
bun run db:migrate                 # 建表 + identity/ledger 初始化 + 钱包开户
bun scripts/seed-admin.ts --password=YourStrongPass1   # 创建首个管理员
bun dev                            # 启动 gateway + worker + client-api + admin-api
bun dev:all                        # 再加两个 Next.js 控制台（3001 / 3002）
```

### 如何使用

1. 登录**管理后台**（`http://localhost:3002`），账号为 seed 命令创建的管理员（默认邮箱 `admin@ai-gateway.local`，密码是你传给 seed-admin 的那个）。添加上游**渠道**（供应商 API Key）与**模型映射**（对外模型名 → 真实模型 × 渠道）。若你的供应商 API 域名不在 `.env` 的 `UPSTREAM_HOST_ALLOWLIST` 默认清单里，需追加——白名单外的上游调用会被 SSRF 防护拦截。
2. 在**用户面板**（`http://localhost:3001`）创建 **API Key**（可选按 Key 的 RPM/TPM 限额、日消费上限、模型白名单）。
3. 像 OpenAI 一样调用：

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-..." -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

生产部署（TLS、certbot、nginx、观测栈、HA 拓扑）是一套 compose 文件——见[部署清单](docs/deployment-checklist.md)与[高可用部署手册](docs/ha-deployment.md)。**生产环境切勿保留 `.env` 默认密钥**——必须轮换 `POSTGRES_PASSWORD`、`REDIS_PASSWORD`、`JWT_SECRET`、`ADMIN_JWT_SECRET`、`ENCRYPTION_KEY`。

## 具体功能

- **OpenAI 兼容网关** — `/v1/chat/completions`（流式/非流式）、`/v1/embeddings`、多模态输入，另有 Gemini（`/v1beta`）与 Anthropic 原生协议入口；双凭证：静态 API Key 与网关签发的 App JWT（`/oauth/token`，面向 Agent）。
- **多供应商传输层**（`packages/ai`）— OpenAI / DeepSeek / MiniMax / 通义千问（dashscope）/ Gemini / Anthropic 协议适配，零缓冲 SSE 中继，上游 usage 归一，token 估算器（兜底不回报 usage 的供应商），厂商参数怪癖档案，SSRF 硬门。
- **渠道路由与故障转移** — 模型映射 × 加权渠道、渠道级预算与探活、熔断器、死凭据准入、换渠重试。
- **钱包计费** — 双分录账本内核（`packages/wallet`）、幂等预扣 → 结算（命令指纹 + 冲突重放）、8 态结算状态机、资金来源瀑布（订阅额度 → PAYG 余额）、崩溃恢复与对账。
- **订阅与定价** — 套餐、费率卡（官方价 × 系数）、免费日限、升降级、充值码与邀请返利。
- **API Key 与限额** — 按 Key 的 RPM/TPM、日消费上限、模型白名单、组织成员计费；无论何种凭证形态，用户级限额恒生效。
- **在线支付** — EPAY 与 Stripe 充值，webhook 对账入账。
- **异步生成** — 视频 / 音乐任务提交、轮询与回调结算。
- **可观测** — OTLP 链路追踪接收（单 trace 视图 + 拓扑图）、**双向 TTFT 指标**（上游 vs 客户端体感首 token 延迟，按渠道 P50 + P95）、usage/request/audit 三类日志与运营看板。
- **通知与告警** — 事务性发件箱驱动的告警投递（worker）、Webhook / 邮件通知渠道、管理员可选邮箱验证码二次登录。
- **故障韧性** — Redis Sentinel 支持；Redis 故障分级降级（限流 fail-open、爆破防护降级内存粗限、免费日限 fail-closed）；结算唤醒走 PostgreSQL LISTEN/NOTIFY——无队列中间件依赖。
- **双控制台** — 管理后台（渠道/模型/费率卡/用户/订阅/支付/观测）与用户面板（Key/用量/账单/操练场）。
- **Bun 原生工具链** — install / build / test / dev 全部跑在 Bun 1.4 + Turborepo 缓存上：网关吞吐约 2×、构建快 49×（[基准报告](docs/benchmark-2026-08-21-bun-vs-node.md)）。

## 总结

TokenLens 面向需要聚合或转售 LLM API 的团队，把通常要花数月自建的基础设施开箱化：兼容入口、供应商故障转移、能扛住崩溃的计费账本、全维度限额，以及能看清延迟与钱花在哪的链路追踪。深入阅读：[扣款全流程](docs/billing-flow-deep-dive.md) · [网关管线](docs/gateway-pipeline.md) · [技术选型](docs/tech-stack.md) · [API 契约](docs/api-contract.md) · [工程规范](AGENT.md)。

## 开源声明

以 [MIT 许可证](LICENSE) 开源。© 2026 TokenLens 贡献者。
