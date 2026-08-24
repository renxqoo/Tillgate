# Monorepo 项目结构与独立发布重构方案

> 状态：P0–P5 已实施并逐单元核销（各包 MIGRATION.md 状态为证）；P6–P8（api-client/ui 公开化与发布自动化）未启动，按需执行  
> 更新日期：2026-08-23  
> 范围：根目录工程配置、`apps/`、`packages/`、共享测试配置与包发布边界

---

## 1. 结论

本仓库采用以下结构原则：

1. TypeScript、Vitest、Oxlint、Oxfmt 属于**仓库级工程配置**，直接放在根目录。
2. 不创建 `tooling/` workspace 包，也不为静态配置增加 `package.json`。
3. `apps/` 只放可部署应用，永不发布到 npm。
4. `packages/` 只放具有真实代码边界、可被复用和独立测试的模块。
5. 所有 workspace 默认私有；未来只开放少量明确面向外部消费者的包（当前候选：`api-client`、`ui`、`ai`）。
6. 是否进入 workspace、是否参与构建、是否发布，是三个独立决策，不互相绑定。
7. 迁移按**垂直用例**推进；同一用例始终只有一个生效实现，切换后立即删除旧路径，但不要求一个大能力在单次变更中整体搬完。
8. 事务由发起业务用例的 application 持有；跨能力的可靠事件必须在同一事务写入 outbox，公开 facade 不暴露 `DbTx`。
9. 内部包的 build 只服务仓库运行与部署，不强制生成声明文件；只有进入发布白名单的公开包必须产出并验证 `.d.ts` 与 tarball。

`tooling/` 不是错误结构，但在当前仓库中没有收益：配置数量少、只服务本仓库、不需要独立依赖和版本生命周期。将它包装成 package 会制造浅模块并污染 workspace 依赖图。

---

## 2. 当前状态判断

### 2.1 已经合理的部分

- 根目录已有 `tsconfig.base.json`、`tsconfig.next.json`、`.oxlintrc.json`、`.oxfmtrc.json` 和 `turbo.json`，位置正确。
- 根 `package.json` 为 `private: true`，可防止误发布整个仓库。
- 当前 `apps/*` 与 `packages/*` 均为 `private: true`，发布默认安全。
- workspace 只包含 `apps/*` 与 `packages/*`，没有把文档、脚本和配置误纳入依赖图。

### 2.2 需要逐步改善的部分

- 多个 Vitest 配置重复实现根 `.env` 读取、集成测试超时和排除规则，可在根目录提取共享配置函数，但不需要创建 package。
- `@tillgate/api-client` 直接导出 `src/*.ts`，没有独立构建产物，并依赖私有包 `@tillgate/http`，当前不能安全对外发布。
- `@tillgate/ui` 直接导出源码，并依赖私有 `@tillgate/api-client`；其 peer dependencies 较多，当前也不适合直接发布。
- 内部包和未来公开包目前使用同一种 `package.json` 模式，需要在真正发布前明确区分。
- 两个 Next app 的 TypeScript `paths` 直接映射到 `packages/ui/src/*` 与 `packages/api-client/src/*`（含 `@/server/*` 直连 `ui/src/server/*`），会绕过 package `exports`；边界门禁必须校验真实模块解析结果，而不只是扫描 import 文本。
- `apps/admin` 前端直接 import `@tillgate/ai` 与 `@tillgate/tracing`（链路图适配等约 6 处真实引用），绕过 `api-client` 消费后端能力包；`apps/worker` 直接依赖 `@tillgate/wallet` 执行对账。两处越界消费分别在 P4/P5 清除。
- 当前尚无 contract → OpenAPI → generated client 的可复现生成链；生成链建立前，手写 DTO 仍是现状，禁止同时维护两套事实源。
- 资金、身份、通知和 Provider 能力存在迁移期双事实或跨包事务问题，必须先按 §3.4 固化权威源，再移动实现。

### 2.3 结构审计证据

本方案不是按目录审美推导，而是基于当前引用关系（计数含多行 import，为手扫近似值；P0 建立的 `scripts/check-package-boundaries.ts` 持续扫描结果为准）：

- `admin-api` 对 `db/repository/service` 分别约有 50/41/29 处源码引用；`client-api` 约有 26/28/30 处；`gateway` 约有 61/38/39 处。app 已经穿透到横向分层内部，装配面过宽。
- `apps/worker` 直依赖 `@tillgate/wallet`（对账任务），是 §3.4 所列 wallet 对账/维护路径的入口之一；`apps/admin` 前端直依赖 `@tillgate/ai`、`@tillgate/tracing`。
- 跨包 `@tillgate/*/src` 深导入当前为 0 处；admin-api/client-api 已有正则文本型 `architecture.test.ts` 门禁，是 §5.5 真实模块解析门禁的现有基础。
- `domain/service/repository/wallet` 合计约 25k 行，修改一个计费用例经常跨四个一级 package；这些模块按资金能力高度共同变化，适合收敛到 `billing` 深模块。
- `ai` 已约 9k 行且 gateway 仍保留 pipeline/routing/quote 等同族逻辑，适合合并为 `inference` facade，而不是继续增加桥接层。
- `identity-core` 与 `identity` 分别承担状态安全事实和会话/适配，两者共同构成完整身份能力，合并后用子入口控制依赖比维持双包更清楚。
- 通知能力已横跨 admin CRUD、outbox repository、worker 并发认领和 webhook/SMTP 投递，具有独立状态机和外部副作用，足以成为 `notifications` 深模块。
- 当前 `ui` 约 9.7k 行、`api-client` 被两个前端大量消费，二者有真实复用价值；但必须解除彼此和 Next 私有实现耦合后才能成为发布产品。
- `ai` 已是零内部依赖的库形态：`createAi` facade、`onEvent` 监听面、逐块透传中继（旁路 SseScanner 扫描 usage）均为现状实现。它不是待合并的半成品，而是已验证的库边界；需要迁入 `inference` 的是 gateway 侧的候选循环、路由与计费衔接，不是 `ai` 本体。

---

## 3. 最终目录结构

下面是**重构完成后的目标态**，不是当前仓库快照。每个 app/package 根目录统一包含
`package.json`、`tsconfig.json`、`vitest.config.ts`（无测试配置需求时可省略）；树中重点展开代码职责。

