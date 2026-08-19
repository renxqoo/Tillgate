# gateway 请求管线全流程剖析

> 注：本文剖析的是 v1 网关（apps/gateway）。生产 v2 管线与扣款口径见
> [`billing-flow-deep-dive.md`](billing-flow-deep-dive.md)。

> 对象：`apps/gateway`（对外推理面）。本文自顶向下拆解一个请求从连接建立到资金结算的
> 全部细节——每个守卫、每个分支、每条防线都标注实现位置。结构总览见
> [apps/gateway/README.md](../apps/gateway/README.md)；计费域内部见
> [packages/ledger/docs/](../packages/ledger/docs/)。

## 0. 全景图

```
客户端 ──▶ 中间件链 ──▶ 鉴权 ──▶ 六步管线 ──▶ 响应
                                    │
              ┌─────────────────────┼──────────────────────┐
              ▼                     ▼                      ▼
        Redis（限流/缓存/唤醒）   PostgreSQL（账单/收据/任务）  上游 LLM（ai 包适配）
                                    │
                                    ▼（异步）
                          worker 结算（ledger/settlement）
```

资金事实只在 PostgreSQL；Redis 全程是投影与通知；上游协议适配全部在
`@ai-gateway/ai` 包，gateway 对上游零协议知识。

## 1. 启动与装配（`index.ts` → `app.ts`）

`createApp(deps)` 是纯组合根（171 行，无副作用，测试可换件），构建并注入：

| 服务 | 职责 | 关键参数 |
|---|---|---|
| `authService` | 双凭证鉴权 + 爆破防护 | JWT_SECRET、失败窗口 env |
| `oauthService` | `/oauth/token` 客户端凭证 | |
| `wallet` | 资金钱包内核 | `refTypes:['billing']`（fail-closed 白名单） |
| `billing` | 计费域（ledger） | admission 闸：`BILLING_PENDING_MAX` / `MAX_AGE_SECONDS` / `CACHE_MS` |
| `router` | 模型路由 + 渠道缓存 | ENCRYPTION_KEY（渠道凭据解密） |
| `coefficients` | 费率卡系数快照缓存 | |
| `runInference` | 六步管线闭包 | |

停机顺序：`lifecycle.beginDrain()` 拒新请求 → `completions.drain()` 等在途
durable 收据落库 → 关闭连接。

## 2. 中间件链（`app.ts`，顺序即语义）

```
CORS 预检 → 安全头 → body 上限 → requestId → OTel → requestLog → 鉴权 → 路由
```

三个刻意的顺序决策：

1. **requestId 先于 OTel**：span 属性 `request.id` 是计费关联锚点，依赖 requestId 先就位；
2. **requestLog 前置到鉴权之前**：401/429 也要写 `request_logs`；按 `/v1/*` 前缀挂载而非
   端点表驱动——语义是「记录一切 /v1 请求」（含未注册路径的 404）；
3. **鉴权按端点注册表循环挂载**：`inferenceEndpoints` 表 + 模态端点表 + 原生协议
   （`/v1beta/*`、`/v1/engines/*`）+ 任务查询（`/v1/videos|musics`）+ `/v1/models`，
   注册表是单一真相，加端点自动获得鉴权与挂载。

## 3. 鉴权（`middleware/auth.ts` + `services/auth/auth-service.ts`）

双凭证分流：

- `ag_` 前缀 → **静态 Key**：SHA-256 摘要查 `api_keys`（不存明文），Redis 快照缓存
  消除热路径查库，失败计数防爆破（`auth-failure-guard`）；
- 非 `ag_` → **JWT**：jose 验签 + jti 黑名单 + App 状态缓存。

产出 `AuthContext`（13 字段）：身份三件套（userId / apiKeyId / appId）、
`credentialType`、`rateCardId`（费率卡绑定——系数**不在**快照，resolve 步按选中
映射实时解析，防快照与结算口径漂移）、三级限流参数（key/user/app 的 RPM+TPM）、
`allowedModels`（JWT scope 白名单）。鉴权失败统一抛 `GatewayError`，拒绝码全部
预登记在 `packages/http` 注册表。

## 4. 六步管线（`services/pipeline/run.ts`）

编排器即顺序清单，一个 try/catch/finally 收口全部错误语义（见 §7）。

### ① admitRequest（`steps/admission.ts`）——准入三查 + 请求预算

| 检查 | 拒绝 | 说明 |
|---|---|---|
| drain 置位 | 503 `server_draining` | 在途请求不受影响（见 §9.3） |
| 客户端已取消 | 408 `request_cancelled` | |
| JWT scope 越权（S3） | 403 `model_not_allowed` | **在任何路由/计费之前**——受限凭证调贵模型在结构上不可达 |

