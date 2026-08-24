# @tokenlens/trace-receiver 设计基线（DESIGN）

> 状态：定稿（2026-08-23 补档——app 已落地并核销，行为规格与测试矩阵见 [MIGRATION.md](./MIGRATION.md)）
> 迁移单元：OTLP 接收**部署单元**的 HTTP 面 / 入口 / 装配（batcher/decode/store 机制已在
> observability 波次先行——本 app 只消费，不重实现）
> 旧实现：`/Users/wrr/work/ai-getway/apps/trace-receiver`（src 4 文件 292 行 +
> receiver.test.ts 218 行；其中 batcher.ts 103 行已迁 `observability/tracing/ingest`）
> 目标位置：`/Users/wrr/work/TokenLens-v2/apps/trace-receiver`
> 关联：[project-structure-refactoring.md](../../docs/project-structure-refactoring.md) §3（目标树
> `apps/trace-receiver`）+ §9 P5；[packages/observability/DESIGN.md](../../packages/observability/DESIGN.md)
> （OTLP 解码/摄入/存储归它，「OTLP 接收 HTTP 面」明确归本 app）；
> 施工图见 [IMPLEMENTATION.md](./IMPLEMENTATION.md)（R# 契约演进编号出处）

---

## 0. 原则

1. **薄 app**：业务能力（decode/ingest/store/OTel）全部来自 `@tokenlens/observability`；
   app 只持有 config / assembly / HTTP 面 / 进程生命周期（总纲 §4.1 准入：进程入口 + 装配 +
   单部署面）。v2 仓库第一个 app，apps 装配范式先例。
2. **不复制已迁代码**（铁律 8）：batcher/decode/store 一律 import；本 app 全部源码 4 文件
   ~307 行（index/config/assembly/app）。
3. **行为等价**：v1 receiver.test.ts 的 HTTP 面段（4 用例）是行为规格；错误信封码按 v2
   目录体系演进（R1/R2），status 与触发条件逐项保持。
4. **P5 边界**：app 非 assembly 代码不引用 `Db/DbTx` 类型与 composition 子入口——DB 探活
   以 `pingDb` 闭包在装配面绑定（R10），架构测试机器锁定。

## 1. 外部契约

```ts
// ---- HTTP 面（createReceiverApp(deps): Hono 纯函数,零 env/process）----
POST / v1 / traces; // OTLP/HTTP JSON（ExportTraceServiceRequest）,bodyLimit 8MB
//   → 解码 → 批量入队 → 202 { accepted, skippedMalformed, droppedOverflow }
//   best-effort:过载丢最旧并计数,观测链路故障不反压接收
GET / readyz; // DB 探活(豁免鉴权——K8s/compose healthcheck 不带 Bearer)
//   { status, dependencies: { postgres } },失败 503
GET / internal / stats; // { batcher, storage };存储查询失败 → storage: null 不掩盖 batcher 指标

// deps: { pingDb, store, batcher, token?, logger? }
//   token 未配置(开发内网)放行;生产强制由 config 层 fail-fast(R6:生产缺令牌拒绝启动)
```

- **鉴权**：`Authorization: Bearer <token>`，`timingSafeTokenEqual` 常量时间比较
  （`@tokenlens/http`，长度差异哑比较抹平）；未配置令牌时放行。
- **错误信封**（v2 目录码，onError 合成目录 `composeErrorCatalogs(HttpErrors, observabilityErrors)`
  - `pgSqlState` 探测注入）：401 `http.unauthorized` / 415 `http.unsupported_media_type`
    （protobuf 场景 context 带改配 http/json 提示）/ 413 `http.payload_too_large` /
    400 `http.invalid_json` / 400 `observability.invalid_otlp_payload`。
- **配置面**（config.ts，zod）：`DATABASE_URL` 必填（v1 藏默认连接串已清除，R4）；
  `TRACE_RECEIVER_TOKEN` 三道门（≥16 / 非已知弱值 / ≥4 种字符，R5）；`NODE_ENV` 纳入 schema
  （R6——v1 从 strip 后的 parse 结果读它，生产令牌检查恒不触发的潜在缺陷已修）；
  端口 8793 / batch 500 / flush 2s / queue 10_000 等部署缺省值由本层显式持有（铁律 3）；
  OTel 模式缺省推导：开发 `memory` / 生产 `off`，otlp 缺端点由 initOtel fail-fast
  （单一所有者，config 只透传）。

