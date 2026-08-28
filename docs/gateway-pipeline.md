# 网关推理管线

> 本文档自 v1（ai-getway）同名文档适配至 v2 结构；行为细节以代码为准。
>
> 管线结构地图——只讲结构与文件落点；预扣/结算/防刷费用的完整语义以
> `packages/billing`、`packages/inference` 代码为准
> （[billing-flow-deep-dive.md](billing-flow-deep-dive.md) 为导读）。
> 结构原则见 [project-structure-refactoring.md](project-structure-refactoring.md)。

## 中间件链（`apps/gateway/src/app.ts`）

按实际挂载顺序（`app.use` 逐条 + 全局 onError/notFound 收口）：

```
onError(errorHandler(gatewayErrorCatalog + FACE_OVERRIDES))   ← 错误信封收口（最先注册，最后兜底）
notFound → 404 not_found（/v1/ 前缀文案区分；未注册路径是 404 而非 401——老网关语义）
↓
corsPreflight（跨域源白名单精确匹配）→ securityHeaders → bodyParserLimit（413 提前拒绝；
  缺省 10MB，multipart 上传限另传）→ requestId（服务端生成，客户端头仅日志关联）
→ otel（off=no-op；挂载在 requestId 之后——span 属性 request.id 依赖它）
→ /healthz /livez /readyz（探针路由；readyz 探 db + Redis）
→ /v1/* requestLog（鉴权前挂载，401/429 也入日志——「记录一切 /v1 请求」）
→ apiKeyMiddleware（按已注册端点路径逐一挂载：/v1/models、各推理端点、
  /v1/engines/:model/embeddings 别名、/v1beta/models/:modelAction、multipart 族、
  生成任务族；/oauth/token 不挂鉴权——本身是取令牌端点，ipGuard 装配注入）
↓
路由处理器（schema 校验 → 限流准入 → inference 调用 → 信封出站）
```

## 文件地图

| 环节 | 文件（apps/gateway/src/） |
|---|---|
| 鉴权（静态 Key + app_jwt 双分支；Key 分支双层爆破锁、JWT 分支只计 IP 维） | `http/middleware/api-key.ts` |
| 限流并罚（key:/user:/global 维 RPM + key:/user: 维 TPM 预占；渠道维 RPM 钩子） | `http/middleware/rate-limit.ts` |
| 请求日志（/v1 全量前置） | `http/middleware/request-log.ts` |
| OTel 根 span | `http/middleware/otel.ts` |
| 端点契约注册（chat/embeddings/completions/responses/messages/rerank/moderations/images/speech） | `http/contracts/inference-endpoints.ts` |
| 端点路由（schema→限流→inference→信封；失败归还 TPM） | `http/routes/inference-endpoints.ts` |
| 模态 multipart 族（images/edits、audio/transcriptions、translations） | `http/routes/modality-multipart.ts` |
| 原生协议入口（/v1beta Gemini：generateContent/streamGenerateContent） | `http/routes/native-gemini.ts` |
| 生成任务路由（video/music 提交与查询） | `http/routes/generation.ts` |
| App-JWT 签发（/oauth/token，client_credentials；iss/aud + ipGuard） | `http/routes/oauth-token.ts` |
| /v1/models 列表（scope 过滤） | `http/routes/models.ts` |
| 成功信封三态出站（SSE 直传 / rawBody 二进制 / JSON；codec 回编码） | `http/openai-envelope.ts` |
| 错误 face 映射（网关目录码 → OpenAI 兼容信封） | `http/openai-error-face.ts` |
| 上游错误细节脱敏（内部寻址/真实模型名/截断） | inference `dispatchFailure` 单点（机制件 `packages/ai/src/errors/sanitize.ts`） |
| inference↔billing 桥（quote 盖章/词表映射/reserveChannel） | `adapters/billing-port.ts` |
| 目录读模型（模型映射/渠道解析 PG 适配） | `adapters/catalog-port.ts` |
| 结算唤醒生产端（pg_notify 门铃） | `adapters/settle-wake.ts` |
| 装配根 / HTTP 链 / 停机宽限 | `assembly.ts` / `app.ts` / `shutdown.ts` |

