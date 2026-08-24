# @tillgate/observability 设计基线

> 状态:定稿并已实施(出口面快照由 `__test__/architecture.test.ts` 锁定;契约演进走 ADR + 测试同步)
> 依据:`docs/project-structure-refactoring.md` §3.1(observability = OTel、trace、audit、request log)、§3.4(审计事实的存储/查询/保留归本包;action 语义归业务能力)、§5.1(允许依赖 errors/runtime/db;runtime 不得反向)、P4 第 5 波
> 波次:P4.5 可观测收尾(tracing、request log、audit storage/query → observability)

---

## 1. 问题域

**处理**:OTel SDK 装配(四模式)、OTLP JSON 解码、span 批量摄入(best-effort)、
trace_spans 日分区存储与查询(列表/点查/拓扑/统计)、链路图视图模型、audit_logs 的
写入原语(同事务/旁路 best-effort 双语义)与通用查询、request_logs 的写入/查询与月分区维护。

**不处理**(归属写明,不留白):

| 不处理                                            | 归属                                                     |
| ------------------------------------------------- | -------------------------------------------------------- |
| usage_logs(结算投影/计价快照/限额读模型)          | `billing`(已迁,含 channelTtft/stats 读侧)                |
| audit action 与 payload 语义(何时审计、记什么)    | 各业务能力包自有 AuditPort(accounts/control-plane 现行)  |
| OTLP 接收 HTTP 面(body-limit/令牌/415/400 映射)   | `apps/trace-receiver`(P5;本包出 decode+ingest+store)     |
| 请求日志 Hono 中间件(摘要嗅探/响应码提取)         | `apps/gateway`(P5;本包出写入原语)                        |
| 管理面路由/分页解析/审计页信封                    | `apps/admin-api`(P5;本包出查询面)                        |
| 分区维护调度(每小时循环)                          | `apps/worker`(P5;本包出维护函数,内置 advisory try-lock)  |
| admin 前端链路图直依赖(§2.2 越界)                 | P5 清除:图由 admin-api 服务端用本包 buildTraceGraph 组装 |
| 基础 logger 初始化                                | `runtime`(§3.1 禁止项;本包只**消费**结构化 Logger 形状)  |
| 审计保留策略(v1 无 audit 分区/清理——审计永久保留) | 行为等价:不引入;升格另立裁决                             |

## 2. 外部契约(v2 API,已定稿)

```ts
// ---- telemetry/(OTel 装配;零 DB)----
type OtelMode = 'off' | 'memory' | 'console' | 'otlp'
initOtel({ serviceName, serviceVersion?, mode, endpoint?, logger?, authToken? }):
  { mode, shutdown(): Promise<void>, memory?: MemoryTraceViewer }   // otlp 缺 endpoint 抛 observability.otel_endpoint_missing
createMemoryTraceViewer(): MemoryTraceViewer   // { processor, recent(limit?), clear() }——环形缓冲 200 traces/4000 spans
createLogSpanProcessor(logger): SpanProcessor  // console 模式:span 结束一行结构化日志
formatTraceParent(sc: SpanContext): string | null
remoteParentContext(traceParent: string | null | undefined): Context | undefined
withAsyncSpan(tracer, name, attributes, fn): Promise<T>   // 异常→span ERROR+recordException 后原样上抛
getTracer(name?), getMeter(name?)
// @opentelemetry/api 词汇再出口:trace/metrics/context/SpanStatusCode/类型——业务代码唯一取用点

// ---- tracing/(纯逻辑 + port)----
decodeOtlpJson(body: unknown): { rows: SpanRow[]; skipped: number }
  // 结构级错误抛 observability.invalid_otlp_payload;单 span 畸形跳过计数
buildTraceGraph(spans: SpanRow[]): TraceGraph   // 节点 kind/status/subtitle/执行线边(fallback/next/child)
dayKey(date: Date): string   // UTC 'YYYY-MM-DD'
createSpanBatcher(store: TraceStore, { max, batchMax, flushIntervalMs }): SpanBatcher
  // push(rows)→溢出丢弃数;flush/close/getStats/start——写失败丢批计数,绝不抛出
createTraceQueries(store: TraceStore): TraceQueries
  // recent(limit 钳 1..100,rows+total 并行)/traceDetail/byRequest(topology hours 钳 1..168)/stats

// ---- audit/(词表 + 写入原语)----
type AuditActor = 'admin' | 'user' | 'system'
interface AuditEntry { actor; adminId?; action; targetType; targetId?; detail? }
writeAudit(db: DbLike, entry): Promise<void>            // 同事务:失败随业务回滚(资金审计语义)
createBestEffortAuditSink(db, log?): { record(entry): Promise<void> }   // 旁路:不抛,失败记日志

// ---- request-log/(词表)----
interface RequestLogWriteInput { requestId; userId; apiKeyId; method; path; statusCode; errorCode; durationMs; requestSummary; sourceIp }

// ---- adapters/postgres/(装配细节,不进根出口)----
createPgTraceStore(db): TraceStore         // writeBatch 幂等(onConflictDoNothing)+写前 ensure 日分区(memo)
maintainTracePartitions(db, { retentionDays?, lookaheadDays? }): { created, dropped }  // 内置 advisory try-lock
createPgAuditQueries(db): { list(input): { rows, total }; listByTarget(input): AuditLogRow[] }
createPgRequestLogStore(db): { insert(input); list(input): { rows, total } }   // list 缺省 30 天窗
maintainRequestLogPartitions(db, { retentionDays }): { created, dropped }       // 月分区,内置锁

// ---- facade ----
createObservability({ db }): {
  traces: TraceQueries;            // PG store 组装
  audit: { list; listByTarget };   // 查询面;写入用独立原语(事务边界归调用方)
  requestLogs: { insert; list };
  partitions: { traces(opts?); requestLogs(opts) };
}
```