```text
tillgate/
├── apps/                                  # 可独立部署的进程，全部 private
│   ├── gateway/                           # OpenAI/模型推理公网入口
│   │   ├── src/
│   │   │   ├── index.ts                   # 进程启动
│   │   │   ├── config.ts                  # gateway 配置 schema
│   │   │   ├── assembly.ts                # 唯一依赖装配根
│   │   │   ├── app.ts                     # 创建 Hono app
│   │   │   ├── http/
│   │   │   │   ├── contracts/             # OpenAI/generation wire schema，gateway 自有
│   │   │   │   ├── routes/                # chat/responses/generation/models/oauth
│   │   │   │   ├── middleware/            # auth/rate-limit/request/security
│   │   │   │   ├── openai-error-face.ts
│   │   │   │   └── openai-envelope.ts
│   │   │   └── shutdown.ts
│   │   └── test/{contract,integration}/    # 跨进程 E2E 统一在根 e2e/
│   │
│   ├── worker/                            # 后台任务、调度、生命周期
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── config.ts
│   │   │   ├── assembly.ts
│   │   │   ├── bridge-mappers.ts         # worker↔billing/渠道路由事件的纯映射（装配体积收敛）
│   │   │   ├── scheduler.ts
│   │   │   ├── jobs/                      # settlement/poll/reconcile/notify/partition
│   │   │   ├── wakeup/postgres-notify.ts
│   │   │   ├── health.ts
│   │   │   └── shutdown.ts
│   │   └── test/
│   │
│   ├── client-api/                        # 用户控制台 REST API
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── config.ts
│   │   │   ├── assembly.ts
│   │   │   ├── app.ts
│   │   │   ├── http/
│   │   │   │   ├── contracts/             # 用户 API 请求/响应 schema，API 自有
│   │   │   │   ├── routes/                # auth/me/keys/org/wallet/subscription/payment
│   │   │   │   ├── middleware/            # session/request-id/security
│   │   │   │   ├── presenters/
│   │   │   │   └── error-face.ts
│   │   │   └── shutdown.ts
│   │   └── test/{contract,integration}/
│   │
│   ├── admin-api/                         # 管理控制面 REST API
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── config.ts
│   │   │   ├── assembly.ts
│   │   │   ├── app.ts
│   │   │   ├── http/
│   │   │   │   ├── contracts/             # 管理 API 请求/响应 schema，API 自有
│   │   │   │   ├── routes/                # users/providers/channels/models/billing/tracing
│   │   │   │   ├── middleware/
│   │   │   │   ├── presenters/
│   │   │   │   └── error-face.ts
│   │   │   └── shutdown.ts
│   │   └── test/{contract,integration}/
│   │
│   ├── trace-receiver/                    # OTLP 接收部署单元
│   │   ├── src/{index,config,assembly,app}.ts
│   │   └── test/
│   │
│   ├── client/                            # Next.js 用户控制台
│   │   ├── src/
│   │   │   ├── app/                       # 路由与页面装配
│   │   │   ├── features/                  # auth/wallet/subscription/org/usage
│   │   │   ├── server/                    # BFF adapters 与 server actions
│   │   │   └── config/
│   │   └── test/
│   │
│   └── admin/                             # Next.js 管理后台
│       ├── src/
│       │   ├── app/
│       │   ├── features/                  # users/channels/models/billing/tracing
│       │   ├── server/
│       │   └── config/
│       └── test/
│
├── packages/                              # 深能力模块，扁平 workspace
│   ├── errors/                            # 内部错误根契约；零业务/协议依赖
│   │   ├── src/
│   │   │   ├── nature.ts
│   │   │   ├── category.ts
│   │   │   ├── definition.ts
│   │   │   ├── error-record.ts
│   │   │   ├── normalize.ts
│   │   │   ├── guards.ts
│   │   │   └── index.ts
│   │   └── test/
│   │
│   ├── runtime/                           # 仅服务端运行时基础设施
│   │   ├── src/
│   │   │   ├── config/
│   │   │   ├── logging/
│   │   │   ├── crypto/
│   │   │   ├── redis/
│   │   │   ├── lifecycle/
│   │   │   ├── testing/
│   │   │   └── index.ts
│   │   └── test/
│   │
│   ├── db/                                # DB 连接、schema、迁移；不放业务用例
│   │   ├── src/
│   │   │   ├── client.ts
│   │   │   ├── context.ts
│   │   │   ├── transaction.ts
│   │   │   ├── pg-error.ts
│   │   │   ├── schema/                    # identity/accounts/billing/inference/...
│   │   │   └── index.ts
│   │   ├── migrations/
│   │   ├── seeds/
│   │   └── test/
│   │
│   ├── http/                              # 纯 HTTP/Hono 基础工具；不拥有 wire schema
│   │   ├── src/
│   │   │   ├── errors/                    # category defaults/renderer/localization/handler
│   │   │   ├── validation/
│   │   │   ├── pagination/
│   │   │   ├── network/
│   │   │   ├── request-context/
│   │   │   ├── idempotency/
│   │   │   ├── security/
│   │   │   └── index.ts
│   │   └── test/
│   │
│   ├── identity/                          # 身份认证完整能力
│   │   ├── src/
│   │   │   ├── domain/                    # credential/challenge/session/mfa/errors
│   │   │   ├── application/               # register/authenticate/verify/oauth
│   │   │   ├── ports/                     # stores/mailer/captcha/clock
│   │   │   ├── adapters/                  # postgres/jwt/redis/smtp/turnstile（无 Hono）
│   │   │   ├── identity.ts                # createIdentity facade
│   │   │   └── index.ts
│   │   └── test/{contract,postgres,security}/
│   │
│   ├── accounts/                          # 用户、租户、API Key 与应用
│   │   ├── src/
│   │   │   ├── domain/                    # user/org/api-key/application/referral
│   │   │   ├── application/               # 对应业务用例
│   │   │   ├── ports/                     # account-store/identity/wallet-credit
│   │   │   ├── adapters/postgres/
│   │   │   ├── accounts.ts                # createAccounts facade
│   │   │   └── index.ts
│   │   └── test/
│   │
│   ├── billing/                           # 唯一资金与计费事实源
│   │   ├── src/
│   │   │   ├── domain/                    # money/wallet/ledger/rating/subscription
│   │   │   ├── application/
│   │   │   │   ├── wallet/                # credit/authorize/settle/release/refund
│   │   │   │   ├── billing/
│   │   │   │   ├── subscriptions/
│   │   │   │   ├── payments/
│   │   │   │   ├── redemption/
│   │   │   │   └── settlement/
│   │   │   ├── ports/                     # payment/wakeup/notification/clock
│   │   │   ├── adapters/                  # postgres/stripe/epay/pg-notify
│   │   │   ├── billing.ts                 # createBilling facade
│   │   │   ├── wallet.ts                  # 可选窄子入口
│   │   │   ├── settlement.ts
│   │   │   └── index.ts
│   │   └── test/{contract,concurrency,idempotency,recovery,postgres}/
│   │
│   ├── ai/                                # 上游协议库（第三发布候选；零内部依赖，§3.6 契约）
│   │   ├── src/
│   │   │   ├── protocol/                  # 协议族 wire 映射（claude/completions/gemini/responses/stream-convert）
│   │   │   ├── adapters/                  # openai-compatible/anthropic/gemini/azure/bedrock/vertex/minimax/dashscope…
│   │   │   ├── transport/                 # 透传中继/SSE 旁路扫描/SSRF 硬门
│   │   │   ├── pipeline/                  # 单次尝试机制链（prepare/chat/chat-stream/stream-report/probe/generation-ops）
│   │   │   ├── usage/                     # usage 归一（事件数据；计费决策在 billing）
│   │   │   ├── retry/                     # 请求内退避重试（无跨请求状态）
│   │   │   ├── registry/                  # 协议适配注册表（装配期配置，非运行状态）
│   │   │   ├── errors/                    # 协议错误归一
│   │   │   ├── events.ts                  # AiEvent 观察面（onEvent 监听，铁律 12）
│   │   │   ├── create-ai.ts               # createAi facade
│   │   │   └── index.ts
│   │   └── test/{contract,protocol,relay,latency}/
│   │
│   ├── inference/                         # 推理用例、路由候选循环、计费衔接与故障转移
│   │   ├── src/
│   │   │   ├── domain/                    # model/routing/usage/errors
│   │   │   ├── application/               # chat/stream/generation/quote/failover
│   │   │   ├── health/                    # 渠道熔断/死凭据（订阅 AiEvent 的跨请求状态，供路由消费）
│   │   │   ├── ports/                     # billing/catalog/state/upstream
│   │   │   ├── adapters/                  # upstream（封装 ai：渠道快照+凭据注入）/redis/http
│   │   │   ├── inference.ts               # createInference facade
│   │   │   └── index.ts
│   │   └── test/{contract,streaming,failover,routing}/
│   │
│   ├── control-plane/                     # 管理员、模型、渠道、费率与供应商管理
│   │   ├── src/
│   │   │   ├── domain/                    # admin/provider/channel/model/rate-card/catalog
│   │   │   ├── application/               # admins/providers/channels/models/rates/fx
│   │   │   ├── ports/                     # capabilities/probe/cache/secret-cipher
│   │   │   ├── adapters/                  # postgres/model-sources
│   │   │   ├── control-plane.ts
│   │   │   └── index.ts
│   │   └── test/
│   │
│   ├── notifications/                     # 通知、模板与 outbox
│   │   ├── src/
│   │   │   ├── domain/
│   │   │   ├── application/               # enqueue/claim/dispatch
│   │   │   ├── ports/                     # email/webhook
│   │   │   ├── adapters/                  # postgres/smtp/webhook
│   │   │   ├── templates/
│   │   │   ├── notifications.ts
│   │   │   └── index.ts
│   │   └── test/
│   │
│   ├── observability/                     # OTel、trace、audit、request log
│   │   ├── src/
│   │   │   ├── telemetry/
│   │   │   ├── tracing/                   # decode/ingest/store/graph/partition
│   │   │   ├── audit/
│   │   │   ├── request-log/
│   │   │   ├── adapters/postgres/
│   │   │   └── index.ts
│   │   └── test/
│   │
│   ├── api-client/                        # 未来可独立发布的第一候选
│   │   ├── src/
│   │   │   ├── core/                      # 框架无关 client/error/transport
│   │   │   ├── generated/                 # 由 OpenAPI 生成，禁止手改
│   │   │   │   ├── client-api/
│   │   │   │   └── admin-api/
│   │   │   ├── client-api.ts
│   │   │   ├── admin-api.ts
│   │   │   ├── next/                      # 可选 ./next 子入口
│   │   │   │   ├── session.ts
│   │   │   │   ├── locale.ts
│   │   │   │   └── forwarded-ip.ts
│   │   │   └── index.ts                   # 根入口不得 import next/
│   │   └── test/{core,next,pack}/
│   │
│   └── ui/                                # 纯 React 设计系统；第二发布候选
│       ├── src/
│       │   ├── components/                # primitives/forms/data/navigation/feedback
│       │   ├── hooks/
│       │   ├── formatting/                # money/date/number
│       │   ├── styles/
│       │   └── index.ts                   # 禁止 Next 专有依赖
│       └── test/{unit,render,pack}/
│
├── e2e/                                   # 跨进程系统测试，不是 workspace 包
│   ├── gateway/
│   ├── client-journey/
│   ├── admin-journey/
│   ├── billing-recovery/
│   └── security/
│
├── generated/                             # 机器生成，禁止手改
│   ├── openapi/
│   │   ├── client-api.json
│   │   ├── admin-api.json
│   │   └── gateway.json
│   └── api-client/                        # api-client 生成中间产物
│
├── scripts/                               # 仓库自动化，不是 workspace 包
│   ├── generate-openapi.ts
│   ├── generate-api-client.ts
│   ├── generate-error-docs.ts
│   ├── check-package-boundaries.ts
│   ├── check-contract-compatibility.ts
│   ├── migrate.ts
│   └── seed.ts
│
├── docs/
│   ├── architecture/                      # overview/dependencies/errors/domains
│   ├── adr/                               # 架构决策记录
│   ├── api/
│   ├── operations/
│   └── security/
│
├── docker/
├── package.json                           # workspace 根，永远 private
├── bun.lock
├── turbo.json
├── tsconfig.json                          # 可选 solution/project references 入口
├── tsconfig.base.json                     # 全仓 TS 严格基线
├── tsconfig.server.json                   # 服务端公共差异
├── tsconfig.next.json                     # Next.js 公共差异
├── vitest.shared.ts                       # 仅共享确定相同的测试逻辑
├── vitest.config.ts                       # 可选：test.projects 统一入口
├── .oxlintrc.json
├── .oxfmtrc.json
├── .env.example
├── AGENTS.md
└── README.md
```