## 2. 问题域

**处理**：OTLP/HTTP JSON 接收的 HTTP 协议面（媒体类型门 / 载荷门 / 解码失败目录化）、
鉴权门、readyz 探活、运行指标暴露、env 校验与缺省推导、装配（store+batcher 直组）、
进程入口与优雅停机。

**明确不处理**（归属写明）：

| 不处理                                      | 归属                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------- |
| OTLP JSON 解码 / span 批量摄入 / 日分区存储 | `@tokenlens/observability`（composition 子入口取件）                 |
| flush 定时器 / 队列丢弃 / 写失败计数机制    | observability `createSpanBatcher`（B6 溢出路径 O(n) 在案）           |
| 错误渲染 / 信封 / 目录码 / 常量时间比较原语 | `@tokenlens/http`（errorHandler / timingSafeTokenEqual）             |
| PG 连接 / ping / SQLSTATE 分类 / 池         | `@tokenlens/db`（装配面 createDb/ping/pgSqlState）                   |
| 停机编排 / 日志 / 密钥三道门                | `@tokenlens/runtime`（createShutdown / createLogger / secretSchema） |
| OTel SDK 装配与自身遥测推送                 | observability `initOtel`（assembly 调用）                            |
| `/livez` 进程内探活                         | 未建（v1 同形；有消费方再补，不预建）                                |

## 3. 装配形态（P5 边界）

```text
src/index.ts（进程入口：listen/信号注册/停机编排——不持业务）
  └─ src/assembly.ts（唯一装配根）
      ├─ loadTraceReceiverConfig(env)
      ├─ createDb(config.dbPool + url) ─→ createPgTraceStore（observability/composition，仅此处引用）
      ├─ createSpanBatcher(store, { batchMax, flushIntervalMs, queueMax })
      ├─ initOtel / createLogger
      └─ createReceiverApp({ pingDb: () => ping(db), store, batcher, token, logger })
src/app.ts（纯函数 HTTP 面： onError 合成目录 + pgSqlState 纯函数注入——Db 类型的唯一豁免）
```

- `pgSqlState` 是纯 SQLSTATE 分类函数（http errorHandler 的文档化注入点），
  非 Db 类型——app.ts 引用它不违反 R10（架构测试白名单该项）。
- 架构测试（`__test__/architecture.test.ts`）锁定：src 四件套快照；composition 子入口
  只在 assembly.ts；`@tokenlens/db` 装配件与 `Db/DbTx` 类型只在进程装配面；跨包 import
  只走显式包名（禁 src 深导入）。

## 4. 并发与性能预算（app 级口径；机制归 observability）

- 请求体上界 **8MB**（content-length 快路径 413 免读流 + 流式计数兜底）；OTLP JSON 批次
  远小于此。
- 摄入队列上界 **10_000** span（满丢最旧并计数；溢出路径 O(n)/条在案——observability B6）；
  flush 定量 **500** / 定时 **2s**，写失败丢整批计数不抛。
- flush 定时器 `unref`（不阻止进程退出）；停机宽限 **10s**（createShutdown，batcher 在
  closeables 尽力排空，持续失败放弃）。
- PG 池定值 **10 连接**（10/30s/5s/1000，config 层显式持有；低流量诊断服务画像，
  双副本 ×10 ≪ PG 常见 max_connections）。
- 鉴权比较常量时间；令牌 ≥16 字符、非已知弱值、≥4 种字符（secretSchema）。

## 5. 演进与显式挂账

- bun.lock 多会话共写、全仓 oxfmt 存量漂移：非本 app 引入，按铁律 15 不扩散
  （IMPLEMENTATION §5）。
- `http` 目录因本 app 扩两码：`unauthorized`（401）/ `unsupported_media_type`（415）——
  加法变更，封闭清单 15 码在 http 侧测试锁定。