`RequestBudget` 的 AbortSignal 是**三源合成**：客户端断连 ∪ 绝对 deadline ∪
drain 中止。drain 中止带 `ServerDrainAbort` 标记——计费侧据此区分**服务端责任**
（全额释放）与**用户取消**（估算结算）。`remainingMs()` 是每次渠道尝试的租约来源，
**fallback 不重置 deadline**。

### ② resolveRequest（`steps/resolve.ts`）——解析与候选定价

1. **模型路由**：`externalName → model_mappings`（Redis 缓存），不存在 → 404；
2. **费率卡闸**：绑定的卡 `status≠0` → 429 `rate_card_disabled`（Key/JWT 同语义）；
3. **多模态分析**：`analyzeMultimodalRequest(body)` 数媒体部件，策略缺失 → 422；
4. **输入 token 估算**：`estimateInputTokens(body)`（ai 包单一真相）——遍历
   messages content、tool_calls、**tools 定义 JSON 全量**（企业 Agent 主要消耗源）、
   embeddings input（token-id 数组按每 id 一个 token 计）、多模态部件，乘校准权重
   加模板偏移。**口径拍板（2026-08，resolve.ts 头注释）**：预扣用校准估算而非
   字符硬上界——估算偏小 → 结算实扣可超预扣，敞口由 credit_limit 与 settle 按
   calculated 实扣兜底。平台**已接受该敞口**换取更少的资金占用；
5. **候选定价**（主模型 + chat 的 fallback 链，每候选独立计算）：
   - 系数按候选自己的映射解析（model > group > global，`ledger/coefficient.ts`
     单一真相）；系数 ≤ 0 → 422；
   - **双口径并行**：`estimate`（用户价 × 系数 → 预扣）与 `upstreamEstimate`
     （官方价、系数=1 → 渠道敞口），与结算侧 `calculatedAmount`/`upstreamCost` 同口径；
   - `billingPolicyFingerprint`：多模态策略 SHA-256——结算时收据必须匹配此指纹
     （防授权后改策略算错账）；
   - `unitUpperBound`：video+second 按时长钳 4-15s（缺省 6）；其余按 n 倍数；
   - `inputTokenUpperBound = max(文本估算, 多模态报价)`——**数的是本次请求的
     实际内容**，与模型上下文上限无关；
6. **outputCap**：`max_completion_tokens ?? max_tokens`（缺省 4096）× n，再被
   `GATEWAY_OUTPUT_EXPOSURE_CAP` 截断——输出敞口不按用户上限全额预估，cap 外
   由授信缓冲 + 结算兜底。

### ③ checkRateLimits（`steps/rate-limit.ts`）——四层限流

1. **RPM 原子判定**：global / user / key / app / model 五维一次 Lua 脚本判定，
   后维拒绝不污染前维窗口 → 429 带 retryAfter；
2. **TPM 原子预占**：user×model / model / key / app 四维，要么一起成功要么一项
   不写（Lua 原子）→ 返回 **TpmReservation 所有权句柄**（`handedOff` / `retained` /
   `release` 三态、release 幂等只执行一次；契约由 characterization 测试钉住）；
3. **免费模型日限**：Redis INCR+EXPIRE 原子计数，日窗口用账本 `billingDayKey`
   （本地计费日，与每日花费上限共用「一天」的定义）。**fail-closed（F7）**：
   0 元授权不走余额闸，此计数是唯一防线，Redis 故障 → 503；付费链路其余限流
   fail-open（资金有 DB 硬闸兜底）。拒绝路径显式 `tpm.release()`——被拒请求
   不占 600s 窗口；
4. **两个后置维**：fallback 模型维（G3——主渠道全挂切 fallback 时若无计量，
   fallback 模型维形同虚设，多用户合流可击穿上游配额；在 dispatch 派发前判定）、
   渠道维（attempt 前判定，见 §4.5）。

### ④ authorizeRequest（`steps/authorize.ts`）——预扣

quote 组装的关键规则：

- **`explicitlyFree` 要求整条候选链全部 `isFree`**——任一 fallback 收费则按最贵
  候选正常预扣（防免费主模型 failover 到收费模型后透支）；
- 候选携带价格快照 + 上界 + 系数 + 政策指纹（结算校验的锚）；
- `traceParent` 从根 span 提取落列——worker 结算时挂回同一 trace；
- `reservationLimit = BILLING_RESERVATION_MAX`、TTL = `BILLING_AUTHORIZATION_TTL_SECONDS`。