### 3.1 最终 package 集合

| 分类 | packages | 发布策略 |
|---|---|---|
| 根契约 | `errors` | 永远私有 |
| 基础设施 | `runtime`、`db`、`http` | 永远私有 |
| 上游协议库 | `ai` | 私有；第三发布候选 |
| 业务能力 | `identity`、`accounts`、`billing`、`inference`、`control-plane`、`notifications` | 永远私有 |
| 可观测 | `observability` | 永远私有 |
| 外部产品候选 | `api-client`、`ui`、`ai` | 按需独立发布零至三个 |

当前候选集合共 14 个 package，但数量不是验收目标。每个包都必须通过 §4 的准入标准；迁移后没有独立边界的候选必须合并，新增候选也必须重新通过准入评审。

每个包存在的理由和禁止范围如下：

| package | 隐藏的复杂度 | 禁止进入 |
|---|---|---|
| `errors` | 跨层错误性质、分类和诊断上下文；稳定零依赖叶子 | HTTP status、业务注册表、框架代码 |
| `runtime` | 配置、日志、Redis、加密和进程生命周期的初始化/关闭 | 业务规则、业务 SQL、HTTP route |
| `db` | 连接、事务句柄、schema、迁移和 PG 基础分类 | Repository CRUD、业务用例、Domain 实体 |
| `http` | Hono 无关/通用的请求上下文、安全、分页和错误渲染 | DB 查询、具体业务错误映射、应用路由 |
| `identity` | 凭据、挑战、MFA、OAuth、JWT 和会话吊销 | Hono middleware、用户资料、计费逻辑 |
| `accounts` | 用户、组织、API Key、Application、邀请/推荐关系 | 登录凭据、钱包账本、HTTP DTO |
| `billing` | 金额、钱包、双分录、计价、订阅、支付、结算和恢复 | HTTP/队列协议、模型上游传输 |
| `inference` | 渠道候选循环、路由决策、quote 与计费衔接、生成任务用例、故障转移 | 渠道管理 CRUD、账本实现、HTTP route、供应商协议细节 |
| `ai` | 上游协议注册表、透传中继、多模态/参数抹平、单次尝试机制链、渠道内重试、`onEvent` 观察面 | 业务路由与计费决策、渠道候选循环、HTTP route |
| `control-plane` | 管理员资料/授权策略及 Provider/Channel/Model/RateCard 的配置与目录快照 | 登录凭据、推理执行管线、管理端页面 DTO |
| `notifications` | 通知渠道、事务 outbox、认领、重试和投递 | 具体业务触发规则、管理端 route |
| `observability` | OTel、trace ingest/query、审计与保留策略 | 业务决策、基础 logger 初始化 |
| `api-client` | 框架无关 transport、生成类型、错误和分页客户端 | 私有 workspace 运行时依赖、默认 Next 依赖 |
| `ui` | 纯 React 设计系统、样式与展示组件 | api-client、Next Router/Font/Server Action、业务取数 |

其中 `errors` 虽然实现不大，仍值得独立：它是为切断依赖环而存在的稳定叶子契约，不是为了隐藏大量代码。其接口必须极小且多年稳定。

### 3.2 当前包到目标包的迁移映射

| 当前 package | 目标归属 |
|---|---|
| `core` | `runtime` + `observability` |
| `db` | 保留名称，收窄为连接、事务、schema、迁移与 PG 基础能力 |
| `domain`、`service`、`repository` | 按业务归属迁入 `accounts`、`billing`、`inference`、`control-plane`、`notifications` |
| `wallet`、`ledger-core` | `billing` |
| 空 `money` 目录 | 删除；它不是 workspace package，金额唯一归 `billing/domain/money` |
| `ai` | 保留为独立库包：零业务依赖的透传中继 + 协议适配 + `onEvent` 观察面（§3.6）；路由/计费/故障转移语义，以及现以注入存储形式住在 `ai` 内的渠道健康状态（熔断、死凭据）迁入 `inference`，`inference` 单向依赖 `ai` |
| `identity`、`identity-core` | `identity` |
| `tracing` | `observability` |
| `http` | 保留名称，移除 DB/业务/wire schema 后成为纯 HTTP/Hono 基础工具包 |
| `api-client` | 保留名称，拆成框架无关根入口与可选 `./next` 入口 |
| `ui` | 保留名称，Next 专有能力迁回 app 或独立适配层 |

这是**按垂直用例逐个切换**的迁移，不允许先建立目标空目录再慢慢填充。一个用例的 facade、实现、测试和调用方切换后，必须在同一阶段删除该用例的旧位置；同一用例不得保留兼容转发或双实现。尚未迁移的其他用例可以继续留在旧包，直到轮到自己的原子切换。

### 3.3 结构说明

- 不为了视觉分类把现有包嵌套成 `packages/backend/*`、`packages/frontend/*`。当前扁平结构路径短、workspace 配置简单，更利于工具与开发者定位。
- `tsconfig.server.json`、`vitest.shared.ts` 都按实际重复出现后再创建，不预建空壳；需要统一测试入口时使用根 `vitest.config.ts` 的 `test.projects`，不新增 `vitest.workspace.ts`。
- `errors` 延续旧仓 `error-system-design.md`（v1 定稿，位于 `ai-getway` 仓）的三性/category 根契约；
  注册表归属调整已裁决于 [ADR-0001](./adr/0001-errors-registry-ownership.md)：`http` 只提供 category
  默认渲染，业务错误定义由各能力包拥有、在 app face 装配，避免 `http` 反向认识全部业务。
- Wire contract 由提供接口的 app 所有，分别生成 OpenAPI，再生成 `api-client`；不建立集中式 `contracts` 类型仓库。
- `db` 只拥有连接、事务、schema 和迁移；业务 SQL 属于各能力包的 `adapters/postgres`。
- 能力包基础方向为 `domain ← application`；只有真实 I/O、外部服务、可替换实现或需要依赖倒置时才增加
  `ports ← adapters`。禁止为了目录对称给每个类创建 interface/adapter。
- app 的 `assembly.ts` 是唯一进程装配根；能力包根入口只公开 `createXxx` facade 和少量稳定契约。确需由 app 装配的 adapter 工厂只能从显式 `./composition` 子入口导出，业务调用方不得引用该子入口。

### 3.4 状态事实、词表与副作用归属

目标边界实施前，先固化以下单一事实源。迁移 PR 必须同时删除旧事实源或明确其只读、冻结用途：