候选循环、预检（报价）、收据与信号重试、渠道健康——这些「管线业务」不住在
gateway，在 `packages/inference`（`src/application/{quote,failover,chat,stream,signal-retry}.ts`）；
上游执行库在 `packages/ai`（`src/pipeline/`、`src/transport/`、`src/usage/`）。

## 单请求主线（金额语义详见 billing 文档 §2–§6）

```
鉴权（Key/app_jwt 双分支 + 爆破锁）
→ schema 校验（400 invalid_body）
→ admitRequest 并罚限流（RPM key:/user:/global + TPM key:/user: 预占；
   Redis fail-closed；429/503）
→ inference.chat/stream 编排：
     prepareChatRequest（模型白名单 403 / 目录解析候选链 404 / outputCap /
       转发钳制 / 双口径输入估算——字节上界入预扣，特征校准入实扣兜底）
   → billing.authorize 预扣（402 → 路由 catch 归还 TPM 预占）
   → 候选模型 × 渠道双循环：
        渠道维 RPM（admitChannel 钩子，超限换渠）
        → 健康放行（熔断 open / 死凭据 invalid → 换渠）
        → 进货敞口预留 reserveChannel（守卫→释放旧→CAS）
        → signal(upstream_started) 起租约
        → 上游调用（deadline 预算内；Idempotency-Key=requestId）
          非流式 4xx：request.failed 三路释放 + 原码透传（TPM 不即时归还，TTL 兜底）
          流式 first_chunk 前可换渠；上线后事件锚定终态；长流每 TTL/3 续租（≤100 次）
→ 成功：收据（可信 usage / ai 估算采纳 / 特征兜底三层）+ signal(succeeded)
  （退避重试，重试期间续租不停）+ pg_notify 唤醒
→ 全败：request.failed 三路同事务释放 + 503 no_available_channel / 502 upstream_failed 脱敏信封
```

## 与 v1 文档的关键差异（防误引，v2 代码口径）

- **无鉴权快照缓存**：每请求直查 DB（Key/App 属主状态即时生效）；Redis 只存
  爆破锁、限流窗口、渠道健康状态——不存在凭证上下文缓存
- **网关 JWT 无 jti 黑名单**：撤销靠 DB 属主校验（resolveApp / 读模型状态守卫）
- **凭证两形态**：静态 Key（keyPrefix 分派）+ app_jwt（iss/aud + 算法白名单；
  app_id = apps.app_id 字符串，R-E2）；playground 形态 v1 已退役，v2 结构性不认
- **TPM 归还口径变化**：v1 的模型维 TPM 预占（reserveModelDims）、渠道维 TPM、
  免费模型日限均不在 v2（R-E3 在案）；失败路径（预检/授权抛错）经路由 catch
  归还 admit.release()，4xx 透传与成功路径靠 TTL 600s 兜底（结算侧 backfillTpm
  动词保留在 runtime 限流器但未接线）
- **死凭据不再 DB markDead**：经 AiEvent 由 inference health 状态机记账
  （连续失败 ≥3（1h 窗）→ invalid 停止放行；成功自愈 valid；Redis/内存存储）
- **错误信封恒 `{error:{code,message}}`**；真实模型名/内部 URL 由
  inference `dispatchFailure`（出站单点）+ `packages/ai/src/errors/sanitize.ts`（机制件）统一脱敏
- 熔断默认仅计数阈值（60s 窗 ≥5 次、冷却 5min、half-open 单探测），无比率条件；
  与结算侧「渠道进货预算耗尽熔断」（DB 闸）是两套机制
- **转发钳制会注入**：客户端未声明输出上限时注入 max_completion_tokens
  = floor(outputCap/n)（v1 不注入口径已改）

## 相邻文档

- 资金语义全流程：[billing-flow-deep-dive.md](billing-flow-deep-dive.md)
- 全链路判定细节（分图 -1～8 + 估算归属附录）：[gateway-full-flow.md](gateway-full-flow.md)
- 工程规范：[../AGENTS.md](../AGENTS.md)
