# `@tillgate/observability`

可观测能力包（总纲 §3.1/P4.5）：OTel 装配、链路追踪、审计存储查询、请求日志与 usage 运维读侧。
观测链路 best-effort，永不反压业务；基础结构化 logger 在 `packages/runtime`，**不在本包**——本包只消费最小 Logger 形状 `{ info, warn }`，不依赖 runtime。

设计基线 [DESIGN.md](./DESIGN.md) · 施工图 [IMPLEMENTATION.md](./IMPLEMENTATION.md) · 迁移核销 [MIGRATION.md](./MIGRATION.md) · 错误目录归属 [ADR-0001](../../docs/adr/0001-errors-registry-ownership.md)

## 核心能力

- **OTel 装配（telemetry/）**：`initOtel` 四模式 `off | memory | console | otlp`（off = 完全 no-op；memory = 环形缓冲 200 traces / 4000 spans；console = span 一行结构化日志；otlp 缺 endpoint 启动期抛 `observability.otel_endpoint_missing`）；`withAsyncSpan` / `formatTraceParent` / `@opentelemetry/api` 词汇再出口（业务代码唯一取用点）
- **tracing**：`decodeOtlpJson`（OTLP/HTTP JSON 解码，单 span 畸形跳过计数）、`createSpanBatcher`（有界队列批量摄入：溢出丢最旧、写失败丢批计数，任何路径不抛）、`createTraceQueries`（recent/点查/byRequest/拓扑/统计）、`buildTraceGraph`（链路图视图模型）、`dayKey` 日分区与 `maintainTracePartitions`（幂等 DDL + advisory try-lock）
- **audit**：`AuditEntry` 词表（actor = admin/user/system）；`writeAudit` 同事务写入（失败随业务回滚——资金审计语义，经 `./composition` 子出口）、`createBestEffortAuditSink` 旁路 best-effort；查询面 `list / listByTarget`
- **request-log**：写入原语与列表查询（缺省 30 天窗）；`maintainRequestLogPartitions` 月分区维护
- **usage 读侧**：`createUsageQueries`（管理列表/概览/分组/趋势/渠道 TTFT；北京时区日界工具）。usage_logs 表归 billing 结算投影，本包只承载查询
- facade `createObservability({ db })` → `{ traces, audit, requestLogs, usage, partitions }`（PG 适配器组装；Hono 中间件/HTTP 接收面/分区调度归各 app）

## 目录结构（src/）

```
telemetry/       # OTel SDK 装配（唯一允许 import OTel SDK 的层；零 DB）
tracing/         # decode / ingest(batcher) / graph / queries / partition（纯逻辑 + port）
audit/           # 审计词表（AuditEntry / 查询出入参）
request-log/     # 请求日志词表
usage/           # usage_logs 运维读侧查询与日界
adapters/        # postgres：trace/audit/request-log/usage store + 分区维护（唯一 SQL/DDL 层）
composition.ts   # writeAudit / createPgTraceStore 等装配原语（仅 apps assembly 引用）
```

## 依赖与边界

- 依赖：`@tillgate/db`（schema/Db/DbLike/runTx）、`@tillgate/errors`、drizzle-orm、`@opentelemetry/*`
- 不依赖 runtime（Logger 本地声明最小形状，runtime 的 pino Logger 结构兼容，装配自然传入）
- 分层纪律（架构测试锁定）：纯逻辑层不 import drizzle SQL 构造；adapters 不从根出口导出；错误目录 `observability.{invalid_otlp_payload, otel_endpoint_missing, invalid_partition_day}` 封闭
- 消费方：trace-receiver（decode/ingest/store）、gateway（request-log 写入 + OTel）、admin-api（查询面 + 审计桥）、worker（分区维护调度）

## 测试

```bash
cd packages/observability
bun run typecheck && bun run lint && bun run test
bun run test:real       # postgres.real.test.ts：真实 PG（根 .env 的 DATABASE_URL；不可达整组跳过）
bun run test:coverage
```