调 `billing.authorize`（内部：admission 积压闸 → `calculateRequired` 四道保守 →
advisory 锁 → 每日限额/来源解析/订阅闸 → INSERT 幂等 → PAYG 冻结或额度预留，
详见 ledger 文档）。拒绝经 `translateAuthorizeError` **表驱动翻译**（wallet 错误族
优先：余额不足 → 402、账户冻结 → 403），未分类异常原样上抛（500 路径）。

### ⑤ dispatchCandidates（`steps/dispatch.ts`）——候选×渠道双层循环

```
for 候选（主模型 → fallback 模型）:
    G3: fallback 限流维判定（超限 → continue 换候选）
    for 渠道（priority 层严格在前；同层 weight 无放回加权随机）:
        ├ budget.aborted → break
        ├ 渠道敞口硬闸 reserveChannel(upstreamEstimate)
        │    不足/异常 → 记 lastError，continue 换渠道
        ├ attemptChannel（deadline = budget.remainingMs()，不重置）
        └ outcome 三分支：
             success → return response
             respond → 4xx 直返；aborted → 仅 input 估算结算后
                       以 UpstreamRespondError 穿出双层循环
             switch  → 记 lastError，下一渠道
全耗尽 → 统一 503 no_available_channel
```

细节：

- **渠道敞口硬闸**在每次尝试前原子预留在途上游成本（官方价口径），余额不足
  即拦截——保护的是**公司采购预算**，与用户余额无关；
- **耗尽错误的信息纪律**：真实失败原因（circuit_open / dead_credential /
  channel_budget_exhausted）只进日志与 trace，**不出站**——防渠道拓扑泄漏；
- 渠道排序单一真相：`weightedOrderByPriority`（priority 高严格在前 + weight
  加权随机做流量份额，weight≤0 按 1 处理）。

### ⑥ attempt/ 传输模式族（`steps/attempt/`）

**index（分派器 `attemptChannel`）**：渠道级限流 → 任务族分流（`isTaskKind` →
task-submit，租约 = 任务 TTL+30s）→ 同步族发 `upstream.started`（**租约 =
max(BILLING_LEASE, deadline+10s)**——租约永不在请求存续期内过期，防 recover
按崩溃口径误释放导致漏收）→ 按 stream 分派 stream / non-stream。

**stream**：

- `stream.relay` 生命周期 span——根/upstream span 在 handler 返回（首包）即结束，
  流式请求的业务生命周期延伸到流终止，取消/截断时刻只有本 span 覆盖；
- **TTFB 只锚 first_chunk**（错锚会把 TTFB 记成终态时刻——c2dee8ff 教训）；
- 成功终态三分岔（2026-08-17 政策）：server_draining → 释放（平台吸收）；
  用户取消 / 正常完成缺 usage → 估算结算（`billing.estimate` span 留痕）；
  其余 terminated（超时/5xx/截断/断连/静默）→ 释放不扣；
- **首字节前失败**返回真实状态码 + JSON 错误体（不是 200+SSE 错误帧——标准
  SDK 按 HTTP 状态判成败）；aborted 映射 408；
- 出站三重白标：模型名改写（`rewriteSseModel`，对外只见对外名）→ 错误脱敏
  （真实模型名/供应商剔除）→ `withBillingLifecycle` 包装（**durable receipt
  落库前不许 EOF**；收据失败照常 EOF、预扣留给租约恢复链，注释明确防 SDK 重试
  导致重复生成）。

**non-stream**：

- `upstreamForm` 原样透传（multipart 字节不重组）；
- 二进制响应（audio_speech）：模态计量后字节直传；
- 模态端点：units 从响应体/请求体提取（images 张数等），不走 token 估算；
- 完成缺 usage → `estimateUsage` 估算结算（estimatedFor=usage_missing_nonstream）；
- **上游成功但收据落库失败 → 503 billing_receipt_unavailable + 按 success 穿出**：
  预留保留（租约恢复链释放），禁止 finally 误退款——上游已真实计费。

**task-submit**（video/music 两阶段任务）：

- 顺序不变量：任务行先落（崩溃时 authorized/in_flight 由租约恢复链释放）→
  `upstream.started`（租约=TTL）后置 → 客户端拿到 201 即任务已持久化；
- `task_execute`（music 类同步阻塞上游）：网关不调上游，worker 代执行；
- 任务行落库失败（503）按 **respond** 穿出不换渠道重提——防同一请求双任务；
- units 快照单一真相在 ai 包 descriptors（预扣上界与结算快照同一实现）。

