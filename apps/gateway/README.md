# gateway —— 对外推理面（OpenAI 兼容 + 原生协议 + 模态端点）

> 一切推理请求走同一条六步管线（`services/pipeline/run.ts` 是顺序清单）。
> gateway **不碰钱**：资金动作全部经 `@ai-gateway/ledger/billing` 域与
> `@ai-gateway/wallet` 契约完成；上游协议适配在 `@ai-gateway/ai` 包。
> 逐步全细节剖析（每条守卫/分支/防线）见 [docs/gateway-pipeline.md](../../docs/gateway-pipeline.md)。

## 目录地图

| 目录 | 职责 |
|---|---|
| `src/routes/` | 薄适配层：端点注册表（单一真相）→ 挂载 + zod 校验，无业务逻辑 |
| `src/services/pipeline/` | 六步管线编排（`run.ts`）+ 契约层（`types.ts`）+ 步骤实现（`steps/`） |
| `src/services/auth/` | Key/JWT 双凭证鉴权、OAuth 客户端凭证、鉴权失败防爆破、系数快照缓存 |
| `src/services/billing/` | 限流服务（Redis Lua 原子）、计费唤醒派发、多模态计价政策 |
| `src/services/routing/` | 模型路由（映射 → 渠道链）、渠道健康/死凭据策略、敞口预留 |
| `src/services/runtime/` | 请求生命周期（drain/abort 预算）、流收尾登记（durable receipt 追踪） |
| `src/middleware/` | 鉴权、requestId、OTel、安全头、日志、防爆破（顺序见 `app.ts`） |
| `src/lib/` | 错误注册表与翻译（单一真相）、HTTP 信封、SSE 改写、脱敏、指标 |

## 六步管线（`run.ts` 顺序清单）

```
客户端请求
   ▼
① admitRequest      准入：drain 拒绝、客户端取消、模型越权(scope)
   ▼
② resolveRequest    解析：模型路由 + 费率卡系数 + 多模态分析 + 输入 token
   │                估算 + 候选定价（主模型 + fallback，Decimal 全精度）
   ▼
③ checkRateLimits   限流：RPM 原子判定 → TPM 原子预占（TpmReservation 句柄）
   │                → 免费模型日限
   ▼
④ authorizeRequest  预扣：billing.authorize（四道闸门，DB 权威；拒绝经
   │                translateAuthorizeError 表驱动翻译 → 402/429/503）
   ▼
⑤ dispatchCandidates 执行：候选×渠道循环 → attemptChannel（attempt/ 传输模式族：
   │                stream / non-stream / task-submit）
   │                换渠顺序：守卫预留新渠道敞口 → 释放旧 → CAS 认领
   ▼
⑥ 收尾（finally）   失败：signal request.failed（三路释放，未扣费证据）
                    成功：收据产线（finalize.ts 三条：succeeded / 释放不扣 /
                    估算结算）→ best-effort Redis 唤醒 worker 结算
```

### 执行器传输模式族（`steps/attempt/`）

| 文件 | 模式 |
|---|---|
| `index.ts` | `attemptChannel`：渠道限流 → 租约 → 按请求形态分派 |
| `stream.ts` | 流式：stream.relay 生命周期、TTFB、责任域三分岔（取消/缺 usage → 估算结算；上游异常 → 释放不扣） |
| `non-stream.ts` | 非流式：模态计量、估算结算、二进制透传 |
| `task-submit.ts` | 任务族（video/music）：两阶段任务行 + TTL 租约，worker 轮询驱动终态 |

## 错误语义三分（类型上不相交）

1. **可预期拒绝** = 步骤 throw `GatewayError` → `run.ts` 唯一 catch 收口渲染（4xx/429/402/503）
2. **上游响应透传** = `UpstreamRespondError`（内部信号，携带已构建响应）→ 原样返回
3. **真服务端故障** = 其他异常原样上抛 → `app.onError` 兜底 500 + 日志

翻译单一真相在 `lib/errors.ts`（含 wallet 错误族 → 402/403/409）；上游 4xx 白名单
透传 + 脱敏；渲染单一真相在 `lib/http.ts`。

## 资金边界（硬规则）

- gateway 对钱只有三个动词面：`billing.authorize / signal / reserveChannel`——余额、
  在途、流水的读写全部在 wallet/ledger，本 app 无任何余额列引用。
- 装配处（`app.ts`）`createWallet(refTypes: ['billing'])`——fail-closed 白名单。
- TPM 预占是所有权句柄（`TpmReservation`：handedOff/retained/release），
  契约由 characterization 测试钉住；Redis 只是投影，不参与资金事务。
- 租约结构防漏收：`upstreamLeaseMs = max(lease, deadline+10s)`——租约永不在
  请求存续期内过期，recover 不会误按崩溃口径释放。

## 扩展点（表驱动，改一处生效）

| 场景 | 改哪里 |
|---|---|
| 加推理端点 | `routes/inference-endpoints.ts` 注册表加一行（path+kind+schema+codec），鉴权+挂载自动生效 |
| 加模态端点 | `routes/modality-endpoints.ts` + `modality-usage.ts` 计量 |
| 加上游协议 | `@ai-gateway/ai` 适配器族，gateway 零改动 |
| 改管线顺序 | `pipeline/run.ts` 单文件 |
| 加错误码 | `lib/errors.ts` 注册表（`packages/http` error-codes 登记） |
| 加生成类型 | `@ai-gateway/ai` descriptors（units 快照单一真相） |

## 测试

域测试与实现同目录（`__tests__/`），59 个测试文件，全部跑真实 PostgreSQL/Redis；
含 bug 回归钉子（`*.bug.test.ts`）与契约特征测试（TPM 句柄、清理纪律）。
测试数据纪律：每测试独立用户 + `subplan-` 前缀套餐；`testing/helpers.ts` 的
`cleanupTestData` 同步清理渠道敞口投影（与 ledger R4 同一六态口径，2026-08-16 实发教训）。
四门在根目录：`pnpm typecheck && pnpm lint && pnpm test && pnpm build`。
