# @tokenlens/observability 迁移实现文档

> 状态:已完成(四门全绿,行为对照核销见 MIGRATION.md §6;v2 落地 2008 源行 + 1899 测试行)
> 基线:旧仓 `ai-getway` 的 `packages/tracing`(5 源文件 746 行 + 3 测试 670 行)、
> `packages/core/src/otel.ts`(321 行,零测试)、`packages/repository/src/audit-log.repo.ts`(123 行)、
> `packages/repository/src/usage-log.repo.ts` 的 request_logs 两方法、`packages/http/src/audit.ts`(41 行)、
> `apps/trace-receiver/src/batcher.ts`(103 行)、`apps/admin-api/src/services/tracing.service.ts`(信封层)、
> `apps/worker/src/tasks/partition-maintenance.ts`(113 行)——合计 ~1.9k 行源
> 目标:重构方案 §3.2(`core → runtime + observability` 的 observability 半边)+ P4.5
> 依据:DESIGN.md(契约/预算);本文档管审计/裁决/拆分/测试/顺序

---

## 0. 原则

1. **范围收窄**:旧 usage-log.repo 613 行中只迁 request_logs 写/读两法;usage_logs 全族
   (结算投影/限额读模型/TTFT/统计)归 `billing`(已迁,不重复实现)。
2. **不是复制,是重构**:v1 的模块级全局状态(otel 环形缓冲、partition memo)、class 依赖捕获
   (SpanBatcher/两 SpanProcessor)、自由 Error 类(DecodeError)按铁律 3/5/§11 重写;
   SQL 语义逐句平移。
3. **行为等价**:旧测试是行为规格(§5 迁移矩阵);微修处逐条列 B#/G# 并给理由。

## 1. 外部契约

见 DESIGN.md §2(单一事实源,此处不重复)。

## 2. 审计结论(逐文件四条标准)

### 2.1 真 bug 清单

| #   | 位置                                           | 问题                                                                                                                                                                      | 级别                 | 处置                                                                                                                |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------- |
| B1  | tracing/store.ts channelTopology               | `(array_agg(status_message) filter (where status_code=2))[1]` 无 ORDER BY——PG 聚合顺序未定义,「最近错误」实为**任意序**错误消息(与 max(start_time) 的 lastAt 语义脱节)    | 数据正确性(观测误导) | **修**:`array_agg(status_message order by start_time)`;真 PG 回归用例锁定                                           |
| B2  | core/otel.ts 整文件                            | 321 行**零测试**——环形缓冲淘汰边界、console 处理器分级、traceparent 解析拒绝面、withAsyncSpan 异常路径全部无规格                                                          | 测试债               | v2 补齐(telemetry.test.ts;铁律 16)                                                                                  |
| B3  | http/audit.ts recordAudit                      | `console.error` 硬编码出口——v1 receiver/request-log 同病灶;测试只能劫持 console                                                                                           | 可测性               | sink 的 log 装配注入(缺省 console.error 保底)                                                                       |
| B4  | tracing/store.ts findRecentTraces              | `requestIds` 的 array_agg 无序——`find(id => id != null)` 在多 requestId 共 trace 时取**任意行**                                                                           | 数据正确性(轻微)     | **修**:与 names/parentIds 同序(order by start_time);回归锁定取最早 span 的 requestId                                |
| B5  | tracing otlp-decode promote vs findByRequestId | 写侧 requestId 宽松(任意 ≤64 串)vs 读侧 `[0-9a-zA-Z-]` 严格——写宽读严不一致                                                                                               | 记录不修             | 两道闸各司其职:decode 是 wire 边界(不丢合法数据),读侧 regex 是防注入;口径写入 DESIGN                                |
| B6  | trace-receiver/batcher.ts push                 | 溢出路径 `shift()` O(n)/条——批量上界(8MB body)下可接受                                                                                                                    | 性能(记录)           | 不修;预算见 DESIGN §3                                                                                               |
| B7  | core/otel.ts evictIfNeeded                     | 每次淘汰全量 snapshot keys——MAX_TRACES=200 小常数                                                                                                                         | 性能(记录)           | 不修                                                                                                                |
| B8  | admin-api tracing.service topology             | `store.channelTopology(Math.min(168, Math.max(1, hours)))` 把**小时数当 sinceMs 毫秒时间戳**传入——窗口过滤实际失效(new Date(24)≈1970,恒全量;7 天分区内损害有限但语义错误) | 数据正确性           | **修**:queries.ts 按正确语义换算 `Date.now() - hours*3_600_000`;回归用例锁定窗口裁剪(fake store 断言传入的 sinceMs) |

### 2.2 结构性发现