## 5. 收尾（run.ts finally + `steps/finalize.ts` 三产线）

| 产线 | 触发 | 资金后果 |
|---|---|---|
| `recordSuccess` | 可信 usage | signal request.succeeded → settlement_pending，实扣在 worker |
| `recordReleasedFailure` | 上游异常 / drain / 崩溃 | signal request.failed → released 三路释放，**不扣**（宁可漏收不误收） |
| `recordEstimatedOutcome` | 用户取消 / 完成缺 usage | 估算 usage 后走 recordSuccess → **估算扣**（estimatedFor 留痕） |

未交付失败（进入候选循环之后）：finally 发 `request.failed`，失败收尾 span 记录
**释放金额（未扣费证据）**；授权阶段的拒绝不发终态信号（authorized 行由租约
恢复链释放）。TPM 处置：`tpm.release()`（2026-08-17 政策：unknown 不再保留）。

## 6. 结算交接（异步，与响应解耦）

1. 收据先落 PostgreSQL（**正确性边界**——DB 收据提交即完成）；
2. best-effort Redis 唤醒（BullMQ `jobId=requestId` 幂等，payload 只有 requestId，
   **队列永不携带用户/价格/usage**）；
3. 唤醒失败仅警告 + 指标，worker 的 DB 扫描（settlement_pending 到期自扫）兜底；
4. `CompletionRegistry.track` 保证客户端断连后收据 promise 仍被执行（drain 时等待）。

## 7. 错误语义三分（类型上不相交）

1. **可预期拒绝** = 步骤 throw `GatewayError` → run.ts 唯一 catch 收口渲染
   （400/402/403/404/408/429/503，全部带注册表码）；
2. **上游响应透传** = `UpstreamRespondError`（内部信号，携带已构建响应）→ 原样
   返回；上游 4xx 白名单透传（`upstreamPassthroughReject`）+ 脱敏后；
3. **真服务端故障** = 其他异常原样上抛 → `app.onError` 兜底 500 + 日志。

翻译单一真相 `lib/errors.ts`；渲染单一真相 `lib/http.ts`（OpenAI 错误信封 +
retry-after 头）。

## 8. 支撑系统

- **缓存四件**：模型映射、渠道链、费率卡系数、Key 鉴权快照——全 Redis，失效
  由管理端/worker 主动 bump；
- **渠道策略**（`routing/channel-policy.ts`）：`isChannelSwitchable` 判定可换渠
  错误族；`isDeadCredentialError` → 写回 DB `status=4`（永久退出路由 + 管理端可见）；
- **限流服务**（`billing/rate-limit-service.ts`）：全部经 RedisScriptRunner
  （evalsha + NOSCRIPT 自愈，BUG-C 教训）；
- **指标**：`recordRequest` / `recordChannelFailure`（渠道健康画像）。

## 9. 不变量总表（防线分层：编译 > DB > 事务 > 测试 > 运行时纪律）

| 不变量 | 层 | 位置 |
|---|---|---|
| 越权模型不可达 | 管线入口 | admission scope 三查（④之前） |
| 免费链路防滥用 | Redis fail-closed | checkFreeDailyLimit |
| TPM 预占不泄漏 | 所有权句柄 | TpmReservation 三态契约 |
| 余额不透支 | DB（wallet 守卫锁内） | billing.authorize |
| 渠道采购预算 | DB（守卫单语句） | reserveChannel |
| 租约不误释放（防漏收） | 时间结构 | upstreamLeaseMs ≥ deadline+10s |
| 防双扣 | DB（claim CAS + 同事务） | ledger settle |
| 收据先于 EOF | 流生命周期 | withBillingLifecycle |
| 渠道拓扑不泄漏 | 出站纪律 | exhaustedError / 脱敏 / 模型名改写 |
| 结算最终必达 | DB 扫描兜底 | worker runOnce + recover 三路径 |
| 断连不丢收据 | 进程内 registry | CompletionRegistry + drain |

## 10. 相关文档

- [apps/gateway/README.md](../apps/gateway/README.md)——结构总览与扩展点
- [packages/ledger/docs/architecture.md](../packages/ledger/docs/architecture.md)——账本六域与依赖铁律
- [packages/ledger/docs/billing.md](../packages/ledger/docs/billing.md)——billing 8 态状态机
- [packages/ledger/docs/settlement.md](../packages/ledger/docs/settlement.md)——worker 结算编排
- [docs/ai-package.md](ai-package.md)——上游协议适配层
