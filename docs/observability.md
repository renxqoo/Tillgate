# 可观测手册：日志、链路追踪与运营日志

> 本文档描述 v2 的完整可观测体系：结构化日志（`packages/runtime`）、OTel 链路追踪与
> 三类落库运营日志（`packages/observability`）、requestId 关联锚点，以及观测栈部署。
> 与代码冲突时以代码为准；配置键名与默认值见 [configuration.md](configuration.md)。

## 1. 结构化日志（packages/runtime）

全部服务端应用（gateway / client-api / admin-api / worker / trace-receiver）统一使用
`@tillgate/runtime` 的 `createLogger`（pino 10 封装，`packages/runtime/src/logging/logger.ts`）：

- **JSON 结构化输出**（ndjson），`name` 字段标记服务名；开发环境可开 `pino-pretty`
  （装配层显式注入 `pretty: true`，不藏默认）。
- **级别**：`LOG_LEVEL` 环境变量控制（trace / debug / info / warn / error / fatal，缺省 info）。
- **敏感字段脱敏**（pino redact，censor `[REDACTED]`）：`req.headers.authorization` 与
  敏感字段两级路径（根级 + 嵌套 `*.field`）——`apiKey / api_key / clientSecret /
  client_secret / key / token / secret / password`。v1 只有 `*.field` 通配导致根级字段
  从未脱敏，v2 已修正并有行为等价测试锁定。
- **日志调用约定**：pino 双参形态 `(obj, msg) => void`——结构化字段进第一参对象，
  消息短语进第二参；注入面（如结算域的 logger port）按此签名收窄。

**console 使用边界**：logger 实例创建之前的阶段（config 加载告警、进程启动失败的
最后兜底 `main().catch`）允许 `console.warn/error`；进入运行期后一律走结构化 logger。
仓库中仅存的 console 调用都在这两个位置（`apps/gateway/src/config.ts` 废弃键告警与
`apps/gateway/src/index.ts` 启动失败兜底）。

**错误出站三层约定**（AGENT.md 铁律 12）：响应体只带结构化错误信封（码/状态/可读消息）；
错误原文脱敏后保留；细节只进日志并关联 requestId——不在响应体泄漏堆栈与上游细节。

## 2. requestId —— 一切关联的锚点

requestId **永远服务端生成**（`requestIdMiddleware`，`@tillgate/http` 提供），不信任
客户端 `X-Request-Id` 头，响应回显 `x-request-id`。不信任客户端的原因：

1. 限流 ZSET 以 requestId 作 member——信任客户端 = 固定 ID 恒去重 = RPM 绕过；
2. requestId 同时是 billing / usage 的幂等键（uuid 列）——客户端可控会导致重放冲突。

一个 requestId 串联四类数据：结构化日志行、`request_logs` 行、trace span 属性
`request.id`（计费关联锚点）、计费与用量记录。排查问题时先拿响应头里的
`x-request-id`，再去管理后台请求日志 / trace 视图 / 日志流三处对齐。

网关中间件链顺序（`apps/gateway/src/app.ts`）：
`securityHeaders → bodyParserLimit → requestId → otel → （/v1/*）requestLog（鉴权前挂载，
401/429 也记）→ apiKey → rateLimit`。

## 3. OTel 链路追踪（packages/observability）

`initOtel`（`packages/observability/src/telemetry/init-otel.ts`）四种模式
（`OTEL_TRACES_MODE`）：

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| `off` | 完全 no-op，tracer/meter 零开销 | 生产无观测栈 |
| `memory` | 进程内环形缓冲 + 查看页 | 零基建，开发默认 |
| `console` | 每次 span 结束打一行结构化日志 | 可 grep，CI/无浏览器 |
| `otlp` | BatchSpanProcessor → OTLP collector（trace + metrics 双通道） | 生产观测栈 |

- `mode=otlp` 时端点必填（缺失启动期 fail-fast）；推送鉴权 `TRACE_RECEIVER_TOKEN`
  （Bearer，与接收端同键同值，缺此值 = span 全部 401 拒收）。
