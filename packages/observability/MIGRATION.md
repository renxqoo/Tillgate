# observability 迁移文档(MIGRATION.md)

> 状态:已核销(行为对照逐项落位于 `__test__/*.test.ts`;验收数字见 §6)
> 迁移单元:可观测四件套——OTel 装配(telemetry)、链路追踪(tracing:decode/ingest/store/graph/partition)、
> 审计存储与查询(audit)、请求日志(request-log)——共享装配与观测数据等级(best-effort 不反压)
> 旧实现:/Users/wrr/work/ai-getway(packages/tracing + core/otel.ts + repository 审计与请求日志两法 +
> http/audit.ts + trace-receiver/batcher + worker 分区维护 + admin tracing.service,~1.9k 行源)
> 目标位置:packages/observability
> 关联:DESIGN.md / IMPLEMENTATION.md(B#/D#/G# 引用彼处)

## 0. 测试迁移总矩阵(旧文件 → 新去处)

| 旧测试(用例数)                                                 | 新去处                            | 动作                                                                            |
| -------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------- |
| tracing `__tests__/otlp-decode.test.ts` (6)                    | `__test__/tracing-decode.test.ts` | 改写:DecodeError 断言→目录码;补截断/提升列边界(B5 口径)                         |
| tracing `__tests__/graph.test.ts` (12)                         | `__test__/tracing-graph.test.ts`  | 移植:纯函数原样(标题陈旧措辞随迁修正)                                           |
| tracing `__tests__/store-partition.test.ts` (4,真 PG)          | `__test__/postgres.real.test.ts`  | 移植+改写:import 路径/清理纪律保持                                              |
| trace-receiver `__tests__/receiver.test.ts` SpanBatcher 段 (2) | `__test__/tracing-ingest.test.ts` | 改写:fake store;补定时 flush/close 排空/计数器                                  |
| trace-receiver HTTP 面段 (4,真 PG)                             | 不迁                              | app 层(P5 trace-receiver);batcher/store/decode 的端到端由 real 测试覆盖同等链路 |
| core/otel.ts 相关(0——v1 无测试,B2)                             | `__test__/telemetry.test.ts`      | 新增:四模式/环形缓冲/处理器/traceparent/withAsyncSpan                           |
| admin-api ops.test.ts 中 audit/requestLogs 断言                | `__test__/postgres.real.test.ts`  | 改写:HTTP 信封断言→store 断言(过滤/sort/total)                                  |
| admin-api e2e-auth-audit / gateway surface.test.ts 请求日志段  | 不迁(本轮)                        | HTTP 中间件行为归 P5 apps;写入原语由 real 测试锁定                              |

**删除的旧用例**:receiver HTTP 面与 middleware 两段(归属 P5,非功能缺失,裁决见 IMPLEMENTATION §3)。

## 1. 行为规格基线(逐项核销清单)

### 1.1 decode(otlp-decode)

结构级错误(非对象/缺 resourceSpans)抛 400 语义错误;单 span 畸形(非法 hex id/长度超限/
坏时间/end<start)跳过计数不丢整批;属性提升 request.id|request_id|requestId / user.id(正整数)/
channel.key|channel / ai.model|model,长度门 64/64/128,不合法置 null;截断 name 256/service 64/
statusMessage 512/event name 128;nano→Date;status 数值 0..2 与枚举名尾缀都接受;
events 时间坏值回落 startTime;parentSpanId 非 hex 置 null;缺 service.name 兜底 unknown;
嵌套 array/kvlist 归一化。

### 1.2 store(partition+point+recent+topology+stats)

批量 INSERT 主键 (start_time,span_id) 冲突忽略(SDK 重发幂等),durationMs 存储端重算;
写入行所在 UTC 日自动 ensure 分区;recent 恒 24h 窗,limit 钳 1..100 缺省 50,errorsOnly 是
trace 级语义(ERROR span 的 trace 全保留),minDurationMs 走 HAVING;聚合数组 array_to_json
显式序列化;root = 首个 parent 不在集合内的 span;count 与 recent 同过滤;
findByTraceId/ByRequestId regex 白名单(防注入)不合式返回 [];
topology 只统计 service='gateway' 且 name like 'upstream%',窗口按 hours 正确换算为 sinceMs
(v1 admin 信封层把小时数当毫秒时间戳传入,B8 修复),last_error 取**时间最晚**错误(B1 修复);
stats 返回行数/最老天数/分区列表。

### 1.3 partition

dayKey UTC;ensure CREATE IF NOT EXISTS 显式 +00 边界;listPartitionDays 只认 `trace_spans_p` 前缀;
maintain 预建 lookahead(缺省 2)+ 按 retention(缺省 7)DETACH+DROP 超期;幂等。

### 1.4 ingest(SpanBatcher)

有界队列满丢最旧并计数返回;定量(≥batchMax)/定时(interval)触发 flush;写失败丢整批计数+
记 lastError,不抛不重试;start 幂等且 timer unref;close 尽力排空(持续失败放弃);stats 全计数器。

### 1.5 graph

kind 推断(upstream*/stream.relay/billing.*/worker→settle/http 属性或 `VERB /` 形状/其余 generic);
status:statusCode=2→error、1→ok、http 用状态码兜底(≥400 error);subtitle 五族(http method·status、
upstream 渠道·模型、stream 中断原因·字节、billing/settle 金额或 token 汇总且 estimated 前缀、
释放型「已释放 X 元 · 未扣费」);执行线:同父兄弟按开始时间,首接父(child),后续连前一个
(upstream 相邻=fallback,其余=next);孤立碎片只出节点;step 全局 1 基序号;totals=最早 start 到最晚 end。

### 1.6 telemetry

四模式:off 完全 no-op;memory=环形缓冲处理器(查看页数据源);console=每 span 一行
(error→warn 其余 info);otlp=BatchSpanProcessor→collector+10s 周期 metrics,双通道同 Bearer 令牌;
otlp 缺 endpoint fail-fast;traceparent 格式 `00-{traceId}-{spanId}-01`(无效上下文 null)、
解析拒绝非 `00` 版本/非 hex/非 0[01] flags;withAsyncSpan 异常→ERROR+recordException 后上抛;
tracer/meter 未启动 SDK 时 no-op 零开销。

### 1.7 audit

list:q ilike 命中 action/targetType/targetId(LIKE 转义),sortBy id/action/createdAt + id 决胜,
rows+total 并行;listByTarget 精确 targetType+targetId 倒序分页;同事务写入失败随业务回滚不吞;
best-effort 写入失败不抛、记日志。价格溯源查询(listCatalogPriceHistory)留在 control-plane
(action 词表所有者),不随迁。

### 1.8 request-log

insert 全字段落库(attempts 走列缺省 1);list:缺省 30 天窗,statusCode 数值或 2xx/4xx/5xx 分组,
q 命中 path/errorCode/sourceIp/requestId::text,四列排序 + id 决胜,user左联带出 displayName 兜底 email;
月分区维护:当月+次月预建,超期(缺省保留窗)DETACH+DROP,分区名 `request_logs_YYYY_MM`。
requestSummary 是截断摘要(嗅探逻辑在 P5 gateway 中间件)。

## 2. API 对照(节选)

| 旧签名                                         | 新签名                                                           | 变化理由                       |
| ---------------------------------------------- | ---------------------------------------------------------------- | ------------------------------ |
| `decodeOtlpJson` throw `DecodeError`           | throw `observabilityErrors` `observability.invalid_otlp_payload` | §11 目录码(G6)                 |
| `class SpanBatcher`                            | `createSpanBatcher(store, opts)`                                 | 铁律 5 工厂闭包(G5)            |
| `getRecentTraces()`/`clearRecentTraces()` 全局 | `initOtel(...).memory.recent()/clear()`                          | 不藏全局(G3/G9)                |
| `initOtel({authToken?})` 回落 env              | 显式参数,无回落                                                  | 铁律 3(G2)                     |
| `maintainPartitions(db,opts)` + worker 持锁    | `maintainTracePartitions(db,opts)` 内置 try-lock                 | 锁属保留策略(S3/G7)            |
| `recordAudit(db,input)`(http 包)               | `createBestEffortAuditSink(db,log?).record(entry)`               | 双原语显式化(G1);log 注入(B3)  |
| `repos.auditLog.insert(c,input)`               | `writeAudit(db,entry)`                                           | RepoContext→DbLike(v2 db 形态) |
| `store + admin tracing.service` 两层           | `createTraceQueries(store)` 信封入包                             | S1/D1                          |
| `@ai-gateway/tracing/graph` 子入口(前端直依赖) | 根出口 `buildTraceGraph`,仅服务端                                | G8 越界清除                    |

## 3. 逐模块裁决 / 4. 测试矩阵

见 IMPLEMENTATION.md §3 / 本文 §0(单一事实源原则不重复)。

## 5. 回滚方案

- **落地提交:da1b237**(并行会话将共享暂存区一并提交——本包 37 文件与 notifications
  3 文件同落该提交;revert 整个提交会连带回退 notifications 拆分,需按文件路径定向回退
  或协调后处理。此为 ironlaw 15 的实测教训:多会话共享暂存区,commit 前必须核对
  `git status` 暂存清单只含自己路径)。
- 全新包、旧仓只读不动:上述提交即回滚单元(revert 整体还原到包前状态;control-plane
  先例——缺 index.ts 的中间态无法保持 build 门绿,阶段边界以目录与测试文件边界保留)。
- 无 DDL 变更(trace_spans/request_logs 分区母表与 75 条迁移已在 @tokenlens/db 先行合入;
  运行时 ensure/maintain DDL 与 v1 逐字兼容——分区命名/边界/锁键不变,新旧进程可互换执行)。
- bun.lock 多会话共写:依赖条目落 lock 但不随本波提交(ironlaw 15,协调后收口)。

## 6. 验收(全部满足才算完成)

- [x] 四门全绿(typecheck OK / oxlint 0 warn 0 err / 64 单测 + 11 真 PG / build 39.18+18.79 KB;
      根 oxfmt --check 通过;turbo 管线 filter 本包 6/6)＋
      覆盖率 lines 97.00 / branches 87.06 / functions 97.33 / statements 94.00 ≥ 90/85/90/90
      (index/composition 出口桶与 adapters/postgres 排除口径在 vitest.config 注释申报)
- [x] §1 行为规格逐项核销(decode 9 / graph 13 / ingest 6 / queries 5+分区助手 / telemetry 17 /
      facade 1 / architecture 10;真 PG:store 4 含 B1/B4 回归、分区 1、audit 3、request-log 2 含月分区、facade 1)
- [x] B1/B4 回归用例通过;B2 补齐的 telemetry 规格全绿(17 用例,含 OTel v2 管线驱动 withAsyncSpan)
- [x] 真 PG 集成(store/分区/审计同事务回滚与 best-effort 吞错/请求日志过滤/月分区)11/11 通过
- [x] 架构测试锁死(10 项):根出口 20 值导出 + composition 9 值导出快照、依赖方向扫描
      (禁 http/ai/runtime/能力包/apps;OTel 只在 telemetry;drizzle 只在 adapters;
      db 值导入只在 adapters;adapters 只由 facade 与 composition 装配;
      composition 不被包内业务代码引用)、码表 3 项封闭
- [x] §7.1 产物元数据合规:内部包不生成声明文件,顶层不设指向 dist/*.d.ts 的 `types` 字段
      (仅 exports.types → src;billing/api-client/accounts 同款,与 control-plane/ai/db 的存量陈旧顶指不同——
      那是待清偿债,不在本波扩散范围)