| 事实/能力 | 唯一所有者 | 迁移纪律 |
|---|---|---|
| 钱包余额、冻结、交易腿、授权、计费请求、结算与恢复 | `billing` | 先建立当前 `service/repository/db` 写路径与 `wallet` 对账/维护路径的语义差异清单；生产写入、schema、迁移和不变量测试逐项指定权威实现，禁止直接拼接两套实现 |
| 用户与管理员凭据、挑战、OAuth、MFA、会话吊销 | `identity` | `users/admins.password_hash` 与 identity-core 凭据表不得长期双写；切换前给出数据审计、迁移、回滚和会话失效策略 |
| 用户、组织、API Key、Application、邀请与推荐 | `accounts` | 只保存资料与账户关系，不保存认证秘密 |
| 管理员资料、状态、角色与控制面授权策略 | `control-plane` | 管理员登录凭据与 MFA 仍由 `identity` 按 admin realm 管理 |
| Provider/Channel/Model/RateCard 配置与只读目录快照 | `control-plane` | 不拥有可执行上游 adapter；费率变更必须产生可审计版本，billing 保存实际采用的报价/费率快照 |
| 可执行协议、vendor 能力与上游 adapter 注册表 | `ai`（库本体），`inference` 经依赖消费 | control-plane 通过装配注入的能力校验器验证配置，不直接 import `ai` 实现或复制协议词表 |
| 通知渠道、outbox、认领、重试与投递结果 | `notifications` | 业务能力拥有“何时触发及 payload”语义；需要可靠投递的事件必须与业务状态同事务入箱 |
| 审计事实的存储、查询与保留 | `observability` | 业务能力拥有 audit action 与 payload 语义，通过 port 发出；安全、权限和资金审计不得降级为提交后 best-effort |

`db` 是物理 schema、迁移顺序和事务基础设施的统一登记点，不是业务事实所有者。能力语义变化若需要 DDL，能力实现与 `db` schema/migration 必须在同一迁移单元提交和验证；禁止 `db` 反向依赖业务包获取表定义。

### 3.5 ADR 与文档治理

- 本文档是结构目标态的唯一权威，根 `AGENTS.md` 是其执行摘要与硬约束；两者冲突时以本文档为准，并在同一变更中同步修订 AGENTS.md，禁止规则分叉。
- 结构例外、包准入/合并、`*-protocol` 与插件化升格、发布白名单变更，必须先写 ADR 再动代码；被推翻的决策标记 Superseded 而不删除。
- ADR 命名 `docs/adr/NNNN-kebab-title.md`，编号递增；模板至少含：背景、决策、备选方案与取舍、影响。
- 必需 ADR 清单（缺失不得启动对应阶段）：
  1. `wallet + ledger-core → billing` 合并取舍：明确牺牲 wallet 自述的「业务无关、可整目录拎出独立仓」特性换取资金能力内聚（P4 资金波启动前）。
  2. `errors` 注册表归属：确认 §3.3 相对 error-system-design.md 的调整——`http` 只提供 category 默认渲染，业务错误定义归能力包、app face 装配（P3 启动前）。
  3. 存量违规解耦路径：`db → ledger-core`、`http → db` 的清除顺序与过渡形态（P3 内）。
  4. 服务端部署产物策略：bundle / external + 裁剪 dist / 完整 workspace runtime（§8 已预留，P3 明确内部 build 时）。
  5. `ai` 保留为独立库包：推翻初版"并入 inference"映射的裁决存档——依据是零内部依赖、`onEvent` 观察面与逐块透传中继均已实现并验证（§2.3、§3.6），并入会把已验证的库边界降级为目录边界（P4 启动前补档）。

### 3.6 `ai` 的数据面/观察面契约

`ai` 是零业务依赖的上游协议库，以下原则为硬约束，由架构测试与延迟测试强制：

- **数据面零处理透传**：上游 chunk 逐块直通 C 端（`pipeThrough`、不缓冲、不解析改写）；心跳注入与静默超时是保护性注入，不是业务处理。禁止"先收完再转发"或逐帧改写——C 端 TTFB 与流速不得被网关自身处理拖慢。触碰"不改写"的仅有下方透传例外清单三种情形，新增例外必须走 ADR。
- **透传例外清单**（触碰"不改写"的仅有三种情形）：
  1. **跨协议最小必要转换**：非 openai-compatible 上游的请求体、响应流与**错误体**做协议族转换（OpenAI ↔ claude/gemini/responses…）；同协议上游零转换直通。请求侧已转换（adapter）、响应流已转换（stream-convert），错误体是响应的一部分，必须同规则。
  2. **响应侧 model 字段替换**（可配置开关）：SSE 帧内仅替换 `"model"` 字段值为对外目录模型名，其余字节不动，不引入缓冲；与请求侧 adapter 的模型名重写（finalizeRequestBody）共同维护模型目录抽象，防止上游报错/响应暴露真实部署模型名。
  3. **错误出站三层**：**结构层**翻译为 OpenAI 错误信封——那是 C 端协议的母语，跨协议上游错误形状不同无法直通；**内容层**保留上游原文、仅脱敏（剥内部寻址、真实模型名替换为对外名、长度截断），不编造友好消息；**细节层**（内部端点、堆栈、真实模型名）只进日志关联 requestId，不进响应体。网关自生错误（余额不足、平台限流等）经 app 层 error-face 用同一信封表达；上游错误对外层用 502/504 网关语义（候选循环后表达整次请求的失败，不透传单一上游状态码）——该句适用于 5xx/网络类上游错误；上游 4xx 属客户端错误定位，原码 + 脱敏 message 透传（[ADR-0004](./adr/0004-upstream-4xx-passthrough.md)）。
- **观察面只经监听方法**：计费取证（usage 捕获）、审计、trace 一律通过 `onEvent` 订阅 `AiEvent` 消费；旁路扫描器与监听回调都是 fire-and-forget，不阻塞数据面，回调异常不得反噬透传。
- **零运维状态**：`ai` 不持有业务/运维语义的跨请求状态——渠道熔断、死凭据、健康统计由 `inference` 作为 `AiEvent` 订阅者维护（与计费/审计/trace 同为观察者），供其路由候选循环消费。`ai` 内只允许请求内状态（退避重试）、装配期配置（协议注册表）与传输层机制状态（连接复用）。
- **可靠性边界**：观察 tap 不承载资金事实的最终性。usage 丢失或流中断时账务进入 uncertain，由 `billing` 的状态机、恢复与对账路径兜底（§5.4）；禁止以"把计费塞进热路径同步结算"换取确定性。
- **消费关系**：`inference` 是 `ai` 的唯一运行时装配消费方（叠加候选循环、路由、quote 与计费衔接）；迁移完成后 `apps` 运行时代码不直接 import `ai`，由 `inference` facade 内部持有；测试与脚本可直接使用。

---

## 4. 目录与包的准入标准

### 4.1 必须进入 `apps/` 的代码

满足任意一项即属于应用：

- 拥有进程入口、端口、定时循环或部署单元；
- 负责环境变量读取和依赖装配；
- 只服务一个部署面，且没有稳定的跨应用复用契约。

应用可以依赖 packages，packages 禁止反向依赖 apps。

### 4.2 可以进入 `packages/` 的代码

一个新包至少应同时满足：

1. 有清晰、稳定且小于实现复杂度的公共接口；
2. 隐藏了值得独立测试或复用的实现复杂度；
3. 有明确依赖方向，不需要循环依赖；
4. 能说明消费者、所有者和变更原因；
5. 能独立通过 typecheck、lint 和 test；需要运行产物时还能独立 build。

满足上述准入条件后，再按以下优先级说明“为什么必须成为 package”：

1. **独立生命周期**：需要独立安装、版本化、发布或由不同团队承担兼容性责任；
2. **运行时与依赖所有权**：拥有一组只能由该能力加载、升级和治理的运行时依赖；
3. **公共兼容契约**：存在多个真实消费者，需要冻结小而稳定的协议或 SDK 接口；
4. **跨应用共享的深能力**：至少两个真实消费者通过小接口复用一组明显更复杂的实现；
5. **依赖图治理**：作为稳定叶子或窄契约切断实际存在的循环、反向依赖或跨运行时耦合。

代码量、目录数量和文件数量都不是分包依据。大实现可以保留为一个深 package；小契约只有在确实切断依赖环、
稳定多个消费者或承担公共兼容责任时才值得独立。

以下理由单独存在时，不足以创建包：

- 只是想少写相对路径；
- 只有常量、类型或几个转发函数；
- 只是把一个大目录机械拆小；
- 只是共享 TypeScript、Vitest、Oxlint 或 Oxfmt 配置；
- 暂时猜测未来可能复用，但当前没有第二个消费者。

### 4.3 应留在根目录的内容

- 编译、检查、格式化、测试和任务编排配置；
- workspace 与包管理器配置；
- 全仓环境变量示例；
- 贡献、发布、安全和架构规范。

根配置使用工具默认可发现的命名，避免每个命令额外传入配置路径。

