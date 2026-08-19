# AI Gateway 技术选型与架构（v0.1）

> 配套文档：`requirements.md`（业务逻辑）、`data-model.md`（数据模型）、`api-contract.md`（接口契约）
> 本文件固化技术选型、工程结构、可观测架构、默认参数与安全基线。

---

## 1. 技术选型总表

| 层 | 选型 | 说明 |
|---|---|---|
| 语言/运行时 | TypeScript + **Node.js LTS** | Hono 跨运行时，Node 生产最稳 |
| 网关/API 框架 | **Hono** | 轻量、原生 async、SSE 流式（`streamSSE`） |
| 上游传输层 | **自研轻量传输**（fetch + SseParser + ProtocolAdapter） | 透传网关不适合生成式框架（AI SDK），决策理由见 §9 |
| ORM | **Drizzle** + drizzle-kit | 类型安全，迁移版本化 |
| 校验 | Zod + @hono/zod-validator | 契约即类型 |
| Redis | ioredis | 限流计数 / 余额缓存 / JWT 黑名单 / 锁 |
| 队列 | **BullMQ**（Redis） | 仅做唤醒；结算以 DB poll 为权威 |
| JWT | jose | 签发 / 验签（网关自签，HS256 起步，可换 RS256） |
| 加密 | node:crypto AES-256-GCM | 渠道上游 Key（密钥走环境变量） |
| 密码哈希 | argon2 | 本地账号兜底登录 |
| 日志 | pino | 结构化，与 OTel 打通 |
| 可观测 | @opentelemetry/sdk-node + auto-instrumentations | OTLP 导出（见第 3 节） |
| 测试 | vitest + mock 上游 | 单元 + 集成 |
| 包管理/构建 | pnpm workspaces / tsup（服务端） | Next.js 自带构建 |
| 部署 | Docker Compose（起步）→ K8s（P2） | 见第 4 节 |

---

## 2. Monorepo 工程结构

```
ai-getway/
├── apps/
│   ├── gateway/        # 对外代理（/v1/* + /oauth/token + /livez + /readyz），无状态，可多副本
│   ├── worker/         # 后台循环消费者：结算/回收/生成轮询/对账哨兵/告警投递/分区维护（领域逻辑在 packages/service；BullMQ 仅做唤醒）
│   ├── admin-api/      # 管理端 REST（/api/*，仅内网）
│   ├── client-api/     # 用户面 REST（/api/*，仅内网；含 /v1/payments/* 支付回调）
│   ├── client/         # 端用户面板（Next.js，3001）
│   ├── admin/          # 运营后台（Next.js，3002）
│   └── trace-receiver/ # OTLP span 接收端（PG 存储，管理台链路追踪页）
├── packages/
│   ├── ai/             # 上游 LLM 传输层（自研，详见 docs/ai-package.md）
│   ├── domain/         # 全部业务规则纯函数（rating 计价/结算分配/订阅规则等域目录）
│   ├── service/        # 全部用例编排（billing/settlement/funding/channel-budget 等域目录）
│   ├── repository/     # 全部 SQL（唯一允许 SQL 的包）
│   ├── wallet/         # 资金钱包内核（复式账本 + 两阶段冻结，长期资金内核）
│   ├── ledger-core/    # 通用幂等操作内核（operationId + canonical 指纹 + 回执重放）
│   ├── identity-core/  # 身份内核（会话锚点 + 验证码挑战）
│   ├── tracing/        # OTel/OTLP 封装（span 解码、分区存储、链路图）
│   ├── http/           # 共享 HTTP 基建（分页/参数校验/错误信封/幂等/审计）
│   ├── money/          # 已退役空壳（待清）；计价在 packages/domain/src/rating
│   ├── db/             # Drizzle schema + migrations（各服务共用）
│   ├── core/           # 共享基础设施：env zod 校验 + pino 日志 + OTel + AES-256-GCM
│   ├── identity/       # 会话/JWT/鉴权（admin-api/client-api 共用，双身份物理隔离）
│   ├── ui/             # 共享 shadcn 原语 + 主题（前端用）
│   └── api-client/     # REST 调用封装（前端用）
├── docker/
│   ├── compose.yml            # 生产编排（含观测栈）
│   └── compose.dev.yml        # 本地开发（含 adminer/pg 等）
├── docs/
└── package.json
```

**依赖方向**：`apps/* → packages/*`；包间为分层依赖——service→domain、service→repository→db（无环）。

---

## 3. OpenTelemetry 观测架构（自建开源栈）

