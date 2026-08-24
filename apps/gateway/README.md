# @tokenlens/gateway —— 模型推理公网入口

OpenAI/多协议推理入口（端口沿用 v1 `8080`）：协议适配 + 鉴权 + 限流 + 装配。
推理编排、候选循环、计价收据、渠道健康全部来自 `@tokenlens/inference` facade——app 零第二套业务规则。

设计基线 [DESIGN.md](./DESIGN.md) · 施工图 [IMPLEMENTATION.md](./IMPLEMENTATION.md) · 迁移核销 [MIGRATION.md](./MIGRATION.md) · 相关 [ADR-0004](../../docs/adr/0004-upstream-4xx-passthrough.md) / [ADR-0007](../../docs/adr/0007-apps-assembly-ai-injection.md)

## 核心能力

- **协议面**：`POST /v1/chat/completions`（SSE 字节流原样透传）、embeddings/completions/responses/messages、images/audio/rerank/moderations、`/v1/engines/:model/embeddings` 别名、Gemini 原生 `v1beta`、multipart 上传（MIME 白名单）、video/music 异步生成（提交 201 + 查询归属校验）、`GET /v1/models`（三协议形状）、`POST /oauth/token`（client_credentials 签发 App-JWT）
- **鉴权双形态**：虚拟 Key（`sk_` 前缀，SHA-256 → `accounts.resolveKeyByHash`，每调用直查）/ App-JWT（HS256 验签 + `accounts.resolveApp`）；爆破防护 key 维 + IP 维；`requestId` 恒服务端 randomUUID（响应回显 `x-request-id`）
- **限流**：滑动窗口 RPM/TPM/全局（`GLOBAL_RPM` 生产硬顶 5000）+ 渠道维并罚；Redis 不可用 fail-closed 503
- **请求日志**：一切 `/v1` 请求（鉴权前挂载）写 `request_logs`（observability 写入原语）
- **上游出站**：错误三层（502/504 网关语义 + 内容脱敏 + 细节只进日志）；SSRF 逃生门 `GATEWAY_AI_ALLOW_LOCAL_URL` 仅非生产恒关

## 目录结构（src/）

```
config.ts      # env zod schema（v1 键名保持；缺省值唯一真相）
assembly.ts    # 唯一装配根：db/redis/billing 准入/accounts/control-plane 读/inference/OTel/请求日志
http/          # routes（inference/modality/native-gemini/oauth/models）/ middleware（api-key/rate-limit/otel/request-log）/ openai-envelope / openai-error-face / sanitize
adapters/      # billing-port（signal 桥）/ catalog-port / settle-wake（pg_notify 纯门铃）
app.ts / index.ts / shutdown.ts
```

## 配置与端口

- 端口 `8080`（`GATEWAY_PORT`）；探针 `/healthz`（查 DB）`/readyz`（查 DB+Redis）`/livez`（纯 200）
- 必填：`DATABASE_URL`、`REDIS_URL`（**必配**——多副本共享限流/爆破/健康状态；启动 `assertRedisReachable` 连不上拒绝启动）、`JWT_SECRET`（生产 ≥32，App-JWT）、`CHANNEL_API_KEY_ENCRYPTION`（≥32，回落 `ENCRYPTION_KEY`）
- 关键缺省：`GATEWAY_BODY_LIMIT_BYTES=10MB`、`GATEWAY_UPLOAD_MAX_FILE_BYTES=16MB`、`GATEWAY_UPSTREAM_DEADLINE_MS=120000`、`BILLING_RESERVATION_MODE=full`、`TRUSTED_PROXY_HOPS=0`
- OTel：`OTEL_TRACES_MODE=off|otlp`（缺省 off）；推送鉴权 `TRACE_RECEIVER_TOKEN`（Bearer，与 trace-receiver 同键同值；缺此值对生产接收端 = span 全部 401）

## 装配与依赖

- facade：`@tokenlens/inference`（+`createRedisHealthStore`/`createPostgresGenerationTaskStore`）、`@tokenlens/ai`（`createAi` 注入，ADR-0007）、`@tokenlens/billing`（+`/composition` admission 准入）、`@tokenlens/accounts`（+`/composition` 资金来源/会话失效桥）、`@tokenlens/control-plane/composition`（只读目录 store）、`@tokenlens/observability`（initOtel + request-log store）、`@tokenlens/runtime`（限流/爆破件/cipher/logger）
- 结算唤醒：signal 转 settlement_pending 后 `pg_notify('settle-wake', requestId)` 纯门铃，丢失由 worker 兜底扫描覆盖

## 本地运行与测试

```bash
bun dev        # 仓库根（--env-file=../../.env --watch src/index.ts）
cd apps/gateway
bun run typecheck && bun run lint && bun run test
bun run test:real     # __test__/*.real.test.ts：真实 PG/Redis 集成
```