| #   | 发现                                                                                                | 处置                                                                                                                                              |
| --- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | admin-api tracing.service(信封层:钳位/并行 total/detail 组装)与 tracing 包分离,SQL 在包、口径在 app | 信封随查询能力迁入 `tracing/queries.ts`(D1);app 路由层只剩 HTTP 解析                                                                              |
| S2  | audit 行类型 AuditLogRow 三处漂移中拷贝(repository/control-plane ports/observability 新增)          | observability 成为唯一所有者(D2);control-plane 自有 port 形状保留,P5 桥接时对齐                                                                   |
| S3  | v1 分区维护锁逻辑在 worker(每表手拼 hashtext 键 + try/untry 样板 ×2)                                | 维护函数内置锁(G7);worker 只调用。锁键字符串逐字保留(`ai-gateway:trace-partition`/`ai-gateway:request-log-partition`)——迁移重叠期新旧 worker 互斥 |
| S4  | request_logs 是手写迁移管理的分区母表(db schema 注释:禁 db:generate)                                | 适配器只做运行时 ensure/maintain DDL,不碰 schema 声明                                                                                             |
| S5  | v1 audit 写入双语义散落:http/audit.ts(best-effort)+ audit-log.repo.insert(同事务)                   | 双原语显式化(G1);能力包 port 桥接在 P5 apps assembly 落地                                                                                         |

### 2.3 契约演进(缺口 → 决策)

| #   | 演进                                                                           | 理由                                                                                        |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| G1  | 审计写入双原语:`writeAudit`(同事务,抛)+ `createBestEffortAuditSink`(旁路,不抛) | §3.4「安全/权限/资金审计不得降级为提交后 best-effort」——两种语义都是包级契约,不再由调用方拼 |
| G2  | initOtel authToken 不再回落 `process.env.TRACE_RECEIVER_TOKEN`                 | 铁律 3 零隐藏默认;装配(app config)显式传入                                                  |
| G3  | otel memory 环形缓冲从模块全局改为 `createMemoryTraceViewer()` 工厂闭包        | 铁律 3(不藏全局状态)+ 可多实例测试                                                          |
| G4  | partition `ensured` memo 从模块全局移入 PG store 闭包                          | 同上;维护路径靠 listPartitionDays 差集判定,不依赖 memo                                      |
| G5  | SpanBatcher/InMemorySpanProcessor/LogSpanProcessor class → 工厂闭包            | 铁律 5(SpanProcessor 接口用对象字面量结构化满足)                                            |
| G6  | `DecodeError` 自由类 → `observabilityErrors.business('invalid_otlp_payload')`  | §11 目录码;接收端(P5)按码映射 400                                                           |
| G7  | 维护函数内置 advisory try-lock(未获锁返回空结果=跳过)                          | S3;v1 worker 行为等价                                                                       |
| G8  | `buildTraceGraph` 只从包出口供服务端消费                                       | §2.2:admin 前端直依赖 `@tokenlens/tracing` 是 P5 要清除的越界;v2 不设前端子入口             |
| G9  | `initOtel` 返回 `memory?: MemoryTraceViewer`(mode=memory 时)                   | G3 的配套——查看页数据源从全局函数改为返回句柄                                               |

## 3. 逐模块裁决表

| 旧文件                                              | 行数 | 裁决      | 审计状态                                                                 | 动作                                                                                                                                                                   |
| --------------------------------------------------- | ---- | --------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| tracing/types.ts                                    | 71   | 复制      | 无缺陷                                                                   | 平移 + TraceStore 注释口径保留                                                                                                                                         |
| tracing/otlp-decode.ts                              | 191  | 复制+微修 | B5 记录                                                                  | DecodeError→目录码(G6);截断/提升/跳过语义逐字节保持                                                                                                                    |
| tracing/store.ts                                    | 220  | 复制+微修 | B1/B4 修复                                                               | 拆:port 留 tracing/types;SQL → adapters/postgres/trace-store;memo 闭包化(G4)                                                                                           |
| tracing/partition.ts                                | 99   | 复制+微修 | 无缺陷                                                                   | 纯日期助手留 tracing/partition;DDL → adapters/postgres/trace-partitions(锁内置 G7)                                                                                     |
| tracing/graph.ts                                    | 204  | 复制      | 无缺陷(测试标题 hasErrorSummary 系陈旧措辞,断言实为 hasError/errorCount) | 平移;12 用例全移植                                                                                                                                                     |
| trace-receiver/batcher.ts                           | 103  | 重构      | B6 记录                                                                  | class→工厂闭包(G5)→ tracing/ingest;best-effort 契约注释原样                                                                                                            |
| trace-receiver/app.ts / index.ts / token-compare.ts | 189  | 不移植    | —                                                                        | HTTP 面/入口/令牌比较是 app 装配(P5);token-compare 与 http/csrf 的合并另议                                                                                             |
| core/otel.ts                                        | 321  | 重构      | B2/B7                                                                    | 拆 6 文件入 telemetry/(api/init-otel/memory-viewer/log-span-processor/trace-parent/with-span);G2/G3/G5/G9                                                              |
| repository/audit-log.repo.ts                        | 123  | 重构      | 无缺陷                                                                   | list/listByTarget → adapters/postgres/audit-queries;insert → writeAudit 原语;listCatalogPriceHistory **不迁**(action 词表是 control-plane 语义,已在其 AuditStore port) |
| http/audit.ts                                       | 41   | 重构      | B3                                                                       | → createBestEffortAuditSink(log 注入)                                                                                                                                  |
| usage-log.repo.ts insertRequestLog/listRequestLogs  | ~120 | 复制+微修 | 无缺陷                                                                   | → adapters/postgres/request-log-store;RepoContext → 直接收 Db                                                                                                          |
| worker partition-maintenance.ts                     | 113  | 重构      | 无缺陷                                                                   | maintainRequestLogPartitions DDL → adapters/postgres/request-log-partitions;锁样板并入两维护函数(S3/G7)                                                                |
| admin-api tracing.service.ts                        | ~90  | 复制+微修 | 无缺陷                                                                   | 信封 → tracing/queries.ts(D1/S1);DbTx 上下文消失(直接 store)                                                                                                           |
| admin-api ops-logs.service.ts 其余                  | ~200 | 不移植    | —                                                                        | usage/payment/generation/stats 族归各自能力(billing 已有读侧);audit/requestLogs 两法归本包                                                                             |