### 4.4 独立协议包的严格例外

默认规则不变：HTTP wire schema 由提供接口的 app 所有，分别生成 OpenAPI，再生成客户端；禁止建立聚合
`auth/account/billing/admin/gateway` 的中央 `contracts` 包。

只有同时满足以下条件，才允许建立单一用途的 `*-protocol` 包：

1. 只描述一个边界清晰的协议，不聚合多个应用或业务域的 DTO；
2. 已有至少两个真实消费者，且消费者跨部署单元、跨仓库或跨语言运行时；
3. 需要运行时 schema 校验、frame guard、版本协商或语言中立的 schema 产物；
4. 协议需要独立版本、发布和向后兼容承诺；
5. 包内不包含业务实体、业务用例、数据库模型或应用装配逻辑。

满足条件时，协议包与参考客户端仍应分开：`*-client → *-protocol`，协议包不得反向依赖客户端。
当前 gateway/client/admin 三个 HTTP API 都继续采用 app-owned contract + OpenAPI 生成链路；是否有单一协议在未来
满足该例外，必须按真实外部消费者重新评审，不能因为已有 schema 就自动升格为 package。

### 4.5 Provider 与插件化准入

当前 Provider 是 `ai` 库的内部上游适配器，不是一组独立 workspace package：

```text
packages/ai/src/
  protocol/            # 协议族 wire 映射（claude-chat / completions / gemini / responses / stream-convert）
  adapters/            # openai-compatible / anthropic / gemini / azure / bedrock / vertex / minimax / dashscope …
  transport/           # 透传中继 / SSE 旁路扫描 / SSRF 硬门
  pipeline/            # 单次尝试机制链（prepare / chat / chat-stream / stream-report / probe / generation-ops）
```

- Provider SDK、传输、payload/usage 映射和供应商错误归一只允许进入 `ai` 对应 adapter；`ai` 的机制链与 `inference` 的 domain/application 都不直接 import 供应商 SDK。
- 供应商运行时依赖由 `ai` 拥有；可选且体积较大的 SDK 使用窄入口和延迟加载，避免进入 `createAi` 热路径。
- Provider 的渠道、凭据引用、模型目录和费率配置由 `control-plane` 管理，并以只读快照/facade 提供给 inference；
  inference 不反向承担管理 CRUD。
- 不因 Provider 数量增加、目录变大或猜测未来生态而创建 `packages/provider-*`、`plugin-sdk` 或 `extensions/*`。

只有同时出现以下事实，才启动插件架构 ADR：外部开发者需要接入、插件可独立安装/卸载、拥有独立依赖与版本、
宿主与插件需要稳定兼容协议，并且至少有两个真实插件实现。ADR 通过后才允许引入
`extensions/providers/*`、窄 `plugin-sdk` 和 manifest；插件生产代码只能经过 SDK/manifest 跨越宿主边界，
不得深度导入核心或其他插件实现。

### 4.6 包的退出与合并机制

package 不是永久编制。架构审计或迁移完成后，出现任一情况应优先合并回最接近的能力包：

- 长期只有一个消费者，且没有独立发布、跨运行时或切环责任；
- 公共接口主要是类型转发、barrel 或对内部实现的一一映射；
- 接口复杂度接近实现复杂度，没有隐藏值得独立测试的行为；
- 两个包总是一起修改、一起发布，测试也必须成对运行；
- 为维持拆分而持续增加桥接包、兼容 facade 或重复 DTO。

合并时用新的边界测试替换针对浅转发层的测试，并在同一阶段删除旧 package、exports 和依赖，禁止长期双轨。

---

## 5. 依赖方向

目标结构采用能力包内六边形边界，跨包编译依赖保持单向：

```text
apps/*（assembly） ─────────────── http / runtime / observability
        │
        ├──── capability facades
        │       identity / accounts / billing / inference /
        │       control-plane / notifications
        │                 │
        │                 ├── errors
        │                 └── adapters ──→ db / runtime
        │
        ├──── inference ──→ ai（上游协议库：透传中继 + 协议适配 + onEvent 观察面，零内部依赖）
        │
        └──── composition-only adapters/bridges

能力包内部：
domain ← application →（按需 ports ← adapters）

协议生成：
apps/*/http/contracts → generated/openapi → api-client/generated
```

硬约束：

- `apps/* → packages/*`，禁止 `packages/* → apps/*`。
- `errors` 零内部依赖；wire contract 归提供接口的 app，不 import 业务内部类型。
- `ai` 零内部依赖（永久叶子），运行时仅被 `inference` 单向依赖，遵守 §3.6 数据面/观察面契约。
- 能力包的 domain 不依赖 db、HTTP、Redis、框架或 adapters。
- application 只依赖本包 domain/ports 与 §5.2 批准的单向能力 facade，不直接 import PostgreSQL、Redis、Hono、供应商 SDK。
- ports/adapters 只用于 I/O、第三方、可替换实现或依赖倒置；纯进程内且单一实现的计算直接依赖窄 facade，禁止接口仪式化。
- adapters 实现 ports，可以依赖 `db`、`runtime` 和外部 SDK；默认隐藏在能力包内。必须由 app 连接的跨能力 bridge 或外部 adapter 只能从 `./composition` 子入口导出，装配只发生在 app 的 `assembly.ts`。
- 能力包之间默认依赖窄 facade；出现循环风险、远程部署或确需替换时，由消费方定义 port、在 app 注入实现。
- `db` 不依赖任何业务能力包；`http` 不依赖 db 或具体业务包。
- `runtime` 不依赖 `observability`，`observability` 可以依赖 runtime/db，防止基础设施环。
- 包间禁止循环依赖。
- 公开发布 API 不得泄漏任何私有包的类型；内部 facade 也不得泄漏 adapter、`Db`、`DbTx` 或供应商 SDK 类型。
- barrel 文件只暴露有意维护的公共接口，禁止把整个内部目录全部导出。
- 跨包引用只走目标包的 `exports`，禁止 `@tillgate/x/src/...` 深层导入。

当两个包总是一起修改、接口几乎等于实现、拆开后测试仍必须成对运行时，应优先合并为更深的模块，而不是继续增加桥接包。

### 5.1 包级依赖白名单

| 调用方 | 允许直接依赖 | 说明 |
|---|---|---|
| `apps/*` | 能力 facade、`http`、`runtime`、`observability`；assembly 可用 `./composition` | 非装配代码禁止引用 composition 子入口 |
| `errors` | 无内部 package | 永久叶子 |
| `ai` | 无内部 package | 永久叶子；上游协议库，被 `inference` 单向依赖（§3.6） |
| `runtime` | `errors` | 不反向依赖 observability |
| `db` | `errors` | logger/clock 通过参数注入，避免依赖 runtime |
| `http` | `errors` | 不依赖 db 和业务能力 |
| 业务能力 domain | `errors` + 纯计算依赖 | 禁止框架与 I/O |
| 业务能力 application | 本包 domain/ports；经批准的单向能力 facade | 可靠跨能力事件、循环风险或替换需求使用消费方 port |
| 业务能力 adapters | 本包 application/ports、`db`、`runtime`、外部 SDK | 不从根 `index.ts` 导出具体 adapter |
| `observability` | `errors`、`runtime`、`db` | runtime 不得反向引用 |
| `api-client` | 公共第三方依赖、生成产物 | 禁止依赖任何私有 `@tillgate/*` 运行时包 |
| `ui` | React 及展示型 peer dependencies | 禁止依赖 api-client；数据通过 props/callback 注入 |

例外必须写 ADR，并增加架构测试；不能只在评审口头约定。

### 5.2 业务能力依赖

```text
同步 facade 调用：
accounts ──────→ identity
    └──────────→ billing（开户赠送/推荐奖励等显式用例）

inference ─────→ control-plane（只读目录 facade）
    └──────────→ billing（quote/authorize/signal）
    └──────────→ ai（上游协议库，非业务能力；库依赖而非能力 facade）

可靠事件（消费方 port，经 assembly bridge 写入 notifications outbox）：
accounts ──────⇢ notifications
billing ───────⇢ notifications
control-plane ─⇢ notifications

notifications、identity 不反向依赖上述业务能力
```

上图实线表示允许的直接编译依赖，虚线表示逻辑事件流，不表示业务能力包直接 import `notifications`。

防环规则：

- `billing` 只接收 `userId/accountId/apiKeyId` 等标识，不回查 `accounts` 内部对象。
- `identity` 只返回身份主体标识，不依赖用户资料。
- `control-plane` 需要测试上游渠道时定义 `ProviderProbe` port，由 app 装配 inference 能力，不能直接反向依赖 inference。
- 通知内容所需业务事实由事件 payload 在入箱时给全，notifications 不回调业务包拼数据。

