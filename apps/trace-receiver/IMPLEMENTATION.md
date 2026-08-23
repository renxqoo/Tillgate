# @tokenlens/trace-receiver 迁移实现文档

> 状态:已完成(v2 落地;v2 仓库**第一个 app**,apps/ 装配范式先例)
> 基线:旧仓 `ai-getway/apps/trace-receiver`(src 4 文件 292 行 + receiver.test.ts 218 行;
> 其中 batcher 103 行已于 observability 波次迁入 `tracing/ingest`,本波只落 HTTP 面/入口/装配)
> 目标:重构方案 §3 目标树 `apps/trace-receiver`(OTLP 接收部署单元)+ P5;
> observability IMPLEMENTATION §3「不移植(app 装配 P5)」三项的本波兑现
> 关联:packages/observability/{DESIGN,IMPLEMENTATION,MIGRATION}.md、本包 MIGRATION.md

---

## 0. 原则

1. **薄 app**:业务能力(decode/ingest/store/OTel)全部来自 `@tokenlens/observability`;
   app 只持有 config/assembly/HTTP 面/进程生命周期(§4.1 准入:进程入口+装配+单部署面)。
2. **行为等价**:v1 receiver.test.ts 的 HTTP 面段(4 用例)是行为规格;错误信封码按 v2
   目录体系演进(见 §2 G6'),语义(status/触发条件)逐项保持。
3. **不复制已迁代码**:batcher/decode/store 一律 import,零本地重实现(铁律 8)。

## 1. 外部契约

- `POST /v1/traces`(bodyLimit 8MB):OTLP/HTTP JSON → 解码 → 批量入队 →
  `202 { accepted, skippedMalformed, droppedOverflow }`(best-effort,过载丢弃见 stats)。
- `GET /readyz`:DB 探活(豁免鉴权——K8s/compose healthcheck 不带 Bearer);
  `{ status, dependencies: { postgres } }`,失败 503。
- `GET /internal/stats`:`{ batcher, storage }`;存储查询失败 → `storage: null`
  不掩盖 batcher 指标。
- 鉴权:`Authorization: Bearer <token>` 常量时间比较;未配置令牌(开发内网)放行。
- 错误信封(v2 目录码,出站 status 经 http 修正表):
  401 `http.unauthorized` / 415 `http.unsupported_media_type`(protobuf 场景 context 带
  改配 http/json 提示) / 413 `http.payload_too_large` / 400 `http.invalid_json` /
  400 `observability.invalid_otlp_payload`。

## 2. 契约演进(相对 v1)

| #   | 演进                                                                                | 理由                                                                                                              |
| --- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| R1  | 错误信封码 `UNAUTHORIZED/UNSUPPORTED_MEDIA_TYPE/INVALID_JSON/INVALID_OTLP` → 目录码 | §11/ADR-0001;新增 `http.unauthorized`、`http.unsupported_media_type` 两码(本波入 http 目录,status 修正表 401/415) |
| R2  | `DecodeError instanceof` → 流动错误直落 onError(合成目录渲染 400)                   | G6 兑现:「接收端按码映射 400」——app 不写 instanceof 翻译表                                                        |
| R3  | `token-compare.ts` 本地拷贝删除 → `@tokenlens/http timingSafeTokenEqual`            | observability IMPLEMENTATION §7 挂账#3 兑现;worker 健康令牌/client-api webhook 签名(P5)自此同源消费               |
| R4  | `DATABASE_URL` 必填(v1 藏默认连接串)                                                | v2 db 包零缺省(observability B2 同裁决);缺省值唯一归属 config 层                                                  |
| R5  | 令牌校验 `z.string().min(16)` → `secretSchema` 三道门(≥16/非已知弱值/≥4 种字符)     | runtime 组装件复用;弱值启动即拒绝                                                                                 |
| R6  | `NODE_ENV` 纳入 schema                                                              | v1 从 strip 后的 parse 结果读它,生产令牌检查**恒不触发**(潜在缺陷,已修;MIGRATION 记录)                            |
| R7  | 优雅停机手写样板 → `runtime createShutdown`(closeables 挂 batcher)                  | 三 app 漂移拷贝合一件(runtime S1/D1);收口顺序归 runtime 契约                                                      |
| R8  | `drizzle sql\`select 1\``readyz →`db ping()`                                        | app 不直接 import drizzle;源头分类归 db 包                                                                        |
| R9  | `SpanBatcher` class → `createSpanBatcher` 工厂闭包                                  | observability G5 已裁决,此处仅消费面                                                                              |

## 3. 拆分决策

- 目录 = 目标树 `src/{index,config,assembly,app}.ts`;测试按铁律 14 落包根 `__test__/`
  平铺(目标树草图 `test/` 由铁律 14 统一,与全仓 12 包先例一致——不为例外)。
- `config.ts`:env schema(zod)+ 模式推导(开发 memory/生产 off)+ 生产令牌 fail-fast
  (superRefine);otlp 缺端点 fail-fast 单一所有者是 initOtel(assembly 调用即触发),
  config 只透传——同一真相只定义一次。
- `assembly.ts`:唯一装配根;`@tokenlens/observability/composition` 仅此处引用(§5.3
  白名单:apps assembly)取 `createPgTraceStore` 直组 store+batcher。
- `app.ts`:纯函数 `createReceiverApp(deps)`(可测,零 env/process);onError 装配
  `composeErrorCatalogs(HttpErrors, observabilityErrors)` + `pgSqlState` 探测注入。
- `index.ts`:进程入口(listen/信号注册/停机编排),不持业务;唯一覆盖率排除项
  (vitest.config 口径申报:停机编排件在 runtime 包已测)。
- PG 池部署定值(10/30s/5s/1000)由 config 层显式持有:接收端是低流量诊断服务,
  db 包全必填无缺省(铁律 3)。

## 4. 测试计划(先行)

- 单测(config 19 / receiver 9 / assembly 2):缺省值表、模式推导、fail-fast 闸、
  令牌三道门、鉴权门(401/豁免/开放)、媒体类型门(415×2 带 hint context)、
  坏 JSON/结构非法 OTLP 目录码、bodyLimit 413、202 计数算术、readyz 形状、
  stats 双形态、装配 fail-fast(otel_endpoint_missing)与 off 模式全链。
- 真 PG(receiver.real 4):v1 HTTP 面段四用例行为等价(bodyLimit/token 门/
  415+400 信封/端到端 POST→flush→request_id 点查含 userId=7 提升断言)。
- http 包:+2 目录码封闭(catalog 15 码)、status 修正表 401/415、token-compare 语义。

## 5. 待办挂账

- bun.lock 多会话共写:本波新增 `apps/trace-receiver` 条目已落 lock,但 lock 同时混有
  并行会话条目(accounts 等)——按铁律 15 不随本波提交,协调后收口。
- 全仓 oxfmt --check 存量漂移(144 文件,HEAD 即不通过 0.62.0 检查):非本波引入,
  不在本波扩散;格式归一需独立波次与并行会话协调。
- `/livez` 路由未建(仅鉴权豁免)——v1 同形;需要进程内探活时再补(无消费方,不预建)。