## 4. 拆分决策(引用审计证据)

- 目录 = 目标树:`telemetry/ tracing/ audit/ request-log/ adapters/postgres/ + observability.ts + errors.ts`。
- tracing 内五件套 decode/ingest/store(port)/graph/partition(纯)+ queries(信封,S1);
  SQL/DDL 全部下沉 adapters/postgres——「store 在 tracing、SQL 在 adapters」与能力包
  ports←adapters 同构,不为例外(§3.3)。
- audit 与 request-log 体量小(词表+两三查询),不设 domain/application 分层(§3.3 禁目录对称仪式)。
- OTel SDK import 只出现在 telemetry/**(架构测试锁定)——将来把 telemetry 独立成子入口时零牵连。
- TraceStore/审计写入的 DbLike 参数形态对齐 v2 db 包(`writeAudit(db, …)` 显式收连接,
  与 accounts AuditPort 同构,P5 桥接零适配)。

## 5. 测试计划(先行)

迁移矩阵见 MIGRATION.md §0;新增门禁:

- **B1 回归**:channelTopology 多错误 span 乱序写入,lastError == 时间最晚的错误消息。
- **B4 回归**:同 trace 两 span 异 requestId,summary.requestId == startTime 较早者的 requestId。
- **B2 补齐**(v1 无规格):环形缓冲双上限淘汰/查看页排序清空;console 处理器 error→warn;
  traceparent 非法形状拒绝;withAsyncSpan 用 BasicTracerProvider+InMemorySpanExporter 验证
  终态与 recordException(真实 SDK,不 mock)。
- **架构测试**:出口面快照;依赖白名单(禁 http/ai/runtime/能力包/apps;OTel 只在 telemetry/;
  drizzle 只在 adapters/);码表封闭(== DESIGN §4)。
- **真 PG**(`postgres.real.test.ts`,文件名区分默认门禁):store 写/幂等/点查/recent/errorsOnly/
  topology/stats;分区 ensure 幂等+maintain 预建清理;writeAudit 同事务回滚语义(runTx 抛→无审计行);
  best-effort sink 失败不抛;request_logs insert/list 过滤/sort;月分区维护。数据纪律:`trt-` 前缀自建自清。
- 覆盖率:adapters/postgres 与 index.ts 桶排除(真实 SQL 行为归 real 测试,control-plane 先例);
  阈值 90/85 不降。

## 6. 实施顺序(单原子提交,控制-plane 先例:全新包、旧仓只读)

1. package.json/tsconfig/vitest.config + errors.ts + 词表层(types)
2. tracing 纯逻辑:decode/graph/partition 助手 + 单测移植
3. ingest(工厂闭包)+ queries(信封)+ 单测
4. telemetry 六件 + 单测(B2 补齐)
5. adapters/postgres 五件 + real 测试
6. observability.ts facade + index.ts + 架构测试
7. 四门 + 覆盖率 + MIGRATION 核销

## 7. 待办挂账

- G1 桥接:accounts/control-plane 的 AuditPort 改由 apps assembly 桥接本包原语——P5 apps 波次。
- D2:control-plane AuditStore(价格溯源)与 observability AuditLogRow 形状合并——P5 桥接时裁决。
- token-compare(trace-receiver)与 http 常量时间比较的合并——P5 trace-receiver app 落地时。
- 审计保留策略(分区/清理)——v1 无此行为,升格需独立裁决(§3.4「保留」的完整落地)。
