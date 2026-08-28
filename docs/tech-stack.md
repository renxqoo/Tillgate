# Tillgate 技术选型与架构（v0.2）

> 本文档自 v1（ai-getway）同名文档适配至 v2 结构；接口与结构以代码为准。
> 配套文档：[api-contract.md](./api-contract.md)（接口契约）、[project-structure-refactoring.md](./project-structure-refactoring.md)（结构重构方案，目标态唯一权威）、[configuration.md](./configuration.md) / [deployment-checklist.md](./deployment-checklist.md) / [ha-deployment.md](./ha-deployment.md)（运维三篇）
> 本文件固化技术选型、工程结构、可观测架构、默认参数与安全基线。

---

## 1. 技术选型总表

| 层 | 选型 | 说明 |
|---|---|---|
| 语言/运行时 | TypeScript 5 + **bun**（1.4） | 全链 bun：运行时、构建（bun build / `bun x next build`）、测试（`bun x vitest`）都跑在 bun 上；`engines.bun >= 1.4.0` |
| 任务编排 | **Turbo**（turbo.json） | build / dev / lint / typecheck / test 任务图，`bunx turbo <task>` 驱动 |
| Lint / Format | **oxlint + oxfmt** | v2 用 oxlint/oxfmt 替代 v1 的 eslint/prettier；全仓只有一套规则，配置固定根目录，不建 `tooling/` 包 |
| 网关/API 框架 | **Hono**（^4.13） | 轻量、原生 async；SSE 流式字节流直通（`Response` + `pipeThrough`，显式 `x-accel-buffering: no`） |
| 上游传输层 | 自研 **`@tillgate/ai`**（protocol / adapters / transport / pipeline / usage / retry / registry） | 透传中继 + 协议适配 + `onEvent` 观察面；零内部依赖，独立库包（ADR-0006，决策理由见 §9） |
| ORM | **Drizzle**（drizzle-orm ^0.45 + drizzle-kit ^0.31） | 类型安全，迁移版本化（`packages/db` 统一迁移链） |
| 校验 | **zod v4** + `@tillgate/http` zod-validator 封装 | 契约即类型；wire schema 归提供接口的 app 自有 |
| Redis | ioredis | 限流计数 / 爆破守卫 / 会话吊销线 / OAuth state / 队列锁 |
| 事件唤醒 | **PG LISTEN/NOTIFY** | worker 结算即时唤醒（纯门铃，可丢）；结算以 DB poll 为权威，定时扫描兜底（`apps/worker/src/wakeup/postgres-notify.ts`） |
| JWT | jose | 签发/验签（网关与控制台会话均 HS256 起步） |
| 加密 | node:crypto **AES-256-GCM** | 渠道上游 Key（`ENCRYPTION_KEY` 根键派生，32 字节） |
| 密码哈希 | node:crypto **scrypt**（`scrypt:N:r:p:<saltHex>:<hashHex>`） | 本地账号兜底登录；哑哈希保证等量计算防枚举（v1 为 argon2） |
| 金额运算 | **decimal.js** + `numeric(38,18)` 字符串读写 | `packages/billing/src/domain/money.ts` 单一真相 |
| 邮件 | nodemailer（identity 登录码 / notifications 投递） | SMTP 装配注入 |
| 日志 | pino（^10） | 结构化，`packages/runtime/src/logging`；与 OTel 打通 |
| 可观测 | **@opentelemetry/***（sdk-node / sdk-metrics / otlp-http exporter） | OTLP 导出（见第 3 节）；封装在 `packages/observability/src/telemetry` |
| 前端 | **Next.js 16 + React 19 + Tailwind v4 + shadcn**（packages/ui，base-nova 预设 / Base UI） | 共享设计系统在 `@tillgate/ui`（纯 React，禁止 Next 专有依赖） |
| 测试 | vitest（^4）+ mock 上游 | 单元/契约/集成；跨进程旅程在根 `e2e/`（§10） |
| 包管理/构建 | bun workspaces / bun build（服务端） | 内部包 build 只生成 JS（无 dts 强制）；类型经 exports 直指源码或 dist |
| 部署 | Docker Compose（起步，四份编排）→ K8s（P2） | 见第 4 节 |

---

## 2. Monorepo 工程结构

结构目标态唯一权威是 [project-structure-refactoring.md](./project-structure-refactoring.md)；本节是其速览。当前快照与目标态的差距以该文档的分阶段迁移（P0~P8）为准。

```
tillgate/
├── apps/                     # 7 个可独立部署进程，全部 private
│   ├── gateway/              # 公网推理入口：/v1/* 推理矩阵 + /oauth/token + /livez /readyz /healthz，无状态可多副本
│   ├── worker/               # 后台任务：scheduler + jobs（settlement/poll/reconcile/notify/referral/partition）+ PG NOTIFY 唤醒 + /health 深报告
│   ├── client-api/           # 用户面 REST（/v1/*，不暴露公网；/v1/oauth/* 与 /v1/payments/notify/* 经 nginx 选择性放行）
│   ├── admin-api/            # 管理面 REST（/v1/*，仅内网）
│   ├── client/               # 端用户面板（Next.js 16，3001）
│   ├── admin/                # 运营后台（Next.js 16，3002）
│   └── trace-receiver/       # OTLP span 接收端（POST /v1/traces，PG 存储，管理台链路追踪页）
├── packages/                 # 14 个能力包（§3.1 目标集合）
│   ├── errors/               # 错误根契约：nature/category 闭集/目录定义，零业务依赖的稳定叶子
│   ├── runtime/              # 服务端运行时基建：config(zod)/logging(pino)/crypto/redis/lifecycle/testing
│   ├── db/                   # 连接、事务、schema、迁移（drizzle-kit 单一迁移链）；不放业务用例
│   ├── http/                 # 纯 HTTP/Hono 基建：错误渲染/校验/分页/请求上下文/幂等/安全；无 wire schema、不依赖 db
│   ├── identity/             # 身份完整能力：凭据/挑战/MFA/OAuth/会话吊销（user 与 admin 双 realm）
│   ├── accounts/             # 用户/组织/API Key/Application/邀请与推荐
│   ├── billing/              # 唯一资金与计费事实源：money/wallet/ledger/rating/subscription/payments/redemption/settlement
│   ├── ai/                   # 上游协议库（独立库包，ADR-0006）：protocol/adapters/transport/pipeline/usage/retry/registry/onEvent
│   ├── inference/            # 推理用例：候选循环/路由/quote 与计费衔接/生成任务/故障转移 + health（熔断/死凭据）
│   ├── control-plane/        # 管理员/Provider/Channel/Model/RateCard 配置与只读目录快照
│   ├── notifications/        # 通知渠道/模板/事务 outbox/认领/投递
│   ├── observability/        # telemetry / tracing / audit / request-log / usage + adapters/postgres
│   ├── api-client/           # 前端 REST 封装（框架无关 core + dto + 可选 next 子入口）；第一发布候选
│   └── ui/                   # 纯 React 设计系统（shadcn base-nova / Tailwind v4）；第二发布候选
├── e2e/                      # 跨进程系统测试（非 workspace 包），见 §10
├── scripts/                  # 仓库自动化（非 workspace 包）：check-package-boundaries.ts / fetch-models-dev.ts
├── docs/                     # adr/（ADR 体系）+ 结构与领域文档
├── docker/                   # compose 四份编排 + nginx + Dockerfile.server / Dockerfile.migrate + 观测栈配置
├── turbo.json / tsconfig.base.json / tsconfig.next.json / .oxlintrc.json / .oxfmtrc.json
└── package.json              # workspace 根，永远 private
```

- **依赖方向**：`apps/* → packages/*`，packages 禁止反向；能力包内部 `domain ← application`，真实 I/O / 第三方 / 可替换实现才加 `ports ← adapters`（禁止接口仪式化）；跨包引用只走显式 `exports`，`ai` 零内部依赖、仅被 `inference` 单向消费。
- **包内分层**：业务 SQL 只住各能力包 `src/adapters/postgres/`（`packages/repository` 已拆解迁入）；业务规则只住 `src/domain/`（原 `packages/domain`）；用例编排只住 `src/application/`（原 `packages/service`）；app 只保留 config / assembly / 路由 / 中间件 / presenter / 生命周期。
- **v1 → v2 包映射**：`wallet + ledger-core + money + service(计费部分) → billing`；`repository → 各能力包 adapters/postgres`；`domain → 各能力包 domain`；`service → 各能力包 application`；`core → runtime + observability`；`identity-core + identity → identity`；`tracing → observability`；`apps/*` 七个同名保留。
- **根配置不建 tooling 包**：TypeScript / Vitest / Oxlint / Oxfmt / Turbo 配置放根目录；是否进入 workspace、是否参与构建、是否发布是三个独立决策；所有 workspace 默认私有，发布白名单初始为空（候选：api-client / ui / ai）。
- **事务纪律**：事务由发起业务用例的 application 持有；跨能力可靠事件同一事务写 notifications outbox；公开 facade 不暴露 `DbTx`。

---

## 3. OpenTelemetry 观测架构

```
gateway ──┐
worker  ──┼─ OTLP ─▶ trace-receiver:8793 ──▶ PostgreSQL（分区存储）
admin-api─┤
client-api┘
日志：pino → stdout（Docker json-file 驱动统一收集）
```

**默认路径**：内置 `trace-receiver`（`POST /v1/traces` 接收 OTLP/HTTP JSON → 解码 → 批量入库 PG 分区；Bearer `TRACE_RECEIVER_TOKEN` 鉴权），管理台「链路追踪」页查询（admin-api `/v1/tracing/*`，数据经 `packages/observability` tracing 查询面）。各服务默认 `OTEL_TRACES_MODE=off`，显式开启（`otlp` + endpoint）才导出。

**观测能力分包**（`packages/observability/src/`）：

| 子域 | 职责 |
|---|---|
| telemetry/ | OTel SDK 初始化（init-otel）、span 助手（with-span / trace-parent）、内存查看器、指标导出（interval 默认 10s） |
| tracing/ | OTLP 解码（decode）、入库（ingest）、分区维护（partition）、查询（queries）、链路图（graph） |
| audit/ | 审计事实存储与查询（action/payload 语义归业务能力，经 port 投递；资金/安全审计同事务不降级） |
| request-log/ | 网关 `/v1/*` 请求日志（401/429 也入日志；30 天窗滚动删除） |
| usage/ | 用量明细查询（day-window / by-model / summary；含 estimated/estimateReason） |

### 3.1 埋点与指标要点

- gateway HTTP 入口 OTel 中间件（requestId 之后挂载，span 属性带 request.id）；限流 429、余额 402 单独计数。
- 上游调用经 `ai` 包 `onEvent` 观察面旁路消费——**不阻塞数据面**；渠道熔断/死凭据等跨请求健康状态由 `inference/health` 作为订阅者维护（`ai` 零运维状态）。
- 业务指标（请求量/延迟/错误/渠道健康/计费）经 OTLP 导出；指标名沿用 v1 Prometheus 命名约定（gateway_requests_total 族）。

---

## 4. Docker Compose 服务清单

`docker/` 下四份编排：`compose.yml`（生产全量）、`compose.dev.yml`（本地开发：redis + postgres）、`compose.server.yml`（单服务器部署）、`compose.ha.yml`（高可用：Redis 主从 + Sentinel×3、PostgreSQL 归档）。运维细节见 [deployment-checklist.md](./deployment-checklist.md) / [ha-deployment.md](./ha-deployment.md)。

**生产 `compose.yml`**：

| 服务 | 镜像 | 说明 |
|---|---|---|
| nginx | nginx:alpine | TLS 终止；`/v1/`（除 oauth/支付回调）与 `/oauth/token`、`/livez /readyz` 反代 gateway；`/v1/oauth/`、`/v1/payments/notify/(epay\|stripe)` 反代 client-api；其余反代前端 |
| certbot | certbot/certbot | TLS 证书签发/续期（entrypoint 常驻 sleep，renew 显式触发） |
| gateway | tillgate/gateway（Dockerfile.server 构建，`TILLGATE_TAG` 可覆写） | 公网推理入口，可扩副本 |
| client-api | 同构建 | 用户面 REST（不发布端口） |
| admin-api | 同构建 | 管理面 REST（不发布端口） |
| worker | 同构建 | 后台任务（同镜像不同 command） |
| trace-receiver | 同构建 | OTLP span 接收（PG 存储） |
| console-client | 前端构建 | 端用户面板（Next.js standalone，3001） |
| console-admin | 前端构建 | 运营后台（Next.js standalone，3002） |
| redis | redis:7-alpine | 限流/守卫/缓存（AOF 持久化） |
| postgres | postgres:16-alpine | 主存储 |
| migrate | tillgate/migrate（Dockerfile.migrate） | 一次性：drizzle-kit migrate（postgres 就绪后执行并退出） |

**启动流程**：postgres 就绪 → `migrate`（一次性 init 容器）→ gateway / client-api / admin-api / worker / trace-receiver → 前端。

**网络边界**：nginx 只发布 80/443；**admin-api / client-api 不发布任何端口**，仅 compose 内网可达，由前端服务端代理调用；client-api 仅 oauth 与支付回调路径经 nginx 放行。

**运维基线**：
- 备份：PostgreSQL 每日 `pg_dump`（压缩+加密）至独立存储，保留 30 天；每周恢复演练；Redis AOF（仅缓存/队列，不作主账本——账务唯一事实源在 PG `billing`）。
- 日志滚动：Docker json-file `max-size: 10m` / `max-file: 5`。
- 健康检查：gateway `/readyz` 查 PG+Redis；worker `/readyz` 查 scheduler+PG+BullMQ Redis，`/health` 深报告由 `x-health-token` 守卫。

---

## 5. 默认参数（可配置，环境变量覆盖；缺省值唯一真相在各 app config.ts）

| 参数 | 默认值 | 说明 |
|---|---|---|
| 上游重试 | 候选循环多渠道尝试（请求内退避重试在 `ai` retry 层） | 仅 5xx/429/超时/网络错误重试；**4xx 不重试** |
| 熔断 | `inference/health` 订阅 AiEvent 维护（熔断/死凭据） | 429/4xx/死凭据不计入熔断；死凭据单独标记 + 停止路由 |
| 上游超时 | connect 10s；总 deadline 120s（`GATEWAY_UPSTREAM_DEADLINE_MS`） | |
| 计费授权 | 输出上限默认 4096 tokens、暴露帽 32768；预留上限 ¥1000（`BILLING_RESERVATION_MAX`）；full 完整冻结 / fixed 固定冻结；授权 TTL 300s | `BILLING_AUTHORIZATION_TTL_MS`；生成任务 TTL 1h + 租约宽限 30s |
| 停机宽限 | 60s（`GATEWAY_SHUTDOWN_GRACE_MS`） | SIGTERM 拒新请求 + 宽限排空在途（e2e 冒烟覆盖） |
| 请求体上限 | **10MB**（`GATEWAY_BODY_LIMIT_BYTES`） | 超出 413；multipart 单文件另限 16MB |
| 全局限流 | `GLOBAL_RPM` 默认 2000（生产硬顶 5000 并告警） | 用户级限流**无默认**（`DEFAULT_USER_RPM/TPM` 已废弃——按 Key/App 显式配置） |
| 爆破守卫 | Key/客户端：5 次失败/600s → 锁 600s；IP：30 次/300s | `/oauth/token` 按 IP + `client:{id}` 双锁 |
| JWT（App） | TTL 3600s（`JWT_TOKEN_TTL_SECONDS`，≥60）；iss=ai-gateway、aud=ai-gateway-api | HS256；无 refresh_token |
| 控制台会话 | TTL 24h（`SESSION_TTL_SECONDS`，60s~30d） | Bearer JWT + jti 吊销线（无 Cookie） |
| OTel | `OTEL_TRACES_MODE=off`；指标间隔 10s | 开启 otlp 需 endpoint + `TRACE_RECEIVER_TOKEN` |
| SSRF 逃生门 | `GATEWAY_AI_ALLOW_LOCAL_URL` 仅非生产恒关 | 生产误配 env 也恒关（与 admin-api 同口径） |

> 与 v1 默认差异：请求体上限 16MB→10MB；App JWT 2h→1h；用户级限流默认（60 RPM/1M TPM）已移除。

---

## 6. 业务补充

### 6.1 新用户体验额度

- 首次注册（按 subject 身份源唯一判定）自动赠送体验额度，走 `billing` credit 用例（`transactions(type=gift)`）+ 审计；同一 subject 只送一次；上线后可按策略调整面额/取消。
- 与充值码同链路：余额增加 → 若处于冻结态自动解冻；推荐（aff）奖励经 `billing` referral-commission + worker 认领发放。

### 6.2 模型价目来源

- 官方价不再在文档内维护清单：管理面「模型目录」从外部源（models.dev）导入（`GET /v1/model-catalog/*` + `POST /v1/model-catalog/import`；开发脚本 `scripts/fetch-models-dev.ts`）。
- **定价策略**不变：人民币定价；单价表存官方价（输入/输出/缓存输入），用户价 = 官方价 × 费率卡系数（model > group > global）；汇率族接口（`/v1/fx/*`）管理外币供应商成本换算（含手工覆写与缓冲）。

---

## 7. 安全基线

| 项 | 措施 |
|---|---|
| TLS | nginx 终止 HTTPS（Let's Encrypt + certbot，续期显式触发 + reload）；管理面接口不暴露公网 |
| 上游 Key | AES-256-GCM 加密落库（`ENCRYPTION_KEY` 根键），管理面编辑不回显 |
| 虚拟 Key / 充值码 / client_secret | 只存 SHA-256 哈希，明文仅创建时展示一次 |
| SSRF 防护 | `ai` transport 硬门（协议 + 域名校验，禁内网/回环）；逃生门仅非生产 |
| 请求体 | 10MB 上限（上传单文件 16MB + MIME 白名单）；SSE 响应不缓冲 |
| 鉴权 | 对外凭证 401 兜底 + 爆破双锁；控制台 Bearer 会话（无 Cookie 无 CSRF），用户/管理员双 realm 物理隔离，401 不区分原因防枚举 |
| 审计 | 管理端变更写审计（资金/安全类同事务 port 投递，不降级 best-effort）；存储/查询在 `observability` |
| 依赖 | bun.lock 锁文件；边界门禁进 CI（§10） |

---

## 8. 二期演进

- K8s：gateway 多副本 + HPA；观测栈可选托管（见 [ha-deployment.md](./ha-deployment.md)）
- RS256 JWT（多签名密钥轮换）
- `generated/openapi` → `api-client` 生成链落 CI（contract → OpenAPI → generated client，禁手改双轨）
- 报表导出（`GET /api/admin/stats/export` 预留）

---

## 9. 传输层选型决策（自研 vs AI SDK）

**结论**：自研轻量传输层（v2 落地为 `@tillgate/ai` 独立库包，ADR-0006），不引入 Vercel AI SDK。理由与 v1 相同——本网关是「对外开放的中转站」，**wire 级透传是第一公民**；AI SDK 是生成式框架（解析重建请求），目标冲突：

1. **未知参数**：SDK 严格 schema 校验会丢弃未知参数，而契约要求未知参数原样透传（tools/tool_choice 等）；
2. **usage 完整性**：SDK 归一化 usage 会丢失缓存字段（`cached_tokens` / `cache_hit`），缓存计价直接失效；
3. **各家特有字段**（`reasoning_content` 等）需原样透传到客户端；
4. **流式控制面**：心跳注入、增量 SSE 扫描（usage 最后帧胜出）、空完成判定、错误帧捕获均为 wire 层操作，SDK 不提供；
5. v2 已验证的库形态：`createAi` facade + `onEvent` 观察面 + 逐块透传中继（旁路 SseScanner 扫描 usage），e2e 曾抓出流式结构性死锁并修复——边界经真实进程检验。

**v2 落地形态**（相对 v1 的结构化）：

- `protocol/` 协议族 wire 映射（claude / completions / gemini / responses / stream-convert）——codec 翻译函数单一真相，gateway 路由边界消费；
- `adapters/` 供应商适配（openai-compatible / anthropic / gemini / azure / bedrock / vertex / minimax / dashscope…）；SDK 依赖归 `ai` 拥有，重型 SDK 窄入口延迟加载；
- `transport/` 透传中继 + SSE 旁路扫描 + SSRF 硬门；
- `pipeline/` 单次尝试机制链（prepare / chat / chat-stream / stream-report / probe / generation-ops）；
- 数据面/观察面契约（重构方案 §3.6）：零处理透传 + 三种透传例外 + `onEvent` 旁路 + 零运维状态（熔断/死凭据在 `inference/health`）。

---

## 10. v2 结构治理与质量门禁（新增）

- **结构重构方案**：[project-structure-refactoring.md](./project-structure-refactoring.md) 是结构目标态唯一权威；根 `AGENTS.md` 是执行摘要与硬约束（铁律 17 条）；两者冲突以结构文档为准。
- **ADR 体系**：`docs/adr/NNNN-kebab-title.md`，编号递增，被推翻的决策标记 Superseded 不删除。在案十篇：0001 errors 注册表归属、0002 http 与 db 解耦、0003 wallet+ledger-core 合并入 billing、0004 上游 4xx 透传、0005 服务端部署产物策略、0006 `ai` 保留独立库包、0007 apps 装配与 `ai` 注入、0008 动态 RBAC、0009 端点绑定数据化、0010 上游出口信任模型。结构例外、包准入/合并、发布白名单变更必须先写 ADR 再动代码。
- **包边界门禁**：`scripts/check-package-boundaries.ts`（`bun run boundaries`，并前置进 `bun run test`）——① package graph 无环；② packages 不得依赖 apps；③ 跨包 import 只能命中显式 exports（禁 `@tillgate/x/src` 深导入）；④ 相对 import 不得越出 workspace 根；⑤ 根 tsconfig paths 不得把包名映射回源码绕过 exports。
- **四门**：typecheck / lint / test / build 全绿是任何变更的完成条件（覆盖率阈值只许补测试、禁止调低换绿）。
- **e2e/**：跨进程系统测试统一在根 `e2e/`（非 workspace 包），四个运行门——① 默认 mock 门（`bun run test:e2e`：mock 上游 + 全真 PG/Redis + 双形态进程冒烟 bun 源码 / node dist）；② 真上游 real 门（`E2E_REAL_UPSTREAM=1 bun run test:e2e:real`，花真钱显式 opt-in）；③ admin 管理面旅程门（`cd apps/admin-api && bun run test:e2e`）；④ 用户/跨 app/worker 旅程门（`e2e/client-journey`、`e2e/cross-app`、`e2e/billing-recovery` 各自 `bun x vitest run`，环境不可达整组 skip）。分组目录：`gateway` / `security` / `admin` / `client-journey` / `cross-app` / `billing-recovery`；每个测试文件独占隔离 schema（`tillgate_e2e_*`，结束 drop cascade）。