```
gateway ──┐
worker  ──┼─ OTLP (4317/4318) ─▶ OpenTelemetry Collector ─┬─▶ Prometheus（指标）
admin-api─┤                                             └─▶ Tempo（链路）
client-api┘
日志：pino → stdout（Docker json-file 驱动统一收集，Grafana 直接查 Loki 可选后期加）
```

**默认路径**：内置 trace-receiver（OTLP span 接收，PG 存储 + 管理台链路追踪页），各服务默认 `OTEL_TRACES_MODE=off`；collector / tempo / grafana 是 compose profile `obs` 的可选增强（见第 4 节）。

**Docker 观测栈服务**：`otel-collector` / `prometheus` / `tempo` / `grafana`。

### 3.1 埋点清单

| 位置 | Span / 指标 | 标签 | 用途 |
|---|---|---|---|
| gateway HTTP 入口 | HTTP 服务端 Span + 指标 | user_id、api_key_id、model、channel、status_code、error_code | 请求量/延迟/错误率；限流 429、余额 402 单独计数 |
| 上游调用 | HTTP 客户端 Span（一条渠道一次） | channel_id、provider、尝试序号 | 渠道健康度、延迟分布，**熔断决策的数据来源** |
| worker 计量 | 队列指标 + Span | job 类型 | 队列积压长度、处理耗时、扣费失败/坏账计数 |
| 业务指标（自定义） | 计数器 | model、user | 今日 token 消耗、费用（成本面板） |

**采样策略**：网关入口按 10% 采样（可配），**错误请求 100% 采样**；worker 计量 Span 全量保留。

### 3.2 指标清单（Prometheus）

- `gateway_requests_total{user, model, channel, status}` — 请求量
- `gateway_requests_duration_ms{model, channel}` — 延迟直方图
- `gateway_errors_total{error_code}` — 错误（401/402/429/5xx）
- `channel_upstream_duration_ms{channel}` / `channel_failures_total{channel}` — 渠道健康
- `worker_queue_depth` / `worker_processing_duration_ms` — 计量队列
- `billing_bad_debt_total` / `billing_amount_total` — 计费健康

---

## 4. Docker Compose 服务清单

**生产 `compose.yml`**：

| 服务 | 镜像 | 说明 |
|---|---|---|
| nginx | nginx:alpine | TLS 终止、静态资源、反代 gateway / client / admin |
| certbot | certbot/certbot | TLS 证书签发/续期（entrypoint 常驻 sleep，renew 由 cron/手动触发） |
| gateway | node:lts-alpine 构建 | 对外代理，`replicas` 可扩 |
| worker | 同构建 | 计量消费，与 gateway 同镜像不同 command |
| admin-api | 同构建 | 管理端 REST（不暴露公网，仅内网） |
| client-api | 同构建 | 用户面 REST（不暴露公网，仅内网） |
| trace-receiver | 同构建 | 内置 OTLP span 接收（PG 存储，管理台链路追踪页） |
| console-client | 前端构建 | 端用户面板（Next.js standalone，3001） |
| console-admin | 前端构建 | 运营后台（Next.js standalone，3002） |
| redis | redis:7-alpine | 限流/缓存/队列（AOF 持久化） |
| postgres | postgres:16-alpine | 主存储（含初始化迁移） |
| migrate | 同构建 | 一次性：drizzle-kit migrate（postgres 就绪后执行并退出） |
| otel-collector | otel/opentelemetry-collector-contrib | OTLP 接收 + 路由 |
| prometheus | prom/prometheus | 指标存储 |
| tempo | grafana/tempo | 链路存储 |
| grafana | grafana/grafana | 面板（provisioning 仅含 datasources.yml 数据源，dashboard 需自建） |

> **观测栈开关**：otel-collector / prometheus / tempo / grafana 使用 compose **profile `obs`**——默认不启动，需要时 `docker compose --profile obs up -d`。起步单机不背 5 个观测容器；各服务默认 `OTEL_TRACES_MODE=off`，显式开启（`otlp`）才导出（collector 缺席时数据丢弃不阻塞业务）。

**启动流程**：postgres 就绪 → `drizzle-kit migrate`（一次性 init 容器）→ gateway/worker/admin-api 启动 → 观测栈。

**迁移方式**：`drizzle-kit migrate` 作为 compose 中独立的 `migrate` 服务执行，不混入应用启动。

