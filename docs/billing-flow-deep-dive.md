# 扣款全流程深度解析（gateway / packages/ai / worker / wallet）

> 本文是生产链路的扣款真相文档（2026-08-19 资金安全大审查后口径）。
> v1 管线（旧 apps/gateway + packages/ledger + `reserved_balance` 列 + uncertain
> 状态）已随 v1 代码整体退役删除，本文即唯一真相。
>
> 覆盖范围：`apps/gateway`（热路径）、`packages/ai`（上游传输）、`packages/service`
> （billing/settlement/generation 域）、`apps/worker`（结算）、`packages/wallet`
> （双分录账本内核）与 `packages/domain`（金额纯函数）。所有公式与流程均以源码为准。

---

## 目录

1. [总体架构：四应用、一个账本内核](#1-总体架构)
2. [分图①：鉴权（凭证三形态）](#2-分图鉴权)
3. [分图②：限流与准入](#3-分图限流与准入)
4. [分图③：预扣（扣款公式核心）](#4-分图预扣)
5. [分图④：调上游（计量数据的生产侧）](#5-分图调上游)
6. [分图⑤：落收据（可信 / 估算两分支）](#6-分图落收据)
7. [分图⑥：结算实扣（worker）](#7-分图结算实扣)
8. [失败、恢复与死信](#8-失败恢复与死信)
9. [预扣 vs 实扣对照表](#9-预扣-vs-实扣对照表)
10. [刷费用五向量与防线（2026-08-19 封堵）](#10-刷费用五向量与防线)
11. [附录：billing_requests 状态机（8 态）](#11-附录状态机)
12. [附录：文件索引](#12-附录文件索引)

---

## 1. 总体架构

```
客户端 ──HTTP/SSE──▶ apps/gateway（热路径：鉴权→限流→预扣→调上游→落收据）
                          │  ▲
                          │  └─ packages/ai（适配器/重试/熔断/流中继/SSE 扫描器）
                          ▼
                    PostgreSQL（billing_requests = 唯一事实源）
                          │    ▲
                          │    └─ packages/wallet（双分录：wallet_accounts/authorizations/legs）
                          ▼
apps/worker（结算：BullMQ 唤醒 + 认领→实扣→对账→恢复）─▶ Redis（限流/门铃队列，必配）
        ▲
        └─ BullMQ 'settle-wake'（纯门铃：只带 requestId，可丢——DB 轮询兜底）
```

与 v1 的关键差异：

| | v1 | v2 |
|---|---|---|
| 账本 | `users.reserved_balance` 单列冻结 | wallet 双分录内核：`wallet_authorizations`（hold）+ `wallet_legs`（复式流水），`in_flight` 为冻结口径 |
| 结算余额口径 | `balance`/`reserved_balance` 两列 | `balance + credit_limit − in_flight = available`（`assertCanDebit` 唯一守卫） |
| 超预扣 | DB check 约束 `balance ≥ −credit_limit`，触底 23514 → dead | `#over` 同事务补充授权；**余额不足时降级收满预留**（不再死信，见 §7d） |
| uncertain 状态 | 存在（冻结待人工） | 不存在：完成缺 usage / 用户取消 → 估算结算；上游异常 / 崩溃 → 即时释放 |
| 预扣不足 | 信用模型吸收 | 未声明 `balanceFloor` 的模型**足额 fail-closed**（402 整单拒绝，上游零调用） |
| 应用 | apps/gateway、apps/worker | apps/gateway、apps/worker（v1 已于 2026-08-20 退役删除） |

---

## 2. 分图①：鉴权

> 代码：`apps/gateway/src/middleware/api-key.ts`、`packages/repository/src/credential.repo.ts`

```
Authorization: Bearer <token>
   │
   ├─ token 以 ag_ 开头 ──▶ 【静态 API Key】
   │     1. sha256 → keyHash
   │     2. 双层爆破锁：per-keyHash（同 Key 撞库）+ per-IP（随机 Key 扫射）——均 fail-closed
   │     3. DB 单语句守卫：api_keys.status=0 且未过期 且 JOIN users.status=0
   │        （封禁用户的存量 Key 立即失效——2026-08-19 补 join）
   │     4. 限流维度 = key:{apiKeyId} + user:{userId}（并罚）
   │
   └─ 否则 ──▶ 【JWT】（jose HS256，iss=ai-gateway / aud=ai-gateway-api 强制；
         per-IP 爆破锁与静态 Key 分支同口径——验签失败计数、达阈锁定、
         Redis 故障 fail-closed 503；2026-08-19 终审补齐，原缺口=伪造 JWT 无限 401）
         ├─ typ=app_jwt：app_id 必须是 apps 数字主键 → findActiveAppById（app+user 双活）
         │    限流维度 = app:{appId}（scope 限额）+ user:{userId}（管理端用户帽）并罚
         └─ typ=playground：client-api 每请求现签（TTL 300s，rpm 10 / tpm 200k）
              限流维度 = pg:{userId}（scope 限额）+ user:{userId}（用户帽）并罚
        （用户维对全部凭证形态无条件在列——用户自建 App 声明大 scope
          不得绕过管理端用户帽；2026-08-19 终审修复，原缺口=JWT 路径用户帽整族失效）
```

要点：限流维度串只由服务端从 DB/令牌载荷推导，客户端不可选；来源 IP 取真实
socket 地址 + 信任代理头（`TRUSTED_PROXY_HOPS` 模型），不可伪造。

---

## 3. 分图②：限流与准入

> 代码：`apps/gateway/src/rate-limit/gate.ts`、`packages/core/src/rate-limiter.ts`

```
1. admitKey（RPM 原子判定 + TPM 预占；维度 = 凭证（key:/app:/pg:）+ 用户 + global 并罚，任一超限即拒）
   预估总量 = estimateInputTokens(body) + outputCap        ← 与预扣同源（§4）
   超限 → 429；Redis 故障 → 503 fail-closed
2. buildQuote（模型解析 + 价格快照）失败（404/403）→ 归还 TPM 预占
3. 免费模型日限（唯一防线）→ 429/503 时同样归还 TPM 预占
4. billing.authorize 被拒（402/限额）→ 归还 TPM 预占
   （其余罕见异常路径由预占 TTL 600s 自回收）
```

TPM 是"预占-回填"两套口径：预占按估算，结算按真实 usage 归属到成功渠道/模型维度
（failover 试过即弃的维度不计入 actual）。

---

## 4. 分图③：预扣

### 4a. 输入 token 估算（与结算估算同源）

> 代码：`packages/ai/src/usage/token-estimate.ts`

```
estimateInputTokens(body) =
    CJK字数×0.7 + 拉丁单词段×1.1 + 数字段×1.0 + 符号×1.0   （校准权重）
  + messages.content（string 或多模态 part 数组；每媒体 part ≥85 token 下限）
  + 历史 tool_calls（function.name + arguments）
  + tools 定义体整体估算
  + embeddings input（string / string[] / token-id 数组每 id 计 1）
  + 生成类 prompt/query + 供应商 template 偏移（DeepSeek≈70 / MiniMax≈160）
```

### 4b. 输出 token 上界与转发钳制

> 代码：`apps/gateway/src/pipeline/output-cap.ts`

```
outputCap = min( (max_completion_tokens ?? max_tokens ?? 4096) × n, 32768 )
             （embeddings = 0；32768 = GATEWAY_OUTPUT_EXPOSURE_CAP）

转发钳制（2026-08-19，D2）：clampForwardedOutputLimit
  发往上游的 max_tokens / max_completion_tokens 压到 floor(outputCap / n)
  → 「实际可能输出 ≤ 预扣口径」成为结构保证
  不注入未声明值（o 系列拒收 max_tokens 的兼容坑）；未声明时超出 4096 缺省
  口径的部分由 §7d 的 #over 通道兜底
```

### 4c. 保守预估公式

> 代码：`packages/domain/src/rating/pricing.ts`（estimateMaxCost / calcAmount 共用防御）

```
每候选预估 = ( max(inputPrice, cacheInputPrice) × 输入token上界      ← 缓存命中率未知，按贵的算
              + outputPrice × outputCap
              + unitPrice × unitUpperBound ) ÷ 1,000,000 × coefficient
              （单位轴：images=张数 / audio=秒 / speech=字符；unitFloor 只抬不降）

预估(最终) = max(主模型, fallback₁, …)          ← 候选链取最贵
           → requiredReservation(预估, ¥1000)   ← 单请求预扣上限（BILLING_RESERVATION_MAX）

上游成本预估 = 同公式但 coefficient = 1（官方价口径）→ 渠道「进货额度」敞口闸用
防御：负数/NaN/Infinity 一律 safe()→0；负单价钳 0；cached 夹到 ≤input —— 任何异常
上游响应或配置错误都算不出负金额
```

### 4d. 资金规划（两阶段①：probe 不动账）

> 代码：`packages/service/src/funding/plan.ts`、`packages/wallet/src/exposure.ts`

```
每个资金源 take = min(该源可用额, 尚缺金额)
  PAYG 可用额 = balance + credit_limit − in_flight （assertCanDebit 唯一口径）

放行门 admitsReservation(balanceFloor, Σtake, 预估):
  ├─ 模型未声明 billing_config.reservation → 足额 fail-closed：
  │    Σtake 必须 == 预估，差一分 → 402 拒绝（上游零调用，平台损失严格为零）
  └─ 声明 balanceFloor=¥X（文本模型「余额几毛也能跑」运营选项）：
       Σtake ≥ X 即放行，hold = 实筹额（封顶用户余额）
```

### 4e. 落账（单 DB 事务）

```
1. assertCapacity（结算积压准入——结算系统自我保护）
2. pg_advisory_xact_lock(user)          ← SUM 类日限额的并发串行化
3. 用户日限额：Σ已结算(usage_logs) + Σ在途(billing_requests) + 预估 ≤ dailySpendLimit
   Key 日限额：同口径按 apiKeyId 再算一道
4. INSERT billing_requests（requestId 幂等；同指纹重放 / 异指纹 409）
   status=authorized，quote=价格快照（结算验收锚）
5. 两阶段②：逐来源 wallet.authorize（in_flight += take）+ billing_reservations 明细
   （免费链 fast-path：0 元空计划，不预留，账单行仅供观测）
```

---

## 5. 分图④：调上游

> 代码：`apps/gateway/src/pipeline/run-chat.ts`、`packages/ai/src/create-ai.ts`

```
候选模型 × 渠道（priority 分层 + weight 加权随机）双循环：
  1. 渠道维 RPM/TPM → 超限换渠道
  2. 渠道进货硬闸：upstreamBudget − upstreamReserved ≥ upstreamEstimate(系数=1)？
     换渠道 = 原子「释放旧敞口 + 预留新敞口」（CAS 输家全回滚）
  3. signal(upstream.started)：authorized → in_flight + 起租约
  4. 上游调用（deadline 预算内）：
     - 非流式：4xx 直接失败；可换错误 → 下一渠道/模型
     - 流式：first_chunk 前可换渠；上线后不换（流内错误已转错误帧）
     - 流式长流：每 lease/3 续租（防 recover 误释放 → 终态冲突 → 漏收）
  5. 死凭据（401/403 特征）→ 渠道 status=4 永久退出路由
  6. 全败 → request.failed 三路同事务释放（wallet/套餐/渠道敞口）+ 502 脱敏信封
```

ai 包内部（计量数据的生产侧）：

| 步骤 | 说明 |
|---|---|
| `Idempotency-Key: requestId` | 同渠道重试时厂商按键去重——防「响应丢失重发」上游成本翻倍（用户侧同一 requestId 只有一份收据，差价平台吃；D5） |
| `stream_options 强制注入` | `include_usage:true` + `continuous_usage_stats:true` 写死——MiniMax 实测缺省不报 usage = 漏计费；逐帧累计让取消时也有最新真实值 |
| 协议归一 | Anthropic/Gemini 流先转规范 OpenAI 帧（delta.content + 合成 usage 帧），扫描器只面对一种形态 |
| SSE 扫描器（2026-08-19 起） | **逐帧累计输出内容**（delta.content/reasoning_content/text/tool_calls 参数，4MB 上界）——缺 usage 时输出估算的数据源（D1，见 §6） |
| usage 归一化 | OpenAI / DeepSeek cache 方言兼容；自洽性破坏（input≠hit+miss、cached>input、total 对不上）返回 null 不猜 |

---

## 6. 分图⑤：落收据

> 代码：`apps/gateway/src/pipeline/run-chat.ts`（streamReceiptUsage）、`receipt.ts`、
> `packages/domain/src/rating/receipt.ts`（validateReceipt）

```
上游终态
   │
   ├─【可信 usage（estimated=false）】──最常见──▶ 精确收据
   │     usage = 上游报告的 inputTokens/cachedInputTokens/outputTokens
   │
   ├─【缺 usage / usage 不可信】──▶ 估算收据（2026-08-19 后输出≠0，D1）
   │     inputTokens  = usage?.inputTokens ?? estimateInputTokens(body)   ← 与预扣同源
   │     outputTokens = estimateTextTokens(扫描器累计的输出文本)          ← 同一校准估算器
   │     cachedInputTokens = 0   ← 一律全价：防「改字破缓存+取消」套利
   │     estimatedFor = client_disconnect（用户取消）
   │                   | usage_missing_completed（完成但上游没报）
   │                   | usage_missing_nonstream（非流式缺 usage，输出按响应体估算）
   │
   ├─【失败】──▶ request.failed：released + 三路预扣同事务释放（不扣）
   └─【服务端发布中止】──▶ released（平台吸收发布成本）

validateReceipt 验收（毒收据家族 → 结算侧 dead）：
  userId 一致 / usage 数值自洽（整数非负、cached ≤ input）
  / estimated 必须归属 isAttributedEstimate 白名单（用户取消 ∪ 完成缺 usage）
  / 价格快照必须命中授权 quote 的候选（mappingId + 三价 + 系数 + 策略指纹全等）
  —— 不用「字节数 vs token 数」判死：真正的资损不变量是金额（§7d）
```

流式收据在响应交还路由后由终态监听异步落库；`signal(request.succeeded)` 成功即
`settlement_pending`（CAS + 指纹幂等，竞态输家按指纹判幂等/冲突），随后 BullMQ
best-effort 唤醒 worker（失败不阻断——30s 兜底扫描会捡到）。

signal 落库失败按退避重试（5 次 / 500ms 起，`signalSucceededWithRetry`）——重试期间
续租定时器不停，一次 DB 抖动不再把已交付请求漏收成 recover 释放；重试耗尽才停租约
交 recover 兜底（有界损失 + 响亮日志）。非流式同款重试，耗尽 503 不交付
（先落账后交付纪律）。2026-08-19 终审修复。

---

## 7. 分图⑥：结算实扣

### 7a. 驱动与认领

> 代码：`apps/worker/src/run-once.ts`、`wakeup.ts`、`packages/service/src/settlement/*`

```
BullMQ 'settle-wake' 门铃（网关 signal 成功后投递，固定 jobId 去重突发）
   → worker 消费端：排空循环（pendingCount 驱动，连续消费批次直到非满批——积压一次抽干）
30s 定时扫描兜底（唤醒通道全挂也只降级为该节奏）
认领 = SKIP LOCKED 批量 CAS → processing + claim_token/revision/claim_until
长批次每 lease/3 续租（renewClaims）——防 recover 误回收造成双扣重试
优雅停机：归还全部认领（abandonOwnedClaims）+ 等待在途批次
```

### 7b. 实扣公式（与预估共用全部防御，Decimal 全精度永不 round）

> 代码：`packages/domain/src/rating/amounts.ts`（computeAmounts → calcAmount）

```
cached   = min(cachedInputTokens, inputTokens)
uncached = inputTokens − cached

calculatedAmount = ( inputPrice × uncached
                  + cacheInputPrice × cached
                  + outputPrice × outputTokens
                  + unitPrice × units ) ÷ 1,000,000 × coefficient   ← 用户侧实扣

upstreamCost     = 同公式 × coefficient=1                            ← 渠道进货扣减口径
```

### 7c. 分配（consume / over）

> 代码：`packages/domain/src/billing/settle-allocation.ts`

```
把 calculatedAmount 按预扣明细的优先级序（= 提交序）逐条消耗：
  每条 consume = min(尚待收, 该条预留额)
  全部预留耗尽后的剩余 = over（实际 > 预扣 的部分）
```

### 7d. PAYG 落账（含 2026-08-19 超额兜底，D3）

> 代码：`packages/service/src/funding/payg-source.ts`、`packages/wallet/src/settle.ts`

```
over > 0 时：
  ① 同事务 wallet.authorize(#over) + wallet.settle(#over)   ← 补押差价并结清 = 精确收取
  ② 余额不足（InsufficientBalance/Cash）→ 降级：跳过 #over，只收 consume
     （consume = 全部预留 ≈ 用户全部余额）
     → 账单照常 settled、余额清零、在途清零——不再死信、不再冻结用户资金
     → 损失有界：上界 = 用户充值总额（日志留痕 "[payg] over-collect unavailable"）

consume ≤ hold：wallet.settle 原单（双腿 [持有人 −a, 平台收入 +a]，余量随结算释放）
consume = 0（缓存免费模型 / 上游全 0 usage）：settle 动词拒绝零额——改走
  wallet.release 全额释放（2026-08-19 终审修复；原路径 InvalidAmountError
  不属死信家族 → 10 轮重试全败 dead + 预扣永久冻结）
套餐来源：consume(+over) 计入套餐消耗（§org 成员子配额在 probe 侧）；
  实际用量超池容量（未声明 max_tokens 的请求不注入输出钳制、上游 usage 与
  估算口径差）→ settleQuotaBounded 降级核销：FOR UPDATE 锁行后钳到
  「quota − used − 其他在途」，差额记损日志——不再红砬死信冻结预占
  （PAYG D3 的订阅对称，2026-08-19 终审修复）
不变量：Σ在途明细 == 账单 reserved_amount（不符 = 投影脱节红灯 → dead）
```

### 7e. 投影与收尾（同一事务）

```
usage_logs 落库（requestId 唯一幂等；amount = calculatedAmount 全额——
  即使 7d 走了降级也记真实消费额，差额=有界损失可对账）
渠道敞口归还 → CAS settled（五元组复验）→ 渠道进货真扣 upstreamCost
（余额 ≤ 阈值 → 渠道熔断 status=3；判定在 SQL 侧 numeric 精确比较——drizzle
  returning 的 numeric 是 string，JS 侧比较是字典序，2026-08-19 终审修复）
```

---

## 8. 失败、恢复与死信

> 代码：`packages/domain/src/billing/settle-failure.ts`、`packages/service/src/settlement/recover.ts`、`generation/poll.ts`

```
结算失败分类（结构化 instanceof，不做 message 启发式）：
  毒收据 / 用户错配 / 配置事故 / 不变量破坏 → dead（永不自动处置，人工复核）
  瞬态（PG 抖动 / 网络 / 守卫竞态）→ 指数退避重试
    默认 15s 起、600s 封顶、10 次 ≈ 85 分钟耐受（2026-08-19 从秒级拉长——
    原参数下一次 PG 抖动就把整批 pending 打成死信冻结用户资金）

recover 三路径（15s 周期）：
  ① authorized 过期且从未发上游 → released（退款）
  ② in_flight 租约过期（网关崩溃）→ released（不扣，2026-08-17 政策）
  ③ processing 认领租约过期（worker 崩溃）→ retry_wait 立即可重领
  ①② 逐单事务执行（2026-08-19 毒行隔离）：单行归还异常只阻塞自己，
  不再队头阻塞整批滞留单的资金归还

生成任务族（video/music）：worker 轮询上游任务态
  succeeded → 先 signal(request.succeeded)（收费）后 casTerminal（交付标记）
             —— 信号失败保留任务行下轮重试，收费永不被吞（2026-08-19 倒序）
  failed/expired → request.failed 释放
```

---

## 9. 预扣 vs 实扣对照表

| | 预扣（授权时，gateway） | 实扣（结算时，worker） |
|---|---|---|
| token 数 | 估算：字符特征×校准权重 + 输出上限（4a/4b） | 真实：厂商 usage；缺失时输出按累计内容估算（§6） |
| 输入单价 | max(inputPrice, cachePrice) 保守 | inputPrice / cachePrice 分开按量 |
| 输出 token | outputCap（转发体已同口径钳制） | 厂商实际 outputTokens / 内容估算 |
| 落点 | `wallet_authorizations` hold（in_flight += 预扣） | 双分录 settle 腿 + in_flight 释放 |
| 精度 | 数量级正确即可 | Decimal 全精度，永不 round |
| 超预扣？ | — | over：余额足 → #over 精确补收；不足 → 收满预留（损失有界） |
| 退款 | 失败/过期三路同事务释放 | 无（已按事实扣） |

---

## 10. 刷费用五向量与防线

2026-08-19 资金安全大审查确认并封堵的五个「让用户无限刷平台上游费用」向量
（E2E 钉死：`apps/gateway/src/__tests__/e2e-cost-drain.test.ts`）：

| # | 向量 | 攻击形态 | 防线 | 所在节 |
|---|---|---|---|---|
| D1 | 缺 usage 输出按 0 计 | 拉满输出掐线 / 用忽略 include_usage 的供应商 | 扫描器累计输出内容 → 校准估算收费（cached=0 全价） | §6 |
| D2 | 声明巨量 max_tokens | max_tokens=100 万、预扣只按 32768 封顶 | 转发体钳到 预扣口径/n，实际输出 ≤ 敞口成为结构保证 | §4b |
| D3 | 超额结算死信 | 实际用量 >> 余额 → #over 抛错 → 死信 + 平台吃全差 | 降级收满预留：损失上界 = 用户充值总额，不死信不冻资 | §7d |
| D4 | 无余额硬跑 | 余额 ¥0.5 调高价模型 | 未声明 balanceFloor → 足额 fail-closed 402，上游零调用 | §4d |
| D5 | 重试双花上游 | 上游已处理但响应丢失 → 重发二次生成 | Idempotency-Key=requestId 厂商侧去重 | §5 |

---

## 11. 附录：状态机

```
                ┌────────────┐
   authorize    │ authorized │──租约过期+从未发上游──recover①──▶ released（退款）
     ────────▶  │ (预扣落账) │
                └─────┬──────┘
                      │ upstream.started（起租约，流式每 lease/3 续）
                      ▼
                ┌────────────┐
                │ in_flight  │──租约过期（网关崩溃）──recover②──▶ released（不扣）
                └─────┬──────┘
                      │ request.succeeded（可信/估算收据，CAS+指纹幂等）
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

---

## 12. 附录：文件索引

| 模块 | 文件 | 职责 |
|---|---|---|
| gateway | `src/pipeline/run-chat.ts` | 管线编排（流式/非流式双分支 + 估算收据 + TPM 归还） |
| gateway | `src/pipeline/output-cap.ts` | outputCap 口径 + 转发钳制（D2） |
| gateway | `src/pipeline/receipt.ts` | 收据装配（价格快照 + usage + units 计量） |
| gateway | `src/quote/build-quote.ts` | 候选链解析 + 系数 + 单位上界 + 定价策略 |
| gateway | `src/routes/oauth-token.ts` | App JWT 签发（iss/aud + ipGuard） |
| ai | `src/transport/sse-parser.ts` | SSE 扫描器：usage 最后帧胜出 + **输出内容累计**（D1） |
| ai | `src/transport/relay-stream.ts` | 流透传 + 心跳/静默超时 + 终态分类 |
| ai | `src/usage/token-estimate.ts` | 校准估算器（输入/输出/工具全口径） |
| ai | `src/usage/normalize.ts` | 厂商 usage 方言归一（自洽性校验） |
| service | `src/billing/authorize.ts` | 预扣事务（advisory lock + 日限额 + 两阶段资金规划） |
| service | `src/billing/signal.ts` | 四事件状态机入口（started/renewed/succeeded/failed） |
| service | `src/funding/plan.ts` / `payg-source.ts` | probe/take/放行门 + PAYG 落账（#over 兜底 D3） |
| service | `src/settlement/settle.ts` | 结算编排（复验/分配/逐源落账/投影/CAS） |
| service | `src/settlement/recover.ts` | 三路径恢复（逐单事务毒行隔离） |
| service | `src/generation/poll.ts` | 任务族轮询（先信号后终态） |
| domain | `src/rating/pricing.ts` | estimateMaxCost / calcAmount（金额防御单一真相） |
| domain | `src/rating/calculate.ts` | requiredReservation 推导（四道保守） |
| domain | `src/billing/settle-allocation.ts` | consume/over 分配纯函数 |
| domain | `src/rating/receipt.ts` | validateReceipt（毒收据家族判定） |
| wallet | `src/authorize.ts` / `settle.ts` | hold / 双分录实扣（幂等三段式） |
| wallet | `src/exposure.ts` | assertCanDebit 可用额唯一口径 |
| worker | `src/run-once.ts` / `wakeup.ts` / `index.ts` | 认领批次 + 唤醒排空 + 生命周期 |
| repository | `src/billing-request.repo.ts` | 状态机 SQL（CAS/认领/恢复逐单形态） |