### 5.3 装配入口与 adapter 可见性

- 根 `index.ts` 只导出业务 facade、command/result、领域错误和必要值类型；禁止导出 PostgreSQL repository、Redis client、供应商 SDK 或装配细节。
- 能力包可以完全隐藏自有 adapter，由 `createXxx` 接收基础设施配置后内部组装；只有跨能力 bridge、需要由 app 选择的实现或进程级共享资源才使用 `./composition` 子入口。
- `./composition` 是内部 workspace 契约，不是公开发布 API；仅 `apps/*/src/assembly.ts`、迁移脚本和 adapter 集成测试可以引用，架构测试必须执行该白名单。
- app route、middleware、presenter 和任务 handler 只持有 facade，不持有 repository 或 adapter。

### 5.4 事务、outbox 与审计

- 事务边界属于发起状态变化的 application 用例。facade 调用者不创建、传递或观察 `DbTx`；事务上下文只在能力包 application、ports 和 adapters 内部流动。
- 同一能力内的多表不变量由一个本地事务保证。PostgreSQL 是可在测试环境替代的本地依赖，资金、身份、outbox 的边界测试必须使用真实 PostgreSQL 语义，而不是仅 mock repository。
- 跨能力同步调用默认不共享数据库事务；需要原子性的协作应重画为消费方定义的事务参与 port，或写入本能力拥有的 durable event，再由 adapter 在同一事务落入 notifications outbox。具体 bridge 只从 `./composition` 暴露，`DbTx` 不进入 facade。
- 可靠通知在业务提交前完成 outbox 写入；入箱失败必须回滚业务事务。提交后 hook 只允许用于明确可丢失的 metrics、trace 或缓存失效，不得承载资金、安全、权限和恢复所需事实。
- audit action 与 payload 由发生业务行为的能力定义，observability 负责持久化、查询和保留。安全、权限、资金类审计使用事务参与 port；仅低价值运营审计可以按显式策略降级。
- 每个跨能力事务场景必须有三类边界测试：业务回滚时无事件、事件写入失败时业务回滚、重试/并发下 dedupe 后只有一个可投递事实。

### 5.5 自动化边界门禁

目录约定必须由机器验证，至少建立以下门禁：

- package graph 无循环，`packages/*` 不得依赖 `apps/*`；
- 跨包 import 只能命中目标 package 的显式 `exports`，禁止 `@tillgate/*/src/*` 和相对路径越界；
- 边界检查必须解析 TypeScript `paths`、package exports 和实际模块解析结果，阻止用 alias 绕过 `exports`；
- domain/application/adapters 的依赖白名单由架构测试执行，新增例外必须同时提交 ADR 与测试更新；
- 每个公开入口执行 API/export 检查，避免无意把 adapter、供应商类型或私有包类型提升为公共契约；
- 公开候选执行依赖闭包检查和实际 tarball 安装冒烟，确保 registry 环境不依赖私有 `workspace:*`；
- 可选 Provider adapter 的加载测试证明未启用时不会把重型 SDK 带入启动热路径。

边界检查应进入 CI 的 typecheck/lint/test，以及适用项目的 build 主流程，不能依赖人工记忆或只在发布前临时运行。

### 5.6 深模块测试替换原则

依赖按测试策略分为四类：

1. **进程内计算**：domain/value object 直接测试，不创建 port。
2. **本地可替代依赖**：PostgreSQL、Redis 等使用真实本地实例或行为等价 stand-in，在 facade/application 边界验证事务、并发和恢复。
3. **自有远程服务**：消费方定义 port，生产使用 HTTP/queue adapter，测试使用内存 adapter。
4. **真实外部服务**：Stripe、SMTP、Turnstile、模型供应商等只在 port 边界 mock；另设少量凭证隔离的真实契约测试，不进入默认单元门禁。

迁移遵循“替换而不是叠加”：新 facade 边界测试覆盖可观察行为后，删除只验证旧浅转发层、内部调用次数或实现细节的测试；保留能证明领域不变量、PostgreSQL 原子语义、外部协议兼容和安全属性的测试。

---

## 6. 根配置规范

### 6.1 TypeScript

- `tsconfig.base.json` 保存所有 Node/TypeScript 项目的共同严格规则。
- `tsconfig.next.json` 只保存 Next.js 与浏览器相关差异。
- 子项目的 `tsconfig.json` 只声明本项目特有的 `include`、JSX、输出和环境类型。
- 只有至少两个服务重复同一组非基础配置时，才增加 `tsconfig.server.json`。
- 不创建 `packages/tsconfig`，除非这些配置需要跨多个仓库独立发布和版本化。

### 6.2 Vitest

- 每个 app/package 保留自己的 `vitest.config.ts`，因为测试边界、覆盖率和运行环境属于项目本身。
- 根 `vitest.shared.ts` 只提取真正一致的行为，例如根 `.env` 加载、通用 exclude 和默认环境。
- 覆盖率阈值、集成测试串行策略、E2E 排除规则如有业务差异，继续留在消费者配置中。
- 共享配置通过相对路径导入，不为它创建 workspace package。
- 需要 monorepo 统一入口时，在根 `vitest.config.ts` 配置 `test.projects`；不使用已被当前 Vitest 版本替代的 `vitest.workspace.ts`。
- 根配置若直接 import `vitest/config`，根 `package.json` 必须显式声明 Vitest 版本，不依赖 workspace 依赖提升。

### 6.3 Oxlint 与 Oxfmt

- 全仓只有一套规则时，配置固定在根目录。
- 子项目仅在运行环境确实不同且根配置无法表达时增加局部覆盖。
- 不创建空的 `tooling/oxlint/`、`tooling/oxfmt/` 目录。

---

## 7. 包的私有与发布分类

### 7.1 默认规则

| 类型 | `private` | 发布方式 |
|---|---:|---|
| 根项目 | `true` | 永不发布 |
| `apps/*` | `true` | 永不发布 |
| 内部 `packages/*` | `true` | 永不发布 |
| 明确批准的公开包 | 删除 `private` | 独立版本、独立发布 |

workspace 成员身份不等于 npm 发布资格。根项目必须永久保持 `private: true`。

内部私有包与公开包的产物契约不同：

- 内部包的 build 只需满足本仓运行和部署，可以只生成 JavaScript，也可以在 development 条件下从源码提供类型；不强制生成 `.d.ts`。
- 内部包若不生成声明文件，不得把顶层 `types` 指向不存在的 `dist/*.d.ts`；应删除该字段或让内部 development 类型入口指向真实源码。
- 只有进入发布白名单的包才必须让 `main`、`types`、`exports`、`files` 与实际 tarball 产物完全一致。

### 7.2 当前公开候选

| 包 | 当前状态 | 发布前必须完成 |
|---|---|---|
| `@tillgate/api-client` | 私有、源码导出；实际是 Next.js BFF 适配层 | 生成 `dist` 与声明文件；移除/隔离私有 `http`、`next/headers`、Cookie 和服务端环境变量依赖；冻结公开 API |
| `@tillgate/ui` | 私有、源码导出；混合通用组件与 Next.js 能力 | 生成可消费产物；隔离 `next/link`、`next/navigation`、`next/font`、Server Actions；处理 CSS exports；收敛 peer dependencies |
| `@tillgate/ai` | 私有、零内部依赖；已是 `createAi` + `onEvent` + 透传中继的 SDK 形态 | 生成 `dist` 与声明文件；冻结 `createAi` / `AiEvent` / `ChannelDesc` 契约；重型 vendor SDK 声明为 optional peer；纯 Node consumer fixture 安装冒烟 |

是否最终发布这些包由真实外部消费者决定。没有外部消费者时继续私有，不提前承担兼容性成本。

推荐的未来形态不是直接发布当前目录，而是按外部契约收敛：

```text
只发布一个包：
  @scope/api-client             # 框架无关根入口 + 可选 ./next 子入口

需要发布两个包：
  @scope/api-client             # fetch client、DTO、ApiError、分页
  @scope/ui                     # 纯 React 设计系统，peer React
```

API Client 核心应通过参数接收 `baseUrl`、`fetch`、token/headers 获取器，不自行读取 Next Cookie、环境变量或可信代理配置。Next 会话、语言和转发 IP 只允许从显式 `@scope/api-client/next` 子入口使用；Server Action 继续留在对应 app。

`./next` 若随公开包发布，Next 应声明为该子入口对应的 optional peer dependency，并用独立 consumer fixture 验证；框架无关根入口的安装、解析和类型检查不得要求消费者安装 Next。

