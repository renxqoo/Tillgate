# 扣款全流程深度解析（gateway / inference / billing / worker）

> 本文档自 v1（ai-getway）同名文档适配至 v2 结构；行为细节以代码为准。
>
> 本文是生产链路扣款流程的导读（资金安全审查后口径）。**代码是唯一标准**，本文与实现冲突时以代码为准。
>
> 覆盖范围：`apps/gateway`（热路径）、`packages/inference`（候选循环/路由/收据/健康）、
> `packages/ai`（上游传输）、`packages/billing`（v2 深模块——v1 的 wallet 双分录内核、
> money、service 的计费/settlement/generation 用例、domain 计费规则、repository 计费
> SQL 全部收敛于此，内部分 `domain/application/ports/adapters`）、`apps/worker`（结算）。
> 所有公式与流程均以源码为准。结构背景见
> [project-structure-refactoring.md](project-structure-refactoring.md) 与
> [../AGENT.md](../AGENT.md)。

---

## 目录

1. [总体架构：两应用、一个计费深模块](#1-总体架构)
2. [分图①：鉴权（凭证两形态）](#2-分图鉴权)
3. [分图②：限流与准入](#3-分图限流与准入)
4. [分图③：预扣（扣款公式核心）](#4-分图预扣)
5. [分图④：调上游（计量数据的生产侧）](#5-分图调上游)
6. [分图⑤：落收据（可信 / 估算两分支）](#6-分图落收据)
7. [分图⑥：结算实扣（worker）](#7-分图结算实扣)
8. [失败、恢复与死信](#8-失败恢复与死信)
9. [预扣 vs 实扣对照表](#9-预扣-vs-实扣对照表)
10. [刷费用五向量与防线](#10-刷费用五向量与防线)
11. [附录：billing_requests 状态机（8 态）](#11-附录状态机)
12. [附录：文件索引](#12-附录文件索引)

---

## 1. 总体架构

```
客户端 ──HTTP/SSE──▶ apps/gateway（热路径：鉴权→限流→预扣→调上游→落收据）
                          │  ▲
                          │  └─ packages/inference（候选循环/路由调度/收据/渠道健康）
                          │       └─ packages/ai（适配器/重试/流中继/SSE 扫描器/usage 归一）
                          ▼
                    PostgreSQL（billing_requests = 唯一事实源）
                          │    ▲
                          │    └─ packages/billing（双分录：wallet_accounts/authorizations/legs
                          │        + 资金瀑布 + 结算用例族，domain/application/ports/adapters）
                          ▼
apps/worker（结算：PG LISTEN 唤醒 + 认领→实扣→对账→恢复）─▶ PostgreSQL
        ▲
        └─ pg_notify('settle-wake')（纯门铃：只带 requestId，可丢——DB 轮询兜底；
           v2 已移除 BullMQ/Redis——worker 配置无 REDIS_URL）
```

核心设计要点：

| 维度 | 现行设计（v2 代码口径） |
|---|---|
| 账本 | billing 深模块内双分录内核：`wallet_authorizations`（hold）+ `wallet_legs`（复式流水），`in_flight` 为冻结口径 |
| 结算余额口径 | `balance + credit_limit − in_flight = available`（`domain/wallet/exposure.ts` 的 `availableToSpend` / `assertCanDebit` 唯一守卫） |
| 超预扣 | `#over` 同事务补充授权（`collectOverage` **允许负余额**）并结清 = 精确全额补收（见 §7d） |
| 异常态 | 无 uncertain 挂起：完成缺 usage / 用户取消 → 估算结算；上游异常 / 崩溃 → 即时释放 |
| 预扣不足 | `full` 模式下资金瀑布加总不足即 fail-closed（402 整单拒绝，上游零调用） |
| 唤醒 | 生产端 `pg_notify`（`apps/gateway/src/adapters/settle-wake.ts`），消费端 PG LISTEN（`apps/worker/src/wakeup/postgres-notify.ts`）；丢失由 30s 兜底扫描覆盖 |

Redis 在 v2 只剩 gateway 侧三用途：限流窗口、鉴权爆破锁、渠道健康状态
（`inference:health:` 前缀）；worker 侧零 Redis。

---

## 2. 分图①：鉴权

> 代码：`apps/gateway/src/http/middleware/api-key.ts`；读模型在
> `packages/accounts`（`resolveKeyByHash` / `resolveApp`，每调用直查 DB 无缓存）。

```
Authorization: Bearer <token>
   │
   ├─ token 以 keyPrefix（ag_）开头 ──▶ 【静态 API Key】
   │     1. sha256 → keyHash
   │     2. 双层爆破锁：per-keyHash（同 Key 撞库）+ per-IP（随机 Key 扫射）——均 fail-closed
   │     3. 读模型单查守卫：api_keys 状态/有效期 + 属主 user 状态
   │        （封禁用户的存量 Key 立即失效）
   │     4. 限流维度 = key:{apiKeyId}（凭证限额）+ user:{userId}（用户帽，并罚）
   │
   └─ 否则 ──▶ 【JWT】（jose HS256，算法白名单 + iss/aud 强制；
         仅认 typ=app_jwt；失败只计 per-IP 维——Key 可枚举、JWT 不可，A8 裁决；
         Redis 故障 fail-closed 503）
         ├─ app_id 必须命中 apps.app_id 字符串标识（R-E2：v1 为数字主键）
         │    → resolveApp：app 与属主 user 双活，sub 必须等于属主 userId
         │    限流维度 = user:{userId}（app scope 的 rpm/tpm 进 AuthContext 凭证限额位，
         │    限流闸的凭证维以 apiKeyId 为键——静态 Key 形态才有 key: 维）
         └─ 其他 typ（含 v1 已退役的 playground）一律 401（信任根分离）
        （用户维对静态 Key 形态无条件在列；模型白名单 allowedModels = App scope.models，
          非空数组才生效，否则 null 不限）
```

要点：限流维度串只由服务端从 DB/令牌载荷推导，客户端不可选；来源 IP 取真实
socket 地址 + 信任代理跳数（`trustedClientIp`，TRUSTED_PROXY_HOPS 模型），不可伪造。

---

## 3. 分图②：限流与准入

> 代码：`apps/gateway/src/http/middleware/rate-limit.ts`（策略）+
> `packages/runtime/src/redis/rate-limiter.ts`（机制：RPM=ZSET 滑动窗口，
> TPM=actual+reserved 双计数预占，Lua 原子）。

```
1. admitRequest（路由入口调用；RPM 多维原子判定 + TPM 预占）
   维 = key:{apiKeyId}（静态 Key）+ user:{userId}（显式配置才生效，无兜底默认）
       + global（RPM）——任一超限即 429；Redis 故障 → 503 fail-closed（付费面）
   TPM 预占口径 = conservativeInputTokenUpperBound(body)（JSON 字节保守上界）+ outputCap
2. schema 校验失败 → 400 invalid_body（限流前）
3. 预检/授权/上游执行抛错（404 模型不存在 / 403 白名单 / 402 限额…）
   → 路由 catch → admit.release() 归还 TPM 预占（幂等；hash 删即 no-op）
4. （v1 的「模型维 TPM 预占 reserveModelDims」「渠道维 TPM 预占」「免费模型日限」
   均不在 v2——前者两者为 R-E3 在案缺口，渠道维 RPM 经 assembly 的 admitChannel
   钩子保留；免费滥用上界收敛到渠道预算与渠道 RPM）
5. 上游 4xx 透传与成功路径不即时归还 TPM——TTL 600s 自然过期兜底
   （结算侧 actual 回填动词 backfillTpm 保留在 runtime 限流器，v2 尚未接线）
```

---

## 4. 分图③：预扣

### 4a. 输入 token 估算（双口径，v2 裁决 C1）

> 代码：`packages/inference/src/domain/model/output-cap.ts`（字节上界）、
> `packages/inference/src/domain/usage/estimate.ts`（特征校准估算）、
> `packages/ai/src/usage/token-estimate.ts`（ai 内部估算单一真相）。

```
inputUpperBound = JSON.stringify(body) 的 UTF-8 字节数      ← 预扣敞口 / TPM 预占专用
                   （每 token 至少 1 字节——宁可多押）
inputEstimate    = 特征四计数器 × 校准权重                    ← 缺 usage 的实扣兜底口径
                   （CJK×0.7 + 单词×1.1 + 数字×1.0 + 符号×1.0，缺省 = v1 校准缺省；
                    v2 ai 不再向 inference 公开 BPE 估算器——实扣口径退回特征校准，
                    ai 包内部的 token-estimate.ts 仍保留 BPE 主路径供其自身 usage 估算）
！！字节上界绝不入实扣——否则故障/缺 usage 流的 input 多收数倍
（残缺交付贵于完整交付）
```

### 4b. 输出 token 上界与转发钳制

> 代码：`packages/inference/src/domain/model/output-cap.ts`。

```
outputCap = min( (max_completion_tokens ?? max_tokens ?? 4096) × n, 32768 )
             （embeddings / 模态族 = 0；32768 = GATEWAY_OUTPUT_EXPOSURE_CAP）

转发钳制 clampForwardedOutputLimit：
  发往上游的 max_tokens / max_completion_tokens 压到 floor(outputCap / n)
  → 「实际可能输出 ≤ 预扣口径」成为结构保证
  v2 与 v1 的差异：两者均未声明时**注入** max_completion_tokens = floor(outputCap/n)
  （v1 「不注入」口径已改——禁止无限输出越过预扣敞口；超缺省口径的部分
   仍由 §7d 的 #over 通道兜底）
```

### 4c. 保守预估公式

> 代码：`packages/billing/src/domain/rating/pricing.ts`（estimateMaxCost）与
> `calculate.ts`（calculateRequired / calculateFundingReservation）。

```
每候选预估 = ( max(inputPrice, cacheInputPrice, cacheWritePrice) × 输入token上界   ← 三价取最贵
              + outputPrice × outputCap
              + unitPrice × unitUpperBound ) ÷ 1,000,000 × coefficient
              （缓存写价可超输入价：Anthropic 1.25×/2×——B2 加固；单位轴：
               images=张数 / audio=秒 / speech=字符）

预估(最终) = max(主模型, fallback₁, …)          ← 候选链取最贵
           → requiredReservation(预估, ¥1000)   ← 单请求预扣上限（BILLING_RESERVATION_MAX；
                                                    超限只拒绝绝不截断）

实际冻结额 = full  ? 完整预估
           : fixed ? BILLING_FIXED_RESERVATION_AMOUNT（仅纯 PAYG；免费请求仍为 0；
                    最终超出部分走 #over 全额补扣）
日限额/在途风险始终使用完整预估，不使用 fixed 冻结额（两口径解耦——fixed 不是封顶或折扣）

上游成本预估 = 同公式但 coefficient = 1（官方价口径）→ 渠道「进货额度」敞口闸用
防御：负数/NaN/Infinity 一律 safe()→0；负单价与 coefficient≤0 钳 0；cached 夹到 ≤input
——任何异常上游响应或配置错误都算不出负金额；零价但未声明免费 = 配置事故结构性拒绝
```

### 4d. 资金规划（两阶段①：probe 不动账）

> 代码：`packages/billing/src/application/billing/funding/plan.ts`（瀑布①规划）、
> `commit.ts`（瀑布②提交）、`domain/wallet/exposure.ts`（可用额唯一口径）。

```
资金源瀑布（registry 缺省 {subscription, payg}）：
  每个资金源 take = min(该源可用额, 尚缺金额)
  PAYG 可用额 = balance + credit_limit − in_flight（availableToSpend 唯一口径）

放行门：
  ├─ BILLING_RESERVATION_MODE=full（缺省）→ Σtake 必须等于完整预估
  │    （差一分 → insufficient_balance 402 fail-closed，上游零调用）
  └─ BILLING_RESERVATION_MODE=fixed（纯 PAYG）→ 可用额必须 ≥ 固定冻结额，
       hold = BILLING_FIXED_RESERVATION_AMOUNT；最终超出部分走 #over 全额补扣

订阅闸语义在 SubscriptionSource.probe：套餐 Key 且转按量开关 OFF 时覆盖不足
= 整单拒绝；ON = 订阅出余量 PAYG 补差（§org 成员子配额判定同在订阅来源侧）。
```

### 4e. 落账（单 DB 事务）

> 代码：`packages/billing/src/application/billing/authorize.ts`。

```
0. assertCapacity（结算积压准入——bridge 级前置闸，application/billing/admission.ts）
1. 重放快速路径：requestId 已存在且指纹/金额一致且状态 ∈ {authorized, in_flight}
   → 幂等返回（重放不被新的积压、限额、余额或订阅状态误伤）；异指纹 409 state_conflict
2. pg_advisory_xact_lock(user)          ← SUM 类日限额的并发串行化（READ COMMITTED
   看不见并发未提交行——按 user 串行化后唯一冲突兜底重放）
3. 用户日限额：Σ已结算(usage_logs) + Σ在途(billing_requests,排除自身) + 预估 ≤ dailySpendLimit
   Key 日限额：同口径按 apiKeyId 再算一道
4. INSERT billing_requests（requestId 幂等；quote=价格快照（结算验收锚）；
   status=authorized；风险预估与实际冻结分列——estimated_exposure_amount / reserved_amount /
   plan_reserved_amount 三投影列从 plan 算出）
5. 两阶段②：逐来源 wallet.authorize（in_flight += take，行锁重验）+ billing_reservations 明细
   （免费链 fast-path：0 元空计划，不预留，账单行仅供观测）
```

---

## 5. 分图④：调上游

> 代码：`packages/inference/src/application/failover.ts`（候选×渠道双层循环）、
> `chat.ts` / `stream.ts`（两种尝试）、`packages/ai/src/create-ai.ts`（上游执行库）。

```
for candidate of 候选链（主→fallback）:
  channels = resolveChannels(realModel)（目录渠道 + priority 分层 + weight 加权随机序）
  for channel of channels:
    1. 渠道维 RPM（admitChannel 钩子，gateway assembly 装配）→ 超限换渠道
       （渠道维 TPM 预占为 R-E3 在案缺口，未迁）
    2. 健康放行（health.admit——v2 新增闸）：
       熔断 open / 死凭据 invalid → 换渠道；half-open 单探测赢家在此产生
       （死凭据不再走 v1 的 DB status=4 markDead——经 AiEvent 由 inference
        health 状态机记账：连续失败达阈值 → invalid，成功自愈 valid）
    3. 渠道进货硬闸 reserveChannel：upstreamBudget − upstreamReserved ≥ upstreamEstimate(系数=1)？
       换渠道 = 原子「守卫预留新渠道 → 释放旧渠道 → CAS 认领账单行」（CAS 输家全回滚；
       同渠道重复预留按差额补足）
    4. 首次成功预留后 signal(upstream_started)：authorized → in_flight + 起租约
    5. 上游调用（deadline 预算内，缺省 120s）：
       - 非流式：4xx 透传终局（先 request_failed 三路释放后原码返回）；可换错误 → 下一渠道/模型
       - 流式：first_chunk 前可换渠；上线后不换（流内错误已转错误帧）
       - 流式长流：每 TTL/3 续租（下限 1s，上限 100 次防永流；防 recover 误释放
         → 终态冲突 → 漏收）
    6. 全败 → request_failed 三路同事务释放（wallet/套餐/渠道敞口）
       + 503 no_available_channel / 502 upstream_failed（脱敏信封）
```

ai 包内部（计量数据的生产侧）：

| 步骤 | 说明 |
|---|---|
| `Idempotency-Key: requestId` | 同渠道重试时厂商按键去重（`adapters/openai-compatible.ts`）——防「响应丢失重发」上游成本翻倍（用户侧同一 requestId 只有一份收据，差价平台吃；D5） |
| `stream_options 强制注入` | `include_usage:true` 写死——MiniMax 实测缺省不报 usage = 漏计费；逐帧累计让取消时也有最新真实值 |
| 协议归一 | Anthropic/Gemini 流先转规范 OpenAI 帧（`protocol/` 族），扫描器只面对一种形态 |
| SSE 扫描器（`transport/sse-parser.ts`） | 逐帧累计输出内容特征与字节数（终态 `outputFeatures` 随 success 事件旁路上报）——缺 usage 时输出估算的数据源（D1，见 §6） |
| usage 归一化（`usage/normalize.ts`） | OpenAI / DeepSeek cache 方言兼容；自洽性破坏（input≠hit+miss、cached>input、total 对不上）返回 null 不猜 |

---

## 6. 分图⑤：落收据

> 代码：`packages/inference/src/domain/usage/receipt-usage.ts`（usage 信任政策）、
> `receipt.ts`（收据装配）、`packages/billing/src/domain/rating/receipt.ts`
> （validateReceipt）、`application/billing/signal.ts`（四事件状态机入口）。

```
上游终态 → usage 信任政策（三层）：
   ├─【可信 usage（estimated=false）】──最常见──▶ 精确收据
   │     usage = 上游报告的 inputTokens/cachedInputTokens/outputTokens
   │     （cacheWriteTokens>0 必须透传——写价≠输入价，丢弃即错账）
   │
   ├─【ai 估算 usage（estimated=true，ai 内部 BPE/特征口径）】
   │     采纳其数值，收据仍标估算 + estimatedFor 归属
   │
   ├─【完全缺失】──▶ inference 兜底估算收据：
   │     inputTokens  = inputEstimate（§4a 特征校准口径，与预检同源）
   │     outputTokens = 流：estimateTokensFromFeatures(终态 outputFeatures)
   │                   / 非流式：响应体文本过同一校准估算器
   │     cachedInputTokens = 0   ← 一律全价：防「改字破缓存+取消」套利
   │     estimatedFor = client_disconnect（用户取消：client_disconnect/request_cancelled）
   │                   | usage_missing_completed（完成但上游没报）
   │                   | usage_missing_nonstream（非流式缺 usage）
   │                   | upstream_error_partial（上游故障截断+未知终止值兜底）
   │                   | inactivity_timeout | server_draining
   │                   （白名单 ESTIMATE_ATTRIBUTIONS 六值——domain/usage/attribution.ts）
   │
   ├─【失败】──▶ request_failed：released + 三路预扣同事务释放（不扣）
   └─【服务端发布中止】──▶ released（宽限 60s 后切流归因 server_draining，部分交付计费）

validateReceipt 验收（毒收据家族 → 结算侧 dead）：
  userId 一致 / usage 数值自洽（整数非负、cached ≤ input）
  / estimated 必须归属白名单（isAttributedEstimate）
  / 价格快照必须命中授权 quote 的候选（mappingId + externalModel/realModel
  + 四价 + 系数 + 策略指纹全等）
  —— 不用「字节数 vs token 数」判死：真正的资损不变量是金额（§7d）
```

流式收据在管道交还路由后由终态监听异步落库；`signal(request.succeeded)` 成功即
`settlement_pending`（CAS + 指纹幂等，竞态输家按指纹判幂等/冲突），随后事务外
best-effort `pg_notify('settle-wake')` 唤醒 worker（失败不阻断——30s 兜底扫描会捡到）。

signal 落库失败按退避重试（缺省 5 次 / 500ms 起、封顶 8s，`application/signal-retry.ts`）
——重试期间续租定时器不停，一次 DB 抖动不再把已交付请求漏收成 recover 释放；重试耗尽
流式停租约交 recover 兜底（有界损失 + 响亮日志）、非流式 503 finalize_unavailable
不交付（先落账后交付纪律）。

---

## 7. 分图⑥：结算实扣

### 7a. 驱动与认领

> 代码：`apps/worker/src/wakeup/postgres-notify.ts`（LISTEN 消费端）、
> `apps/worker/src/jobs/settlement.ts`（批次 job）、`packages/billing/src/application/settlement/*`。

```
pg_notify('settle-wake') 门铃（网关 signal 成功后事务外投递，只带 requestId）
   → worker 专用连接 LISTEN（不进池循环；断线指数退避重连）
   → coalescing（N 次并发唤醒 ≤ 2 次实际执行）+ drain（认领满批即连跑直到非满批
     或 1000 轮上界——积压一次抽干；以认领计数为排空依据）
30s 定时扫描兜底（WORKER_SETTLE_INTERVAL_MS 缺省；唤醒通道全挂也只降级为该节奏）
认领 = SKIP LOCKED 批量 CAS → processing + ownerId/claimToken/revision/attempt
（单语句 CTE，多副本安全）
批次运行期 setInterval 每 claimLeaseMs/3 续租（renewClaims）——防 recover 误回收
造成双扣重试
优雅停机：归还全部认领（abandonOwnedClaims → retry_wait）+ 等待在途批次
```

### 7b. 实扣公式（与预估共用全部防御，Decimal 全精度永不 round）

> 代码：`packages/billing/src/domain/rating/amounts.ts`（computeAmounts）→
> `pricing.ts`（calcAmount，三段互斥）。

```
cached     = min(cachedInputTokens, inputTokens)
cacheWrite = min(cacheWriteTokens, inputTokens − cached)   ← 写价未配置 = 回落输入价
uncached   = inputTokens − cached − cacheWrite

calculatedAmount = ( inputPrice × uncached
                  + cacheInputPrice × cached
                  + cacheWritePrice × cacheWrite          ← 缓存写段（Anthropic 1.25×/2×）
                  + outputPrice × outputTokens
                  + unitPrice × units ) ÷ 1,000,000 × coefficient   ← 用户侧实扣

upstreamCost     = 同公式 × coefficient=1                            ← 渠道进货扣减口径
```

### 7c. 分配（consume / over）

> 代码：`packages/billing/src/domain/billing/settle-allocation.ts`。

```
把 calculatedAmount 按预扣明细的优先级序（订阅先耗、PAYG 后耗 = 明细 id 序 = 提交序）逐条消耗：
  每条 consume = min(尚待收, 该条预留额)
  全部预留耗尽后的剩余 = over（实际 > 预扣 的部分）：
    有 PAYG 明细 → over 记在 PAYG（兜底源）
    纯订阅链   → over 记在最后一条（订阅来源核销预留内份额、超额转余额补扣）
```

### 7d. PAYG 落账（#over 精确补收）

> 代码：`packages/billing/src/application/billing/funding/payg-source.ts`（settle）、
> `subscription-source.ts`、`application/wallet/{authorize,settle,release}.ts`。

```
over > 0 时（允许负余额全额补收）：
  同事务 wallet.authorize(#over, collectOverage) + wallet.settle(#over)
  ← 补押差价并结清 = 总扣款 consume + over = 实扣额精确全额
  （collectOverage 允许击穿为负余额——fixed 小额冻结模式下的真实超额依赖此路径收全，
   负余额由运营侧追缴/封禁；statement 呈现两笔结算）

consume ≤ hold：wallet.settle 原单（复式腿，余量随结算原语隐式归还）
consume = 0（缓存免费模型 / 上游全 0 usage）：settle 动词拒绝零额——改走
  wallet.release 全额释放（否则零额拒绝不属死信家族 → 10 轮重试全败 dead + 预扣永久冻结）
套餐来源：trySettleQuota 守卫式核销（used + consumed ≤ quota − 在途差额）；
  守卫失败 = BillingStateConflictError 事务整体回滚（红灯，无静默降级路径）；
  纯订阅链超额 → over 转用户余额补扣（同 PAYG collectOverage 语义，可负余额）
不变量：Σ在途明细 == 账单 reserved_amount（不符 = 投影脱节红灯 → dead）；
  收据渠道与账单预留渠道不一致 = 网关回归 → dead（settle_channel_mismatch）
```

### 7e. 投影与收尾（同一事务）

> 代码：`packages/billing/src/application/settlement/settle.ts`（单事务编排）。

```
usage_logs 落库（requestId 唯一幂等；amount = calculatedAmount 全精度；
  estimate_reason = 归属值——供应商质量/故障率/停机补偿三类报表各取所需）
渠道敞口归还（tryDecreaseReserved，失败 = channel_exposure_invariant 红灯）
→ CAS settled（五元组复验：requestId/ownerId/claimToken/revision/租约）
→ 渠道进货真扣 upstreamCost（deductBudgetAndMaybeBreak：余额 ≤ 阈值 → 渠道预算熔断；
  与 inference health 的上游 5xx 熔断器（60s 窗 ≥5 次、冷却 5min、half-open 探测）
  是两回事——前者 DB 预算闸、后者 Redis/内存运行时状态）
结算成功事实不入通知 outbox（死信路径才可靠入箱 billing_dead）；余额预警
  balance_low 经 onSettled best-effort 钩子（失败不反杀结算）
```

---

## 8. 失败、恢复与死信

> 代码：`packages/billing/src/domain/billing/settle-failure.ts`（失败策略纯函数）、
> `application/settlement/{failure,recover}.ts`、
> `packages/inference/src/application/generation-poll.ts`。

```
结算失败分类（按错误三性/目录码判定，不做 message 启发式；v1 的跨包 instanceof 废除）：
  死信家族 = 毒收据 / 用户错配（billing.poison_receipt / receipt_user_mismatch）
    + 配置事故（billing.invalid_* / reservation_limit_exceeded / unknown_reservation_strategy）
    + 一切不变量破坏（DefectError——wallet/channel-budget 同归红灯）
  瞬态（PG 抖动 / 网络 / 守卫竞态）→ 指数退避重试
    缺省 15s 起、600s 封顶、10 次 ≈ 85 分钟耐受（WORKER_* 缺省，装配可调）

recover 三路径（15s 周期，WORKER_RECOVER_INTERVAL_MS）：
  ① authorized 过期且从未发上游 → released（退款）
  ② in_flight 租约过期（网关崩溃）→ released（不扣——信号未落 = 交付存疑）
  ③ processing 认领租约过期（worker 崩溃）→ retry_wait 立即可重领
  ①② 逐单事务毒行隔离：单行归还异常只阻塞自己，不再队头阻塞整批滞留单的资金归还

生成任务族（video/music）：worker 轮询上游任务态（packages/inference generation-poll）
  succeeded → 先 signal(request.succeeded)（收费）后 CAS 终态（交付标记）
             —— 信号失败保留任务行下轮重试，收费永不被吞；billing 已入结算态
             则跳过信号直接终态化（崩溃窗口自愈）
  failed/expired → 先终态后 request_failed 释放（信号失败只记日志，租约到期由 recover 兜底）
  同步阻塞型上游由 worker 代执行（executeDeadlineMs / executeMaxRetries 预算内）
```

---

## 9. 预扣 vs 实扣对照表

| | 预扣（授权时，gateway→billing） | 实扣（结算时，worker→billing） |
|---|---|---|
| token 数 | JSON 字节保守上界（inputUpperBound）+ 输出上限（4a/4b） | 真实：厂商 usage；ai 估算值采纳；完全缺失时特征校准估算（§6） |
| 输入单价 | max(inputPrice, cachePrice, cacheWritePrice) 三价取最贵 | 三段互斥分开按量（uncached/cached/cacheWrite） |
| 输出 token | outputCap（转发体已同口径钳制，未声明时注入） | 厂商实际 outputTokens / 输出特征估算 |
| 落点 | `wallet_authorizations` hold（in_flight += 预扣）+ billing_reservations 明细 | 复式 settle 腿 + in_flight 释放 |
| 精度 | 数量级正确即可（宁可多押） | Decimal 全精度，永不 round |
| 超预扣？ | — | over：#over 补充授权精确全额补收（collectOverage 可负余额） |
| 退款 | 失败/过期三路同事务释放 | 无（已按事实扣） |

---

## 10. 刷费用五向量与防线

资金安全审查确认并封堵的五个「让用户无限刷平台上游费用」向量
（E2E 钉死：`e2e/security/cost-drain.test.ts`）：

| # | 向量 | 攻击形态 | 防线 | 所在节 |
|---|---|---|---|---|
| D1 | 缺 usage 输出按 0 计 | 拉满输出掐线 / 用忽略 include_usage 的供应商 | 扫描器累计输出特征 → 校准估算收费（cached=0 全价） | §6 |
| D2 | 声明巨量 max_tokens | max_tokens=100 万、预扣只按 32768 封顶 | 转发体钳到 预扣口径/n（v2 未声明时亦注入），实际输出 ≤ 敞口成为结构保证 | §4b |
| D3 | 超额结算死信 | 实际用量 >> 余额 → #over 抛错 → 死信 + 平台吃全差 | #over 允许负余额精确全额补收；负余额交运营追缴 | §7d |
| D4 | 无余额硬跑 | 余额 ¥0.5 调高价模型 | 资金瀑布加总不足 → 足额 fail-closed 402，上游零调用 | §4d |
| D5 | 重试双花上游 | 上游已处理但响应丢失 → 重发二次生成 | Idempotency-Key=requestId 厂商侧去重 | §5 |

---

## 11. 附录：状态机

```
                ┌────────────┐
   authorize    │ authorized │──租约过期+从未发上游──recover①──▶ released（退款）
     ────────▶  │ (预扣落账) │
                └─────┬──────┘
                      │ upstream_started（起租约，流式每 TTL/3 续）
                      ▼
                ┌────────────┐
                │ in_flight  │──租约过期（网关崩溃）──recover②──▶ released（不扣）
                └─────┬──────┘
                      │ request_succeeded（可信/估算收据，CAS+指纹幂等）
                      ▼
                ┌────────────────────┐   claim（SKIP LOCKED+租约）
                │ settlement_pending │ ────────────────────────▶ processing
                └────────────────────┘                              │
                      ▲  退避重试（15s~600s × 10）                   │ settleClaim 单事务
                      └────────────── retry_wait ◀──认领租约过期③───┤
                                                                  ▼
                                                              settled（终态）
                released / settled / dead = 终态；dead 唯一人工复核入口
```

> 终态：`released / settled / dead`。`signal(request.failed)`（4xx 透传／换渠耗尽／
> 任务失败）从 `authorized | in_flight` 直达 `released` 并同事务三路归还预扣。
> 全链判定图（Mermaid 版状态机 + 异常总表）见
> [gateway-full-flow.md](gateway-full-flow.md)。

---

## 12. 附录：文件索引

| 模块 | 文件 | 职责 |
|---|---|---|
| gateway | `src/http/middleware/api-key.ts` | 鉴权双分支（静态 Key / app_jwt；Key 双锁、JWT 只计 IP） |
| gateway | `src/http/middleware/rate-limit.ts` | admitRequest 并罚限流 + TPM 预占/归还 + 渠道维 RPM |
| gateway | `src/http/routes/inference-endpoints.ts` | 端点路由：schema → 限流 → inference 调用 → 信封；失败归还 TPM |
| gateway | `src/adapters/billing-port.ts` | inference↔billing 桥（quote 盖章 / 蛇形词表映射 / reserveChannel 官方价口径） |
| gateway | `src/adapters/settle-wake.ts` | `pg_notify('settle-wake')` 门铃生产端 |
| gateway | `src/adapters/catalog-port.ts` | 目录读模型 PG 适配（模型映射/渠道解析） |
| gateway | `src/assembly.ts` / `src/app.ts` / `src/shutdown.ts` | 装配根 / HTTP 链与路由挂载 / 停机宽限 |
| inference | `src/application/quote.ts` | 预检：白名单 → 候选链 → outputCap/钳制 → 双口径估算 |
| inference | `src/application/failover.ts` | 候选×渠道双层循环 + dispatchFailure + releaseAndFail |
| inference | `src/application/chat.ts` | 非流式尝试（先结算后交付；耗尽 503 finalize_unavailable） |
| inference | `src/application/stream.ts` | 流式尝试（决定性事件锚定 + 续租保命 + 终态后台结算） |
| inference | `src/application/signal-retry.ts` | signal 退避重试（5×500ms） |
| inference | `src/domain/model/output-cap.ts` | outputCap + 转发钳制 + JSON 字节上界 |
| inference | `src/domain/usage/estimate.ts` | 特征校准估算（缺 usage 实扣兜底口径） |
| inference | `src/domain/usage/receipt-usage.ts` | usage 信任政策（可信 / ai 估算 / 本包兜底三层） |
| inference | `src/domain/usage/attribution.ts` | ESTIMATE_ATTRIBUTIONS 白名单 + 流式归属映射 |
| inference | `src/domain/routing/{schedule,switchable}.ts` | 加权调度序 + 换渠/竭尽判定 |
| inference | `src/health/{channel-health,breaker,dead-credential}.ts` | 渠道健康闸（熔断 CAS + 死凭据单阈值自愈） |
| inference | `src/application/generation-poll.ts` | 任务族轮询（先信号后终态；超时/代执行） |
| ai | `src/usage/token-estimate.ts` | 估算单一真相（BPE 主路径 + 特征兜底 + 结构提取） |
| ai | `src/usage/normalize.ts` | 厂商 usage 方言归一（自洽性校验） |
| ai | `src/transport/sse-parser.ts` | SSE 扫描器：usage 最后帧胜出 + 输出内容特征累计（D1） |
| ai | `src/transport/relay-stream.ts` | 流透传 + 心跳/静默超时 + 终态分类（terminated 词表） |
| ai | `src/adapters/openai-compatible.ts` | Idempotency-Key 注入 + stream_options 强制（D5） |
| billing | `src/application/billing/authorize.ts` | 预扣事务（重放快径 + advisory lock + 日限额 + 两阶段资金规划） |
| billing | `src/application/billing/signal.ts` | 四事件状态机入口（started/renewed/succeeded/failed） |
| billing | `src/application/billing/reserve-channel.ts` | 渠道进货敞口硬闸（守卫→释放→CAS 顺序不变量） |
| billing | `src/application/billing/admission.ts` | 结算积压准入（assertCapacity） |
| billing | `src/application/billing/funding/{plan,commit,payg-source,subscription-source,release}.ts` | 资金瀑布 probe/take/放行门 + 逐源落账（#over 补收） |
| billing | `src/application/settlement/{claim,process,settle,failure,recover}.ts` | 认领（SKIP LOCKED）→ 结算编排（复验/分配/逐源落账/投影/CAS）→ 失败分类 → 三路径恢复 |
| billing | `src/application/settlement/review/{list,retry,abandon}-dead.ts` | 死信人工复核面 |
| billing | `src/domain/rating/pricing.ts` | calcAmount / estimateMaxCost（金额防御单一真相，三段互斥） |
| billing | `src/domain/rating/calculate.ts` | calculateRequired（四道保守）+ calculateFundingReservation（full/fixed） |
| billing | `src/domain/rating/amounts.ts` | computeAmounts 双口径（用户实扣 / 渠道成本） |
| billing | `src/domain/rating/receipt.ts` | validateReceipt（毒收据家族判定） |
| billing | `src/domain/billing/settle-allocation.ts` | consume/over 分配纯函数 |
| billing | `src/domain/billing/settle-failure.ts` | 死信家族判定 + 退避策略（目录码口径） |
| billing | `src/domain/wallet/exposure.ts` | availableToSpend / assertCanDebit 可用额唯一口径 |
| billing | `src/application/wallet/{authorize,settle,release}.ts` | hold / 双分录实扣 / 释放（幂等三段式） |
| billing | `src/adapters/postgres/billing-store.ts` | 状态机 SQL（CAS/认领/恢复形态；advisory lock） |
| billing | `src/adapters/postgres/billing-store-settlement.ts` | 认领/续租/终态 CAS 的结算侧 SQL（SKIP LOCKED CTE） |
| billing | `src/adapters/postgres/wallet-store.ts` | 双分录账本 SQL |
| billing | `src/adapters/postgres/channel-exposure-store.ts` | 渠道敞口/进货扣减/预算熔断 SQL |
| worker | `src/jobs/settlement.ts` | 结算批次 job + 恢复 job（租约保活 interval 续租） |
| worker | `src/wakeup/postgres-notify.ts` | PG LISTEN 消费端（coalescing + drain + 断线重连） |
| worker | `src/{scheduler,index,assembly,shutdown}.ts` | 循环调度器 / 进程入口 / 装配根（jobs+wakeup 注册）/ 停机收口 |
| observability | `src/adapters/postgres/request-log-store.ts` | 请求日志落库（/v1 全量，401/429 也入） |

> 管线结构与文件地图的一页版见 [gateway-pipeline.md](gateway-pipeline.md)；
> 全链路判定细节（含 Mermaid 状态机）见 [gateway-full-flow.md](gateway-full-flow.md)。