> **billing_requests 迁移注意（历史注记：一次性迁移事件，已执行完毕，仅留档）**：0011 删除旧 billing_holds；停流量并确认无 held 后迁移，
> 新旧版本不可混合运行（新 gateway/worker 只认 `billing_requests` DB 状态机，旧进程仍使用已删除的 hold/Redis 语义）。
> 发布顺序：先跑 migrate → 停旧 gateway+worker 排空在途请求 → 起新 worker → 起新 gateway。

**网络边界**：nginx 只发布 gateway（80/443）与 client/admin 前端；**admin-api / client-api 不发布任何端口**，仅 compose 内网可达，由前端服务端代理调用。

**运维细节**：
- **备份策略（必做）**：PostgreSQL 每日 `pg_dump`（压缩 + 加密）至独立存储（对象存储/异机），保留 30 天；每周一次恢复演练；Redis 开启 `appendonly yes`（AOF，Redis 仅缓存/队列，不作为主账本）。
- **日志滚动**：Docker json-file 驱动 `max-size: 50m`、`max-file: 5`。
- **健康检查**：gateway `/livez` 只检查进程，`/readyz` 检查 PostgreSQL、Redis、账务 schema 与 drain 状态；worker 暴露 `/livez`、`/readyz`、`/health`，Redis 队列故障为 degraded、DB 故障为 not-ready。

---

## 5. 默认参数（可配置，环境变量覆盖）

| 参数 | 默认值 | 说明 |
|---|---|---|
| 上游重试 | 最多尝试 3 个渠道 | 仅对 5xx / 429 / 超时 / 网络错误重试；**4xx 不重试**（避免无谓消耗与计费歧义） |
| 熔断 | 连续失败 5 次 或 60s 内 5xx 率 > 50% → 熔断 5 分钟；**429/4xx/死凭据不计入熔断** | 死凭据（连续 401/403）单独标记「凭据无效」+ 告警 + 停止路由 |
| 上游超时 | connect 10s；非流式总超时 120s；流式空闲 5min（静默超时，超限断流） | |
| 流式心跳 | 静默 >30s 注入 `: keep-alive` 帧（仅 SSE 事件边界，防拆半截事件）；nginx `proxy_read_timeout` 调至 >5min | 防代理/LB 掐断长流 |
| 重试退避 | 指数退避 250ms 起 ×2 + jitter；总 deadline 240s；仅 5xx/429/网络/超时重试 | |
| 空完成重试 | 200 但无内容 → 同渠道退避重试 ≤2 次，仍空换渠道 | 非流式在完整 body 收到后判定 |
| 计费授权 | 默认输出上限 4096；BILLING_RESERVATION_MAX 默认 ¥50；lease 默认 60s | 足额授权 + durable receipt |
| 流式总时长上限 | 10 分钟（可配），超限主动断流 | agent 长任务场景按需调大 |
| 性能目标 | 单实例 ≥300 QPS 非流式转发、流式并发 ≥200 | 脚手架完成后 k6/autocannon 压测验证，结果决定副本数与 K8s 化时机 |
| 请求体上限 | 16MB | 超出返回 413 |
| 新用户限流默认 | 60 RPM / 1M TPM | 用户级可覆盖，Key 级可再加严 |
| 全局限流默认 | 2000 RPM / 100M TPM（按实例叠加放行） | 防整站被打 |
| JWT 有效期 | 2h（可配 15min~24h） | 一期无 refresh_token |
| 面板会话 | 24h | HttpOnly Cookie |
| 估算系数 | 1 token ≈ 3.5 字符 | 按模型可覆盖 |
| 日志脱敏 | request_summary 截断长度可配置（默认 2000 字符）；过滤 Authorization；管理员可凭 request_id 查询全文（受权限控制） | |
| 请求日志保留 | 30 天（按月分区滚动删除） | 用量明细永久 |
| 体验额度 | 新用户注册赠送 ¥1（1000 厘） | 见 6.2 |

---

## 6. 业务补充（本次讨论新增）

### 6.1 新用户体验额度（赠送 ¥1）
- 首次注册（按 `subject` 身份源唯一判定）自动赠送 ¥1，写 `transactions(type=gift)` + audit 日志。
- 防刷：同一 subject 只送一次；封禁再注册的新账号不重复送；上线后可按策略调整面额/取消。
- 与充值码同链路：余额增加 → 刷新 Redis 余额缓存 → 若处于冻结态自动解冻。

### 6.2 初始模型清单（上线前需运营确认，开发期占位即可）

