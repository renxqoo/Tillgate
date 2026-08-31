# Tillgate

**[English](README.md)** | [文档](docs/) | [CHANGELOG](CHANGELOG.md)

![CI](https://github.com/renxqoo/Tillgate/actions/workflows/ci.yml/badge.svg)

Tillgate 是一个可自托管的 **LLM API 网关**：用统一的 OpenAI 兼容入口代理所有上游供应商，并把通常要花数月自建的部分全部内置——钱包计量计费、订阅体系、限额管控、管理后台、用户面板与逐请求链路追踪。全链 TypeScript，构建于 [Bun](https://bun.com)：后端 Hono · Drizzle · PostgreSQL · Redis · BullMQ，控制台 Next.js 16 + React 19 + Tailwind v4 + shadcn/ui。

```
客户端 / Agent ──> 网关（OpenAI · Claude · Gemini 三协议）
                     ├── 路由与故障转移 ──> OpenAI / Anthropic / Gemini / Azure / Bedrock / Vertex / 通义千问 / MiniMax …
                     ├── 预扣 → 结算计费（双分录账本，PostgreSQL 为资金唯一事实源）
                     └── 链路追踪 · TTFT · 用量日志 ──> 管理后台
```

## 界面预览

**用户面板**（左）—— 余额与消费总览、每日费用趋势、模型用量、API 密钥管理。
**管理后台**（右）—— 今日请求/消费/Token 指标、渠道健康度、14 天趋势与全量运营面。

<p align="center">
  <img src="docs/images/client-console-zh-cn.png" alt="用户面板 — 仪表盘" width="49%">
  <img src="docs/images/admin-console-zh-cn.png" alt="管理后台 — 仪表盘" width="49%">
</p>

## 为什么选择 Tillgate

- **一条 `docker run` 起全栈。** All-in-one 镜像内置 PostgreSQL、Redis、nginx 与 TLS；密钥生成、数据库迁移、首个管理员账号在首次启动时自动完成，全部状态落在单个 `/data` 卷里。首次启动需联网 npm 下载依赖（可用 `AIO_NPM_REGISTRY` 指定镜像源），装好后缓存于 `/data`，后续启动完全离线。
- **说你的 SDK 的语言。** OpenAI 的 `chat/completions`、`responses`、`completions`、`embeddings`、图像、语音、rerank，外加 Claude Messages 协议与 Gemini 原生端点，全部挂在同一个 base URL 后面——存量 OpenAI SDK 代码只改 `base_url`。
- **扛得住崩溃的计费。** 双分录账本 + 幂等预扣 → 结算（命令指纹 + 冲突重放）+ 结算状态机；PostgreSQL 是资金的唯一事实源，金额全程 Decimal——绝不引入浮点。
- **故障转移，而不是宕机。** 模型映射 × 加权渠道路由、渠道级预算与探活、熔断器、死凭据准入、换渠重试。
- **全维度限额。** 按 Key 的 RPM/TPM、按 Key 日消费上限、模型白名单、组织成员计费——无论何种凭证形态，用户级限额恒生效。
- **看清延迟与钱花在哪。** 双向 TTFT 指标（上游 vs 客户端体感首 token，按渠道 P50 + P95）、OTLP 链路追踪（单 trace 视图 + 拓扑图）、usage/request/audit 三类日志。

## 功能一览

**网关与协议**

- OpenAI 兼容面：`/v1/chat/completions`（流式/非流式）、`/v1/completions`、`/v1/responses`、`/v1/embeddings`、`/v1/images/generations`、`/v1/audio/speech`、`/v1/rerank`、`/v1/moderations`、`/v1/models`；Claude Messages 协议在 `/v1/messages`；Gemini 原生协议在 `/v1beta/models/*`；chat 支持多模态输入。
- 双凭证：静态 `sk-` API Key 与网关签发的 App JWT（`/oauth/token`，面向 Agent）。
- 异步生成：视频 / 音乐任务提交、轮询与回调结算。

**上游传输库**（`packages/ai`，零内部依赖）

- 8 个协议适配器：OpenAI 兼容、Anthropic、Gemini、Azure OpenAI、AWS Bedrock、Vertex AI、MiniMax、通义千问（dashscope）。
- 零缓冲 SSE 中继、上游 usage 归一、token 估算器（兜底不回报 usage 的供应商）、厂商参数怪癖档案。
- SSRF 硬防护：仅允许 HTTPS、环回/内网地址拒绝、DNS 解析后逐地址校验。

**路由与可靠性**（`packages/inference`）

- 加权渠道路由：渠道级预算、探活、熔断器、死凭据准入、换渠重试。
- Redis Sentinel 支持；Redis 故障分级降级；结算唤醒走 PostgreSQL `LISTEN/NOTIFY`。

**资金**（`packages/billing`）

- 双分录账本、幂等预扣 → 结算、8 态结算状态机、资金来源瀑布（订阅额度 → PAYG 余额）、崩溃恢复与对账。
- 套餐、费率卡（官方价 × 系数）、免费日限、升降级、充值码与邀请返利。
- EPAY 与 Stripe 在线充值，webhook 对账入账。

**账号与访问**

- 双控制台开箱即用：管理后台（渠道/模型/费率卡/用户/订阅/支付/观测）与用户面板（Key/用量/账单/操练场），经类型化客户端（`packages/api-client`）消费 API。
- GitHub / Google OAuth、Turnstile、SMTP 与支付凭据均在管理台运行时配置——轮换无需重新部署。
- 事务性发件箱通知（webhook / 邮件），管理员可选邮箱验证码二次登录。

**可观测**（`packages/observability`）

- OTLP 链路追踪接收（单 trace 视图 + 拓扑图）、按渠道双向 TTFT 指标、usage/request/audit 三类日志与运营看板。

**工程化**

- 可执行架构：包边界（依赖白名单、显式 exports、无环）由 `scripts/check-package-boundaries.ts` 在 CI 强制执行，每个能力包带架构契约测试，根级四门（`typecheck` / `lint` / `test` / `build`）。

## 快速开始

### 方式一 —— Docker（最快得到一个能用的网关）

一条命令起全栈，全部状态持久化在 `./data`：

```bash
docker run -d --name tillgate --restart always \
  --log-opt max-size=10m --log-opt max-file=3 \
  -p 443:443 -p 8443:8443 -p 80:80 \
  -v "$PWD/data:/data" \
  renxqoo/tillgate:latest
```

获取一次性管理员密码并观察启动进度：

```bash
docker logs -f tillgate                                    # 就绪后 Ctrl-C 退出，不影响服务
docker exec tillgate cat /data/bootstrap-credentials.txt   # 读后即删该文件
```

| 入口               | 地址                                                |
| ------------------ | --------------------------------------------------- |
| 用户面板与推理 API | `https://<服务器IP>/` · `https://<服务器IP>/v1/...` |
| 管理后台           | `https://<服务器IP>:8443`                           |

首次启动自动生成自签证书（可信任它，或在你边缘层终止 TLS）。域名形态、外接数据库、多容器生产拓扑与高可用见[部署指南](docs/deployment.md)。

### 方式二 —— 源码运行（开发用）

前置条件：[Bun](https://bun.com) ≥ 1.4 与 Docker（仅用来跑 PostgreSQL + Redis）。

```bash
git clone https://github.com/renxqoo/Tillgate.git && cd Tillgate
bun install                                            # 安装依赖（bun.lock）
cp .env.example .env                                   # 只含必填键；其余配置全部有安全默认值
# 生成五个必填密钥（弱值/空值启动即拒绝）：
for k in JWT_SECRET ADMIN_JWT_SECRET ENCRYPTION_KEY IDENTITY_CODE_PEPPER CLIENT_CODE_PEPPER; do
  sed -i.bak -E "s|^#?[[:space:]]?${k}=.*|${k}=$(openssl rand -hex 32)|" .env; done; rm -f .env.bak
docker compose --env-file .env -f docker/compose.dev.yml up -d   # 仅 postgres + redis
bun packages/db/scripts/provision-fresh.ts             # 空库前置建表（幂等）
bun run db:migrate                                     # 建表迁移（幂等）
cd apps/admin-api && bun scripts/create-admin.ts --email=admin@ai-gateway.local --apply && cd ../..
bun run dev                                            # 全部七个应用，热重载
```

`create-admin` 会为 `admin@ai-gateway.local` 打印一次性强密码（重复执行幂等跳过；生产引导用同一脚本，不落固定密码）。

| 服务                         | 端口            |
| ---------------------------- | --------------- |
| 网关 —— 推理 API             | `8080`          |
| 用户面板                     | `3001`          |
| 管理后台                     | `3002`          |
| client-api / admin-api       | `8081` / `8082` |
| worker 健康 / trace-receiver | `8792` / `8793` |

### 发出第一个请求

1. 登录**管理后台**（`http://localhost:3002`，Docker 形态为 `https://<服务器IP>:8443`），添加上游**渠道**（供应商 base URL + API Key，落库自动加密）与**模型映射**（对外模型名 → 真实模型 × 渠道）。
2. 在**用户面板**（`http://localhost:3001`）注册账号并创建 **API Key**——可选按 Key 的 RPM/TPM 限额、日消费上限与模型白名单。
3. 像 OpenAI 一样调用：

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Authorization: Bearer sk-..." -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

存量 OpenAI SDK 代码只改 base URL：

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="sk-...")
```

## 仓库结构

Turborepo monorepo：7 个应用 + 14 个能力包。应用是薄装配单元（配置 + HTTP 壳 + 接线）；业务能力在包内按 `domain / application / ports / adapters` 分层。工程规范见 [AGENTS.md](AGENTS.md)。

```
apps/       gateway · client-api · admin-api · worker · trace-receiver · client · admin   （装配单元）
packages/   ai · inference · billing · accounts · identity · control-plane · notifications ·
            observability · db · errors · http · runtime · api-client · ui                （能力包）
e2e/        跨进程系统测试（mock / real / smoke 门）
docker/     开发、生产与高可用拓扑的 compose 文件
```

## 文档

- [部署指南](docs/deployment.md)—— 单容器 AIO、多容器 compose、高可用、外接数据库
- [工具链基准测试](docs/benchmark-2026-08-21-bun-vs-node.md) —— 为什么全链 Bun
- [CHANGELOG](CHANGELOG.md) · [贡献指南](CONTRIBUTING.md) · [安全策略](SECURITY.md) · [行为准则](CODE_OF_CONDUCT.md)

## 开源声明

以 [MIT 许可证](LICENSE) 开源。© 2026 Tillgate 贡献者。