出口面由 `__test__/architecture.test.ts` 快照锁死;adapters 不从根出口导出(§5.3)。

## 3. 并发与性能预算(数字化)

- **观测链路 best-effort,永不反压业务**:SpanBatcher 队列有界(装配注入 max);溢出丢最旧并计数;
  写失败丢整批计数;`push`/`flush`/`record` 任何路径不得抛出。B11 记录:溢出 shift() O(n),
  输入上界 = 接收端 8MB body 的 span 数,不修。
- **内存查看器常数内存**:MAX_TRACES=200 / MAX_SPANS_TOTAL=4000,span 结束即快照(不持活动对象),
  淘汰按插入序最旧 trace 整组删除。
- **分区 DDL 频率**:写入路径 ensure 每进程每天至多一次(闭包 memo);维护函数幂等
  (CREATE IF NOT EXISTS / DETACH+DROP),多副本由 advisory try-lock 串行,未获锁即跳过。
- **热路径零开销**:mode=off 时 initOtel 完全 no-op(业务拿到全局 no-op tracer);
  withAsyncSpan 在 SDK 未启动时退化为纯函数调用。
- **查询窗口**:recent 恒 24h(命中 start_time 索引+分区裁剪);limit 钳 1..100;
  request_logs 列表缺省 30 天窗(与保留期对齐)。

## 4. 依赖与边界

- 依赖:`@tillgate/db`(schema/Db/DbLike/runTx)、`@tillgate/errors`(目录)、`drizzle-orm`、
  `@opentelemetry/*`(api/sdk-node/sdk-trace-base/sdk-metrics/exporters/resources/semantic-conventions)。
- **不依赖 runtime**:Logger 用结构化最小形状 `{ info(obj,msg), warn(obj,msg) }` 本地声明——
  runtime 的 pino Logger 结构兼容,装配自然传入;避免为借用一个类型引入包依赖(§5.1 允许但不必要)。
- 分层纪律:`telemetry/tracing/audit/request-log` 纯逻辑与 port 不 import drizzle 的 SQL 构造
  (类型除外);`adapters/postgres/**` 是唯一 SQL/DDL 层;OTel SDK import 只出现在 `telemetry/**`。
- 错误目录:`observabilityErrors` = defineErrorCatalog('observability', { invalid_otlp_payload,
  otel_endpoint_missing, invalid_partition_day })(§11;码表封闭性由架构测试锁定)。