| 对外模型名（建议） | 供应商 | 真实模型 |
|---|---|---|
| deepseek-chat / deepseek-reasoner | DeepSeek | 同名 |
| gpt-4o-mini / gpt-4o | OpenAI | 同名 |
| glm-4-flash / glm-4-plus | GLM（智谱） | 同名 |
| qwen-turbo / qwen-plus / qwen-max | Qwen（通义） | 同名 |
| minimax-chat / minimax-pro | MiniMax | abab6.5s-chat / abab6.5s-pro |

- **定价策略**：人民币定价；**单价表存官方价（输入/输出/缓存输入），用户价 = 官方价 × 费率卡系数**；OpenAI 等美元计费供应商的成本按实际账单核算，汇率风险由运营承担；官方价上线前按各家官网填写，开发期填占位值。
- 对外模型名规则：`external_name` 由运营定义，建议与真实名一致或加别名，客户端零改动。

---

## 7. 安全基线

| 项 | 措施 |
|---|---|
| TLS | nginx 终止 HTTPS（Let's Encrypt 证书；certbot 容器 entrypoint 为 sleep 常驻，续期须 `docker compose exec certbot certbot renew --webroot -w /var/www/certbot && docker compose exec nginx nginx -s reload`，cron 驱动）；管理端接口不暴露公网 |
| 上游 Key | AES-256-GCM 加密落库，密钥在环境变量；管理端编辑不回显 |
| 虚拟 Key / 充值码 / client_secret | 只存 SHA-256 哈希，明文仅创建时展示一次 |
| SSRF 防护 | 管理端配置渠道 base_url 时校验协议（仅 https）+ 域名（禁止内网/回环地址） |
| 请求体 | 16MB 上限；SSE 响应不缓冲 |
| 鉴权 | 对外凭证 401 兜底；控制台角色校验在 admin-api 层；面板 Cookie HttpOnly + SameSite=Lax |
| 审计 | 管理端所有变更写 audit_logs（调额/绑卡/封禁/渠道增删改） |
| 依赖 | pnpm 锁文件 + 定期扫描（可选 trivy 进 CI） |

---

## 8. 二期演进

- K8s：gateway 多副本 + HPA（按 CPU/请求量）；观测栈可选托管
- RS256 JWT（多签名密钥轮换）
- 云观测托管替换自建栈（若运维成本超标）
- daily_stats 聚合表 + 报表导出
- **控制面抽取**：网关零 DB、模型/价格/策略全部由控制面 hooks 注入（多租户/大规模时评估，参考 Kortix 库+控制面分离架构）

---

## 9. 传输层选型决策（自研 vs AI SDK）

**结论**：一期自研轻量传输层，不引入 Vercel AI SDK。

**理由**：本网关是「对外开放的中转站」——**wire 级透传是第一公民**；AI SDK 是生成式框架（解析重建请求），目标冲突：

1. **未知参数**：SDK 严格 schema 校验会丢弃未知参数，而契约要求"未知参数原样透传"（tools/tool_choice 等）；
2. **usage 完整性**：SDK 归一化 usage 会丢失缓存字段（`cached_tokens` / `cache_hit`），缓存计价（requirements 4.7）直接失效；
3. **各家特有字段**：deepseek-reasoner 的 `reasoning_content`、GLM/Qwen 特殊字段需原样透传到客户端；
4. **流式控制面**：心跳注入、增量 SSE 扫描（usage 最后帧胜出）、空完成判定、错误帧捕获均为 wire 层操作，SDK 不提供；
5. **一期供应商全 OpenAI 兼容**，SDK 的多协议转换价值用不上。

**对比参考实现（Kortix）**：它是自有平台的「重塑型网关」（重写模型/钳制参数/翻译工具调用，双表面转内部结构），AI SDK 匹配；我们与其场景不同，选型不同。中转站阵营（One API / New API）同样自写 HTTP 适配器。

**自研边界**：
- `HttpClient`：fetch（Node 原生）→ ReadableStream，背压与 abort 传播
- `SseParser`：事件边界 / 注释行 / 多行 data（~150 行，或引 eventsource-parser）
- `ProtocolAdapter` 接口：chat / embeddings / usage 归一化 / 错误映射——一期仅 `OpenAICompatibleAdapter`（透传 + 缓存字段归一化 + 参数钳制）
- 流控制：心跳注入、增量 SSE 扫描（usage 最后帧胜出）、空完成判定、错误帧捕获（requirements 5.11 / architecture 第 7 节）

**二期评估点**：接入 Anthropic/Gemini 原生协议时，手写 `AnthropicAdapter`（格式转换 + usage 映射）成本可控，届时再评估是否局部引入 SDK provider 包（仅格式转换、不做透传）。