如果第二个包只是给同仓库两个控制台共享，保持 `@tillgate/ui` 私有即可；只有出现仓库外消费者并能承诺 React/Next 兼容范围时，才建立公开的 React/Next 包。

### 7.3 公开包的依赖闭包

公开包的所有运行时依赖必须满足以下之一：

1. 已发布到公共或目标私有 registry；
2. 构建时合法地打入当前包，且不会产生重复单例或许可证问题；
3. 作为明确的 peer dependency 由消费者提供。

禁止公开包保留以下依赖：

```json
{
  "dependencies": {
    "@tillgate/http": "workspace:*"
  }
}
```

因为 registry 用户无法安装私有 workspace 包。解决顺序优先为：缩小公开契约并移除内部依赖，其次打包稳定实现，最后才考虑连带发布内部包。

### 7.4 公开包的最小元数据

```json
{
  "name": "@scope/package-name",
  "version": "0.1.0",
  "type": "module",
  "files": ["dist", "README.md", "LICENSE"],
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "publishConfig": {
    "access": "public",
    "provenance": true
  }
}
```

公开包禁止从 `exports`、`main` 或 `types` 指向 `src/`。源码导出只允许作为本仓库私有开发模式，不能成为外部安装契约。

---

## 8. 独立发布策略

采用**独立版本 + 发布白名单**，不做全量发布。

建议流程：

```text
修改公开包
  → typecheck / lint / test / build
  → 检查发布文件清单
  → 用打包产物执行安装冒烟测试
  → 只提升发生变化的公开包版本
  → 只发布 CI 白名单中的目标包
```

发布白名单初始为空。批准 `api-client` 后加入一个；批准 `ui` 后再加入第二个；批准 `ai` 后加入第三个。CI 禁止扫描 `packages/*` 后逐个发布。

每个公开包必须：

- 有自己的 changelog 或 changeset；
- 遵守 SemVer；
- 能从干净 checkout 独立构建；
- 对实际发布 tarball 做安装、运行和消费者 typecheck 测试，不得由 workspace 源码 alias 兜底；
- 发布前验证 tarball 不含 `.env`、测试数据、内部文档和源码密钥；
- 公共 API 破坏性变化只能进入 major 版本。

`ui` 若进入发布白名单，还必须验证 `"use client"` 指令保留、CSS `sideEffects`/exports、Tailwind 消费方式、tree-shaking，以及至少一个 Next consumer 和一个非 Next React/Vite consumer。服务端内部包的部署产物策略（bundle、external + 裁剪后的 dist，或完整 workspace runtime）由部署 ADR 单独决定，不与 npm 发布资格绑定。

内部包可以继续统一使用仓库版本或不单独维护发布版本；其 `version` 不代表公开兼容承诺。

---

## 9. 分阶段迁移

各阶段量级粗估如下（以边界脚本扫描为准；这是季度级工程，不是一次提交）：

| 阶段 | 主要动作 | 量级参考 |
|---|---|---|
| P0–P1 | 规则固化、审计、根配置收敛 | 无代码搬迁；审计与测试补齐为主要成本 |
| P2 | 边界审计、Next paths 解除 | 15 个 package 依赖图梳理；两个 Next app 20+ 条 paths 别名 |
| P3 | 根契约与基础设施收口 | `core/db/http` 约 6k 行重组；四条迁移链收口 |
| P4 | 业务能力垂直迁移 | 资金族约 25k 行；gateway 推理同族约 9k 行迁入 inference；`ai` 收窄（熔断/死凭据迁出为 inference 健康模块） |
| P5 | 收紧 apps | 三个后端 app 合计约 34k 行；16 个 e2e 文件迁根 `e2e/` |
| P6–P8 | 公开包与发布自动化 | `api-client` 约 1.3k 行 + `ui` 约 9.7k 行发布改造 |

### P0：固化结构规则

- 合入本文档。
- 将配置、包准入和发布规则写入根 `AGENTS.md`。
- 建立仓库级边界检查脚本 `scripts/check-package-boundaries.ts` 并进入 CI：覆盖跨包深导入、相对路径越界、TypeScript source alias 绕过和 package graph 循环检查；本文档 §2.3 的引用计数为手扫近似值，此后以该脚本扫描为准。
- 固化现有 HTTP/任务协议、资金不变量、并发/幂等/恢复行为和数据库迁移基线；重构后的边界测试必须证明行为等价。
- 交付测试覆盖缺口盘点：对资金（`service/repository/db` 写路径与 `wallet` 双实现）、身份凭据、通知 outbox、结算恢复四类路径逐项列出已有测试与缺口；缺口必须在对应能力迁移开始前补齐，否则「行为等价」验收不可判定。
- 交付生产库迁移状态审计：四条迁移链（`db` drizzle-kit、`wallet` migrate-cli、`identity-core` provision、`ledger-core` provision）已叠加执行于生产，必须审计 `_drizzle_migrations` journal 状态与三条 provision 链各自落下的 schema 痕迹，形成权威迁移历史结论——这是 P3「空库升级、存量升级、回滚」三验可执行的前提。
- 建立 §3.4 所列事实源审计：资金双实现、身份凭据、管理员归属、Provider 词表、通知原子性和审计可靠等级都必须有明确结论。
- 不移动代码，不改变运行行为。

### P1：收敛根配置

- 保留现有根 TypeScript、Oxlint、Oxfmt 和 Turbo 配置。
- 统计 Vitest 重复逻辑，只有确认语义相同后才提取 `vitest.shared.ts`。
- 需要统一测试入口时使用根 `vitest.config.ts` 的 `test.projects`，并由根显式持有 Vitest devDependency。
- 不创建 `tooling/` 和配置 package。

### P2：审计 package 边界

- 为每个 package 标记消费者、职责和依赖方向。
- 解除 Next paths 旁路按三步执行，且两个 app 分开切换：先审计并补全 `ui` / `api-client` 的 `exports`，覆盖当前被消费的全部子路径（`server/`、`stores/`、`components/ui/*`、`lib/*` 等，含 development 条件）→ 逐 app 将 paths 别名切换为包名解析并全量 typecheck → 删除 tsconfig paths。直接删 paths 会因 exports 未覆盖子路径大面积编译断。
- 删除跨包 `src/` 深层导入；所有消费者经过 package `exports` 解析。
- 对总是共同变化的浅包提出合并 RFC，不在一次提交中批量搬迁。
- 合并只有转发层、单一消费者且不承担切环/兼容责任的浅包；边界测试替换后删除旧测试与 exports。
- 明确内部 build 与部署产物策略；内部包不因缺少 `.d.ts` 失败，但 package 元数据不得指向不存在的产物。

### P3：建立根契约与基础设施

- 实施 `errors`，按错误体系方案迁移并删除三份错误映射拷贝。
- 将 `core` 拆分为职责明确的 `runtime` 与 `observability`，禁止二者形成循环依赖。
- 保留 `db` 包名并收窄职责，只保留连接、事务、schema、迁移和 PG 基础错误；清除它对 `ledger-core` 等业务包的反向依赖。
- 将 identity-core/ledger-core/wallet 的独立 provision/migrate 链按能力迁移逐步收口到统一 db migration；每次变更必须同时验证空库升级、存量升级和回滚/前滚方案，禁止一次性改变全部迁移入口。
- 将 `http` 瘦身为纯 HTTP/Hono 基础工具包，移除 DB、wire schema 和具体业务依赖。
- 先建立可复现的 contract → OpenAPI → generated client 链，再将 wire schema 逐个迁入对应 API 的 `src/http/contracts`；明确生成命令、产物是否入库、兼容性 diff 和禁止手改规则，不创建集中式 `contracts` 包。
- 基础设施工作按消费者切片落地，不把 `errors/runtime/observability/db/http` 的全量重写作为业务能力迁移的单一大前置提交。

### P4：按依赖拓扑迁移业务能力

按以下拓扑推进；同一波内不存在依赖时可以并行，但不得打破 §5 的编译依赖方向：

1. **事件与身份基础**：outbox/邮件/webhook → `notifications`；`identity-core + identity` 的挑战、MFA、OAuth、JWT、会话吊销 → `identity`。
2. **控制面配置**：provider/channel/model/rate-card → `control-plane`；可执行协议/vendor 注册表留在 `ai` 库，由 assembly 注入能力校验器。
3. **资金能力**：先完成资金双实现语义差异清单，再将 `wallet + ledger-core + 对应 domain/service/repository` 的垂直用例迁入 `billing`；`apps/worker` 对账任务对 `@tillgate/wallet` 的直连同波切换为 `billing` facade；删除空 `money` 目录，金额构造、运算和序列化只保留在 `billing/domain/money`。
4. **上层消费者**：用户/组织/API Key/Application → `accounts`；`gateway` 的推理 pipeline/routing/quote/generation 与相关 domain/service/repository → `inference`，`inference` 单向依赖收窄后的 `ai` 库——熔断、死凭据等跨请求健康状态以 `AiEvent` 订阅者身份迁入 `inference/health`，`ai` 收敛为无运维状态的执行库（§3.6）。
5. **可观测收尾**：tracing、request log、audit storage/query → `observability`；业务 audit action 继续由各能力定义并通过 port 投递。

