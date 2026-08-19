# 网关推理管线（v2）

> 2026-08-20 重写：本文旧版描述的是已退役的 v1 管线（steps/ 服务化目录结构），
> 全部实现位置引用已失效。现改为 **v2 管线地图**——只讲结构与文件落点；
> 预扣/结算/防刷费用的完整语义以 [billing-flow-deep-dive.md](billing-flow-deep-dive.md)
> 为唯一真相。

## 中间件链（`apps/gateway/src/app.ts`）

```
corsPreflight（白名单精确匹配）→ securityHeaders → bodyParserLimit（413 提前拒绝）
→ requestId（服务端生成，客户端头仅日志关联——S1 修复）→ otel（off=no-op）
→ /v1/* requestLog（鉴权前挂载，401 也入日志）→ apiKeyMiddleware（按已注册端点挂载）
```

## 文件地图

| 环节 | 文件 |
|---|---|
| 鉴权（静态 Key + JWT 双分支；双层爆破锁两分支同口径） | `src/middleware/api-key.ts` |
| 限流并罚（凭证维 key:/app:/pg: + 用户维 + global 维；模型/渠道维） | `src/rate-limit/gate.ts` |
| 报价（候选链解析 + 价格快照 + 定价策略/计量两轴） | `src/quote/build-quote.ts` |
| 渠道路由（priority 分层 + weight 加权随机 + 换渠判定） | `src/routing/{resolve-channels,schedule,switchable}.ts` |
| 管线编排（流式/非流式双分支、换渠、收据、三路归还） | `src/pipeline/run-chat.ts` |
| 输出上界与转发钳制（D2） | `src/pipeline/output-cap.ts` |
| 收据装配（价格快照 + usage + units 计量 + appId/credentialType） | `src/pipeline/receipt.ts` |
| 上游端口与适配装配（ai 包绑定 + 密钥解密 + deadline） | `src/pipeline/{upstream-port,upstream-adapter,ai-storages}.ts` |
| 生成任务族提交（video/music） | `src/generation/submit.ts` |
| 端点注册（chat/embeddings/completions/responses/messages + engines 别名） | `src/routes/inference-endpoints.ts` |
| 模态 multipart 族（images/edits/audio…） | `src/routes/modality-multipart.ts` |
| 原生协议入口（/v1beta Gemini） | `src/routes/native-protocol.ts` |
| 生成任务路由 + App-JWT 签发 | `src/routes/generation.ts`、`src/routes/oauth-token.ts` |
| 错误翻译 / 上游脱敏 | `src/http/error-map.ts`、`src/http/sanitize.ts` |

## 单请求主线（金额语义详见 billing 文档 §2–§6）

```
鉴权（Key/JWT 双分支 + 爆破锁）
→ admitKey 并罚限流（Redis fail-closed；429/503）
→ buildQuote（404/403 → 归还 TPM 预占）
→ 模型维 TPM 预占（主 + fallback mappingId 一并占）
→ 免费模型日限（唯一防线 fail-closed）
→ billing.authorize 预扣（402 → 归还预占）
→ 候选模型 × 渠道双循环：
     渠道维限流（超限换渠）→ 进货敞口预留（CAS）→ signal(upstream.started) 起租约
     → 上游调用（deadline 预算内；Idempotency-Key=requestId）
       非流式 4xx：原码透传 + releaseTpm + request.failed 三路释放
       流式 first_chunk 前可换渠；上线后事件锚定终态；长流每 lease/3 续租
→ 成功：收据（可信 usage / 估算两分支）+ signal(succeeded)（退避重试，重试期间续租不停）
→ 全败：request.failed 三路同事务释放 + 502/503 脱敏信封
```

## 与旧版文档的关键差异（防误引）

- **无鉴权快照缓存**：每请求直查 DB（Key/App 属主状态即时生效）；Redis 只存
  爆破锁、限流窗口、熔断/死凭据状态——不存在 `auth:{keyHash}` 凭证上下文缓存
- **网关 JWT 无 jti 黑名单**：撤销靠 DB 属主校验（`findActiveAppById` / 用户状态 join）
- **TPM 预占失败路径全部归还**：quote 404、免费日限拒、authorize 402、4xx 透传
- **错误信封恒 `{error:{code,message}}`**；真实模型名/内部 URL 由 `http/sanitize.ts` 统一脱敏
- 熔断默认仅计数阈值（60s 窗 ≥5 次失败、冷却 5min），无比率条件