- 每请求一棵 span 树（探活路径除外），覆盖 gateway 请求路径全程（v1 阶段 span 等价回填；
  inference 侧经 `TracePort` 注入——零编译依赖 observability，装配绑定 OTel 实现，
  off 模式 no-op 零开销）。完整成功路径（单渠道）至少 9 步：

| span | 产生点 | 属性要点 |
| --- | --- | --- |
| `POST /v1/…`（根） | gateway otel 中间件 | `request.id`、`user.id`、`api_key.id`、`http.*` |
| `auth.api_key` | gateway api-key 中间件 | `auth.kind`（key / jwt） |
| `rate_limit.admit` | gateway admitRequest（未装配限流闸则无） | `tokens.estimate`、限流维度 |
| `inference.prepare` | inference 预检（白名单/目录/候选链/双口径估算） | `ai.model`、`quote.candidates` |
| `billing.authorize` | 资金预扣 | `billing.stream` |
| `routing.resolve`（每候选） | 候选渠道调度序解析 | `routing.channels` |
| `billing.reserve_channel`（每渠道） | 渠道采购预算敞口预留 | `channel.key` |
| `upstream.attempt`（每渠道尝试） | 上游调用（非流式/流式共用） | `channel.*`、`upstream.stream`、`upstream.ok` |
| `billing.settle_signal` | 终态结算信号（退避重试整段） | `request.id` |

  换渠/失败路径另有：`channel.skip`（渠道限流/熔断/死凭据/预算尽跳过，属性
  `skip.reason`）、`billing.passthrough_4xx`（上游 4xx 透传收尾）、
  `billing.release_and_fail`（候选×渠道耗尽三路归还）。根 span 属性携带
  `request.id`、`user.id`、`api_key.id`、`http.*`；指标含 TTFT 双向口径
  （上游首 token vs 客户端体感首 token）。
- trace-receiver（`apps/trace-receiver`）：内网 OTLP/HTTP JSON 接收端，批量写 PG 日分区；
  过载即丢不反压——观测不反噬数据面。

## 4. 三类落库运营日志

| 类别 | 表 | 写入方 | 语义 |
| --- | --- | --- | --- |
| 请求日志 | `request_logs` | gateway 中间件（鉴权前，401/429 也记） | **best-effort**：写失败只告警不阻塞请求（观测不能反噬可用性）；运维列表缺省 30 天窗，`q` 命中 path/errorCode/sourceIp/requestId |
| 用量日志 | `usage_logs` | billing（计费结算投影） | 资金事实归 `packages/billing`；observability 只提供运维读侧（管理列表/概览/分组/趋势/渠道 TTFT） |
| 审计日志 | `audit_logs` | 各业务能力经 port 发出 | 事务内写入（`writeAudit`，安全/权限/资金审计不降级为提交后 best-effort）；旁路告警类走 best-effort sink；action 词表归业务能力包定义 |

分区与保留：`request_logs` 与 trace 表均为日分区母表（禁止对 `request_logs` 跑
db:generate）；分区维护由 worker 定时执行（内置 advisory try-lock，未获锁跳过），
按保留期滚动清理。查询面经 admin-api 运营路由消费（traces / ops-logs / ops-usage）。

## 5. 观测栈部署

`docker compose -f docker/compose.yml --profile obs up -d` 启动自建开源观测栈：
otel-collector（接收 OTLP）→ tempo（trace 存储）+ prometheus（指标）→ grafana
（看板，数据源已预配置）。启用链路需：设置 `TRACE_RECEIVER_TOKEN`、把对应服务的
`OTEL_TRACES_MODE` 从 compose 缺省 `off` 改为 `otlp`（compose environment 覆盖
env_file，见 [configuration.md](configuration.md)）。

## 6. 韧性边界

- OTel/trace 通道全损不影响推理数据面（`ai` 包零缓冲透传，观察走 `onEvent` 旁路）。
- 观测 tap 丢失不得造成资损——兜底在 billing 状态机与对账，不在热路径补写。
- Redis 故障时观测相关限流降级策略见 [tech-stack.md](tech-stack.md) 分级降级一节。