迁移原子单位是一个可观察业务用例或一组不可拆事务，而不是整个 package：

- 同一用例的 facade、domain/application、ports/adapters、schema/migration、边界测试和全部调用方在一个迁移单元切换。
- 切换通过后立即删除该用例的旧实现、旧 export、source alias 和重复测试；禁止兼容转发与双写。
- 尚未轮到的其他用例可以继续留在旧 package，但不得新增同类旧结构代码。
- 资金用例每次迁移都必须通过真实 PostgreSQL 下的并发、幂等、恢复、对账和 outbox 原子性测试。

### P5：收紧 apps

- 每个后端 app 只保留 config、assembly、协议路由、中间件、presenter 和生命周期。
- 业务规则与持久化实现迁入能力包，app 不再形成第二套 domain/application。
- Next app 按 feature 组织；BFF 专有 Cookie、locale、forwarded IP 与 Server Action 留在 app 或 `api-client/next`。清除 `apps/admin` 对 `@tillgate/ai`、`@tillgate/tracing` 的直依赖：链路图等数据改经 `admin-api` 契约与 `api-client` 获取。
- 跨进程旅程迁入根 `e2e/`，包内继续保留单元、契约和集成测试。现有 16 个 e2e 文件先行归组搬迁：gateway 7 个（cost-drain/slow/rxm3/params-floor/auth-audit/worker/attack）→ `e2e/gateway` 与 `e2e/security`；client-api 4 个（user-journey/oauth/org-team/cross-app）→ `e2e/client-journey`；admin-api 5 个（login/money/ops/crud-sweep/cross-app）→ `e2e/admin-journey` 与 `e2e/billing-recovery`。搬迁只搬文件与启动装置，不得借机改断言语义。
- app 非 assembly 代码不得引用任何 `./composition`、repository、adapter 或 `Db/DbTx` 类型。

### P6：准备第一个公开包

- 优先选择外部价值最明确的 `api-client`。
- 根入口改为框架无关 client，Next 能力只从显式 `./next` 子入口导出。
- 移除私有依赖闭包，建立 `dist` 构建和声明文件产物。
- 从 P3 的 OpenAPI 产物生成 DTO/client，删除对应手写 DTO 双轨。
- 增加实际 tarball 的安装、运行、消费者 typecheck 与 API 兼容检查；测试不得通过 workspace source alias。
- 若发布 `./next`，将 Next 作为 optional peer 并单独验证；框架无关根入口不得强制安装 Next。
- 通过评审后才删除该包的 `private: true`。

### P7：按需求准备第二个公开包

- 只有存在真实外部 UI 复用需求时才处理 `ui`。
- 从 `ui` 移除 Next Router、Next Font、Server Action 和 BFF 会话逻辑，使其成为纯 React 设计系统。
- 明确 React/Next/样式系统的 peer dependency 支持范围。
- 验证 `"use client"`、CSS exports/sideEffects、Tailwind、tree-shaking，以及 Next 与 React/Vite 两类 tarball consumer。
- 不因发布 `api-client` 自动发布 `ui`，反之亦然。

### P8：发布自动化

- CI 使用显式发布白名单。
- 只发布发生版本变化且通过完整门禁的公开包。
- 根项目、应用和内部包始终禁止发布。

### 9.1 迁移与业务开发的并行规约

迁移以季度计，业务开发不冻结。以下规约防止「原子切换」在合并冲突中退化为双轨：

- 一律逐 PR 灰度迁移，禁止长寿命 refactor 分支；每个迁移 PR 只覆盖一个垂直用例，可独立 revert，revert 后旧路径完整可用（旧实现与切换同 PR 删除，revert 即整体还原）。
- 涉及 DDL 的用例迁移必须把迁移单元拆出先行合入；迁移 PR 本身不携带 schema 语义变更，保证 revert 不需要数据回滚。
- 迁移期间旧结构只读不新增：未迁移能力的新用例仍落旧 `service/domain/repository` 位置并遵守 AGENTS.md 现行分层；不得在目标包提前创建该能力的实现，也不得在旧位置新增已迁移能力的新代码。
- 业务 PR 与迁移 PR 冲突时，迁移 PR rebase 业务 PR；禁止业务 PR 顺手「帮忙迁移」。
- 每个迁移 PR 携带该用例的边界测试清单并通过四门（typecheck/lint/test/build）；资金用例另加真实 PostgreSQL 下的并发、幂等、恢复测试。

---

## 10. 验收标准

- 根目录没有 `tooling/package.json` 或仅为配置而存在的 workspace package。
- `workspaces` 仍只覆盖 `apps/*` 与 `packages/*`。
- 当前目标候选逐一通过 §4 准入标准；最终 package 数量可以少于或多于 13，但不存在未落地空壳、浅转发包或仅为目录分类存在的 package。
- 完成全部迁移后，不再存在顶层 `domain`、`service`、`repository`、`wallet`、`ledger-core`、`identity-core`、`core`、`tracing` 旧包；`db` 与 `ai` 保留但收窄——`ai` 成为 §3.6 契约下的上游协议库。
- 每个业务能力包满足 `domain ← application`，按真实边界选用 `ports ← adapters`；app 只通过 facade 装配和调用。
- §3.4 的每类状态事实、协议词表和副作用都只有一个权威所有者；不存在钱包、凭据、DTO、Provider 词表或通知事件的长期双实现/双写。
- 可靠通知与业务状态同事务入箱；回滚、入箱失败、并发重试和 dedupe 边界测试全部通过，公开 facade 不出现 `Db/DbTx`。
- adapter 不从能力根入口导出；只有 app assembly、迁移脚本和 adapter 集成测试可以引用显式 `./composition` 子入口。
- 所有 app 和内部包均为 `private: true`。
- 公开包数量由发布白名单显式控制，可以只发布一个、两个、三个或零个。
- 公开包只暴露真实存在的 `dist` JavaScript、声明文件和必要样式，且其运行时依赖闭包可由外部 registry 完整解析；内部包不强制生成 `.d.ts`。
- 任意 package 都不存在对 `apps/*` 或其他包 `src/*` 的越界依赖；TypeScript `paths` 不能把 workspace 包名映射回源码绕过 `exports`。
- package graph 无循环；跨包引用全部命中显式 `exports`，边界例外都有 ADR 和架构测试。
- `db` 不依赖业务包；旧 provision/migrate 链已按能力迁移收口，并通过空库与存量升级验证。
- contract → OpenAPI → generated client 可从干净 checkout 重现，生成产物与手写 DTO 不存在双轨，兼容性 diff 进入 CI。
- 未引入无真实外部插件消费者的 `plugin-sdk`、`extensions/*` 或按供应商拆分的 workspace package。
- 若未来存在独立 `*-protocol`，已通过 §4.4 全部条件且只拥有单一协议，不是中央 DTO 仓库。
- 全部项目通过 typecheck、lint、test；可部署项目与实际需要运行产物的内部包通过 build；公开包额外通过声明产物、tarball 安装/运行/消费者 typecheck 和 API 兼容门禁。
- 配置复用降低重复，但没有引入新的版本、构建和发布生命周期。

---

## 11. 架构合理性

这套结构符合企业级项目的关键不在于目录多，而在于边界可治理：

- **稳定**：部署单元、内部模块和公开产品有不同生命周期，互不误伤。
- **清晰**：根配置随工具默认发现；业务代码只在 apps/packages 中定位。
- **可扩展**：新增应用、新增内部能力和新增公开包都有明确准入规则。
- **可发布**：公开包按需独立版本和发布，不把整个 monorepo 暴露为产品。
- **可测试**：每个真实 package 在边界上独立验证，配置共享不引入虚假模块。
- **可维护**：默认私有和发布白名单让误发布成为结构上不可能发生的状态。
- **可治理**：依赖方向、公开出口、插件/协议例外和发布闭包由 CI 检查，不依赖口头约定。
- **可收敛**：package 有明确退出机制，浅转发层和伪复用不会永久增加认知负担。

最终原则是：**目录用于组织，package 用于建立代码与生命周期边界，发布资格由外部契约单独决定；
企业级不是 package 越多，而是所有边界都能被解释、验证、演进和必要时撤销。**
