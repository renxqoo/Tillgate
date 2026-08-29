# @tillgate/trace-receiver —— OTLP 接收部署单元（内网）

OTLP/HTTP JSON 接收 → 批量写 PG 日分区（trace_spans）；**过载即丢，绝不反压业务**。
薄 app：decode/ingest/store/OTel 全部来自 `@tillgate/observability`，本 app 只持有 config、assembly、HTTP 面与进程生命周期（v2 仓第一个 app，装配范式先例）。

错误目录 [ADR-0001](../../docs/adr/0001-errors-registry-ownership.md)

## 核心能力

- `POST /v1/traces`（body 上限 8MB，超限 content-length 快路径 413）：OTLP/HTTP JSON → `decodeOtlpJson` → `createSpanBatcher` 批量入队 → 批量写 PG **日分区**（写前 ensure，幂等）；响应 `202 { accepted, skippedMalformed, droppedOverflow }`
- **best-effort 摄入**：队列上界 `TRACE_QUEUE_MAX`（缺省 10_000 span），满丢最旧并计数；flush 定量 `TRACE_BATCH_MAX`（500）/定时 `TRACE_FLUSH_INTERVAL_MS`（2s）；写失败丢整批计数不抛——观测链路任何故障不反压接收端
- `GET /readyz`：DB 探活（豁免鉴权，K8s/compose healthcheck 不带 Bearer），失败 503
- `GET /internal/stats`：`{ batcher, storage }`；存储查询失败 → `storage: null` 不掩盖 batcher 指标
- 停机：`runtime createShutdown`（closeables 挂 batcher 尽力排空，宽限 10s）；flush 定时器 `unref`

## 目录结构（src/）

```
config.ts      # env zod schema（DATABASE_URL 必填；生产令牌 fail-fast）
assembly.ts    # 唯一装配根（observability/composition 仅此处引用：store + batcher 直组）
app.ts         # 纯函数 createReceiverApp(deps)（可测，零 env/process）
index.ts       # 进程入口
```

## 配置与端口

- 端口 `8793`（`TRACE_RECEIVER_PORT`）；必填 `DATABASE_URL`（v1 藏默认连接串已废除，db 包零缺省）；PG 池定值 10 连接
- **鉴权**：`Authorization: Bearer <TRACE_RECEIVER_TOKEN>`，常量时间比较（令牌 ≥16、非已知弱值、≥4 种字符）；未配置令牌 = 开发内网放行，**生产未配置启动期 fail-fast**；401 `http.unauthorized`
- OTel：`OTEL_TRACES_MODE=off|memory|console|otlp`（缺省开发 memory / 生产 off）；其余 400/413/415 信封码见 IMPLEMENTATION §1

## 装配与依赖

- `@tillgate/observability`（decode/batcher/pg trace store + initOtel）、`@tillgate/observability/composition`、`@tillgate/runtime`（createLogger/createShutdown/secretSchema）、`@tillgate/db`、`@tillgate/http`（`timingSafeTokenEqual`）、`@tillgate/errors`
- 发送侧对位：gateway/client-api/admin-api/worker 的 OTLP 推送以 `TRACE_RECEIVER_TOKEN` 同键鉴权

## 本地运行与测试

```bash
bun dev        # 仓库根（--env-file=../../.env --watch src/index.ts）
cd apps/trace-receiver
bun run typecheck && bun run lint && bun run test
bun run test:real     # receiver.real.test.ts：真实 PG 集成
```
