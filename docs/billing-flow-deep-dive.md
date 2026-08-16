# 扣款全流程深度解析（gateway / ai / worker）

> 覆盖范围：`apps/gateway`（热路径）、`packages/ai`（上游传输）、`apps/worker`（结算）、
> 以及背后的账本核心 `packages/ledger` 与 `packages/money`。
> 所有公式与流程均以源码为准，文末附文件索引。

---

## 目录

1. [总体架构：三条进程、一个事实源](#1-总体架构)
2. [总图：一次请求的完整生命周期](#2-总图)
3. [分图①：鉴权](#3-分图鉴权)
4. [分图②：限流](#4-分图限流)
5. [分图③：预扣（含扣款公式）](#5-分图预扣)
6. [分图④：调上游](#6-分图调上游)
7. [分图⑤：落收据](#7-分图落收据)
8. [分图⑥：结算实扣（worker）](#8-分图结算实扣)
9. [预扣 vs 实扣对照表](#9-预扣-vs-实扣对照表)
10. [上游大模型厂商对接](#10-上游大模型厂商对接)
11. [扣款正确性保障体系](#11-扣款正确性保障体系)
12. [边界与取舍](#12-边界与取舍)
13. [附录：billing_requests 状态机](#13-附录状态机)
14. [附录：文件索引](#14-附录文件索引)

---

## 1. 总体架构

```
客户端 ──HTTP/SSE──▶ apps/gateway（热路径：鉴权→限流→预扣→调上游→落收据）
                        │  ▲
                        │  └─ packages/ai（上游传输：适配器/重试/熔断/流中继/usage 提取）
                        ▼
                  PostgreSQL（billing_requests = 唯一事实源）
                        ▲
                        │ BullMQ 只发 requestId 唤醒（可丢，DB 轮询兜底）
apps/worker（结算：认领→实扣→对账→恢复）─▶ Redis（限流/熔断/路由缓存/队列，全部可降级）
```

核心设计决策：

| 决策 | 内容 |
|---|---|
| **唯一事实源** | PostgreSQL 是资金唯一事实源；Redis/BullMQ 全部是可降级的加速层。队列消息只带 `requestId`，不带任何资金数据（`apps/gateway/src/services/billing/billing-dispatcher.ts:6`），结算事实只从 DB 收据读取。 |
| **两阶段扣款** | 热路径只做「冻结」（`reserved_balance`），worker 结算才做「真扣」（`balance`）。 |
| **估算与实测分界** | 估算值只用于授权预扣与 TPM 预占；资金结算只认厂商回传的真实 usage（G1 不变量）。 |
| **不确定即冻结** | 分不清该不该收钱时转 `uncertain` 冻结预扣，等回执/人工复核/小额自动放行，绝不瞎扣或瞎退。 |
| **预扣口径（2026-08 拍板）** | 预扣用校准估算而非字符硬上界——估算偏小导致结算实扣可超预扣，该敞口由 `credit_limit` 信用模型 + DB 约束兜底，换取更少的资金占用（`llm-pipeline.ts:113`）。 |

---

## 2. 总图

```
客户端 POST /v1/chat/completions (Bearer ag_xxx / JWT)
   │
   ▼
┌──────────────────── GATEWAY 热路径（同步，毫秒级）────────────────────┐
│                                                                      │
│  ①鉴权 ──▶ ②限流 ──▶ ③预扣(授权) ──▶ ④调上游 ──▶ ⑤落收据 ──▶ 响应客户端 │
│    │         │          │               │            │                │
│  谁在调用   挡频率     冻结多少钱        真正转发      把"事实"先写进DB   │
│  能用啥模型 挡总量     (不动余额)        给厂商        再回客户端        │
└──────┬──────────────────────────────────────────────────┬───────────┘
       │ 每阶段写 billing_requests 状态                     │ 收据落库后
       ▼                                                  ▼
   PostgreSQL ═══ 唯一资金事实源 ═══              BullMQ 只发 requestId 唤醒
       ▲                                                 │ (丢了也不怕,轮询兜底)
       │                                                 ▼
       └──────── 认领→实扣→settled ◀──────────── WORKER 结算(异步,秒级)
                                      + 恢复循环(退款/转uncertain) + 对账(周期)
```

一句话总纲：**热路径只做"冻结"，worker 才做"真扣"；PostgreSQL 是唯一账本，Redis/队列全是可丢的加速层。**

---

## 3. 分图①：鉴权

> 代码：`apps/gateway/src/middleware/auth.ts`、`apps/gateway/src/services/auth/auth-service.ts`

```
Authorization: Bearer <token>
   │
   ├─ 没有 Bearer 头? ──────────────▶ 401 凭证缺失
   │
   ├─ token 以 ag_ 开头? ──是──▶ 【静态 API Key 路径】
   │     │
   │     1. sha256(token) 得 keyHash          ← 明文 Key 不落库不进缓存
   │     2. 该 keyHash 被爆破锁定中? ──是──▶ 429 (S2 暴力破解防护)
   │     3. Redis 缓存查 keyHash→鉴权快照       ← cache miss 才查 DB, 挡热路径查库
   │     4. DB: api_keys 按 keyHash + 未过期过滤 ← C4: 过期 Key 在 SQL 层直接排除
   │     5. 查不到 ──▶ 401 + 来源IP失败计数     ← 随机 Key 不写 per-key 计数防 Redis 打爆
   │     6. Key 已吊销/用户被禁? ──▶ 401
   │     7. 查费率卡得 coefficient              ← 决定这个用户按官方价 × 多少倍收费
   │     8. 成功 → 清零爆破计数, 返回 AuthContext
   │
   └─ 否则 ──▶ 【JWT 路径】
         1. verifyJwt(签名+过期) ──失败──▶ 401 token_expired / invalid_token
         2. 查 app 状态(Redis 缓存 60s) ──禁用──▶ 401
         3. 返回 AuthContext{ appId, allowedModels(scope), ... }
   │
   ▼
AuthContext = { userId, apiKeyId|appId, credentialType,
                coefficient(费率系数), allowedModels, rpm/tpm 限额画像 }
```

| 步骤 | 一句话解释 |
|---|---|
| keyHash | 库里只存 SHA-256，泄库也拿不到明文 Key。 |
| 爆破锁 | 同一 Key 连续认证失败达阈值就临时锁死，防离线撞 Key。 |
| 来源失败计数 | 换着随机 Key 撞接口的 IP 直接被限流（`DEFAULT_AUTH_FAILURE_LIMIT = 10`/60s）。 |
| coefficient | 从这步就带出「费率卡系数」，后面所有金额公式都要乘它。 |
| allowedModels | JWT scope 的模型白名单，下一阶段要校验。 |

管线入口处还有一道：`isModelAllowed(auth.allowedModels, model)` 不过 → **403**（`llm-pipeline.ts:91`）——防止拿到受限凭证却去调贵的模型越权计费（S3）。

---

## 4. 分图②：限流

> 代码：`apps/gateway/src/services/pipeline/rate-guards.ts`、`services/billing/rate-limit-service.ts`

```
              ┌────────────── 2a. RPM：请求数闸（一次原子判定）──────────────┐
              │ 维度 = global → user → key → app → model:<mappingId>          │
              │ Redis Lua 原子判定全部维度, 后维拒绝不污染前维窗口              │
              └──────────────────────────┬───────────────────────────────────┘
                                       超限 ──▶ 429 + Retry-After
                                       通过
                                        ▼
              ┌────────────── 2b. TPM：token 吞吐闸（原子预占）───────────────┐
              │ 预估总量 = 估算输入token + maxOutputTokens                     │
              │ reserveTpmAll: 所有维度要么全预占成功,要么一项不写               │
              └──────────────────────────┬───────────────────────────────────┘
                                       超限 ──▶ 429 + 释放预占 + Retry-After
                                       通过
                                        ▼
              ┌────────────── 2c. 免费模型日请求数闸 ─────────────────────────┐
              │ isFree 且配了 FREE_MODEL_DAILY_LIMIT:                        │
              │   计数器超限 ──▶ 429 (拒绝路径显式释放 TPM 预占)               │
              │   Redis 故障 ──▶ 503 fail-closed(免费链路唯一防线,绝不放水)     │
              └──────────────────────────┬───────────────────────────────────┘
                                        ▼
                                   进入 ③预扣
```

补充语义（`packages/ledger/src/settle.ts:303` `backfillTpm`）：

- 流式期间 `withBillingLifecycle` 每 `lease/3` 续 TPM 预占。
- 结算后按**真实 usage** 回填 `actual` 计数并释放预占——**预占与实际归属是两套维度**：
  预占 hash 里的每个维度都释放；实际用量只记到收据归属维度（成功 mapping/channel + user×成功 model + key/app），failover 试过即弃的渠道/模型不计入 actual，否则虚增未承接维度的消耗、误触发其限流。

| 步骤 | 一句话解释 |
|---|---|
| RPM 多维原子判定 | global/user/key/app/model 五个计数器一次 Lua 脚本判完，不会判了 user 又漏了 model。 |
| TPM 预占 | 按预估 token 先把窗口占住，防止并发请求合计超吞吐；失败请求会释放（TTL 600s 兜底）。 |
| 免费日限 fail-closed | 0 元授权绕过余额闸，所以请求数计数器是免费链路唯一防线——Redis 挂了宁可 503 也不放行。 |
| TPM 回填 | 结算时用真实 usage 替换预占估算，限流窗口最终反映真实消耗。 |

---

## 5. 分图③：预扣

### 5a. 先算「最多可能花多少钱」

```
┌────────────────── 预扣额计算公式（money/reservation.ts:18 estimateMaxCost）──────────────────┐
│                                                                                              │
│  保守输入单价 = max( inputPrice, cacheInputPrice )    ← 授权时无法预知缓存命中率,按贵的算       │
│                                                                                              │
│              ┌──────────────────────────────────────────────────────┐                       │
│  预扣额  =   │ 保守输入单价 × 输入token上界 + 输出价 × 输出token上界     │ ÷ 1,000,000          │
│  (每候选)    │                                                    │      × coefficient     │
│              └──────────────────────────────────────────────────────┘    (费率卡系数)          │
│                                                                                              │
│  预扣额(最终) = max( 主模型, fallback₁, fallback₂ … )  ← 整条候选链取最贵                     │
└──────────────────────────────────────────────────────────────────────────────────────────────┘

输入token上界 = max( 文本特征估算, 多模态媒体报价 )
  文本特征估算（ai/usage/token-estimate.ts，校准权重 2026-08 实测）:
      CJK字数×0.7 + 拉丁单词段×1.1 + 数字段×1.0 + 符号×1.0
      + tools 定义体 + 每个媒体part按85 token下限 + template偏移(DeepSeek≈70/MiniMax≈160)
  多模态报价 = billing_policy 里按图片数/分辨率等定的额外 token 折算
      （authorizeMultimodalQuote，渠道未配置策略时 422 拒绝）

输出token上界 = min( (max_completion_tokens ?? max_tokens ?? 4096) × n, 敞口上限CAP )
  （pipeline-shared.ts:114；embeddings = 0；CAP = GATEWAY_OUTPUT_EXPOSURE_CAP，
    防用户传 max_tokens=1e6 把在途敞口顶爆；超 CAP 部分由 credit_limit 透支缓冲兜底）

上游成本预估 = 同公式但 coefficient = 1（官方价口径）——给渠道「进货额度」闸用
```

### 5b. 四道闸门 + 落账单（`ledger/billing-flow.ts:326`，单 DB 事务）

```
 billing.authorize()
    │
    1. 积压准入: settlement_pending 太多/太老? ──是──▶ 拒新请求 (结算系统自我保护)
    │
    2. pg_advisory_xact_lock(user)        ← 按用户串行化授权,防 SUM 类限额并发突破 (F4)
    │
    3. 用户日限额: Σ已结算(usage_logs) + Σ在途(billing_requests) + 预扣额
    │              ≤ dailySpendLimit ?     ──否──▶ 402 (防羊毛党细水长流)
    │
    4. Key日限额(团队): 同口径按 apiKeyId 再算一道 ──否──▶ 402
    │
    5. 计费来源分流(读凭证绑定的 subscription_id,不信任前端传参):
    │    ├─ 订阅: quota − used − reserved ≥ 预扣额? ──否──▶ 402 套餐额度不足
    │    │         + 请求者须是 owner 或 org 活跃成员(防绑别人套餐)
    │    │         + 成员日限 a / 成员月子配额 b 两道独立闸
    │    └─ 余额: balance + credit_limit − reserved_balance ≥ 预扣额? ──否──▶ 402
    │
    6. INSERT billing_requests (status='authorized', reserved_amount=预扣额,
    │    quote=价格快照, 授权指纹, 租约)  ON CONFLICT DO NOTHING
    │    └─ 撞 requestId: 同指纹→幂等重放返回余额; 异指纹→409 冲突
    │
    7. 原子预占(条件UPDATE,守卫在WHERE里,不是先查后写):
    │    余额:  UPDATE users SET reserved_balance += 预扣额
    │           WHERE balance + credit_limit − reserved_balance ≥ 预扣额   ← 0行=余额不足
    │    套餐:  UPDATE user_subscriptions SET reserved_amount += 预扣额 WHERE 剩余≥预扣额
    │
    8. 免费链 fast-path: 全候选 isFree → 预扣额=0,不占余额不占日限额,只落账单行供观测
    ▼
 授权完成 → billing_requests 有一行 authorized + 钱被"冻结"(余额没动)
```

| 步骤 | 一句话解释 |
|---|---|
| 取最贵候选 | 主模型 ¥5、fallback ¥8 就冻 ¥8，防止降级到更贵模型后结算透支。 |
| advisory lock | 每日限额是 SUM 查询，READ COMMITTED 看不见并发未提交行，必须按用户串行。 |
| 落账单行 | `billing_requests` 就是「授权事实」，后面所有扣款/退款都以它为准。 |
| 条件 UPDATE | 余额守卫写进 WHERE，两个并发请求同时抢最后 1 块钱只有一个能成功（R4）。 |
| 免费链结构拒绝 | `calculateRequired` 里 explicitlyFree 但价格非零直接抛配置错误（R6：授权/结算两套口径不得矛盾）。 |
| 冻结≠扣款 | 全程只动 `reserved_balance`，`balance` 要等结算按真实用量扣。 |

---

## 6. 分图④：调上游

### 6a. 候选循环（`llm-pipeline.ts:290`）

```
┌─ 对每个 target(主模型→fallback模型), 对每个渠道(priority分层+weight加权随机) ─┐
│                                                                              │
│  1. 渠道级 RPM/TPM 限流 ──超限──▶ 换下一渠道                                  │
│  2. 渠道进货硬闸 reserveChannel(billing-flow.ts:692):                        │
│        upstreamBudget − upstreamReserved ≥ upstreamEstimate(官方价,系数=1)?  │
│        ──否──▶ 换下一渠道; 换渠道时原子"释放旧渠道敞口+预留新渠道"               │
│        同渠道 fallback 更贵时按差额补足敞口(F3),不足则拒绝换渠道                │
│  3. signal(upstream.started): 账单 authorized → in_flight + 起租约            │
│        租约 = max(配置租约, 请求deadline+10s) ← 非流式无续期,必须覆盖全程       │
│  4. 调 ai 包 ──┐                                                             │
│  5. 结果:      ├─ 成功 ──▶ ⑤落收据, 响应客户端                                │
│               ├─ 可换渠道错误(5xx/超时/熔断/死凭据) ──▶ 换下一渠道              │
│               │    └─ 死凭据(401/403特征) → 写回DB status=4 永久退出路由        │
│               └─ 不可换错误(4xx参数问题) ──▶ 直接透传错误给客户端+退款          │
│  6. 全部候选耗尽 ──▶ 503 no_available_channel + 退款(统一文案,不泄漏渠道拓扑)  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 6b. ai 包内部（`packages/ai/src/create-ai.ts`）

```
   1. 适配器解析: protocol → Adapter 注册表(默认 openai-compatible,注册即扩展)
   2. 参数抹平 normalizeRequest: 按 DB param_rules 执行 ignore→map→clamp→unknown:drop
        每次调整发 param_adjustment 事件可观测; 带 __proto__ 注入防护
   3. 准入: 熔断器开? / 死凭据? ──是──▶ 不发请求直接换渠道
   4. planRequest: 拼 URL(baseUrl尾段/v1去重, BUG-E) + Bearer认证
        + Idempotency-Key=requestId(C5: 同渠道重试防厂商重复生成)
   5. finalizeRequestBody: model 对外名→真实名重写
        流式强制注入 stream_options{include_usage:true,      ← 缺这开关MiniMax全程不报usage→漏计费
                                     continuous_usage_stats:true} ← 逐帧累计,取消时也有最新值
   6. withRetry 同渠道重试(仅首字节前,退避+抖动+整请求deadline预算)
   │
   ├─ 非流式: 收整个JSON → 200体里包错误也识别(#6643) → normalizeUsage 提取usage
   │            └─ usage 缺失 → estimateUsage 估算(estimated=true,只能诊断不能结算)
   │
   └─ 流式: peek首块(空流检测+首帧错误检测,未过首字节可安全重试)
        → relayStream 透传管道: chunk逐块转发不缓冲 + SseScanner旁路扫描usage/错误帧
        + 心跳保活 + 静默超时 + 客户端abort自动断上游
        → 流结束发 done{usage, bytesRelayed, terminated}
```

| 步骤 | 一句话解释 |
|---|---|
| weight 加权随机 | weight=9 的渠道拿约 9/10 首发流量，而不是「头部渠道吸干流量直到熔断」（`model-router.ts:30`）。 |
| 渠道进货闸 | 每个渠道像一张「充值卡」，转发前先原子占住上游成本敞口，没钱立刻不接单。 |
| Idempotency-Key | 同渠道重试时让厂商按 requestId 去重，防「响应丢了重发一次」成本翻倍。 |
| model 双向改写 | 出去时换成厂商认的真实名，回来时改回对外名（白标，`sse-model-rewrite.ts`）。 |
| include_usage 强制 | usage 是计费生命线，写死开启，不尊重用户传值。 |
| 首字节前才重试 | 字节已经流向客户端后再重试会造成重复输出，绝不重试。 |

---

## 7. 分图⑤：落收据

> 代码：`apps/gateway/src/services/pipeline/billing-recorder.ts`、`attempt-runner.ts`

```
上游返回终态
   │
   ├─【成功 + 可信usage(estimated=false)】──最常见──▶ recordSuccess
   │     1. 组装 durable receipt: 真实usage + 价格快照 + mappingId
   │        + billingPolicyFingerprint(策略哈希) + 渠道/凭证信息
   │     2. validateReceipt 验收(billing-flow.ts:241):
   │          userId 必须与账单一致 / usage 数值合理(cached≤input,整数非负)
   │          / 价格快照必须命中授权 quote 的某个候选(防中途改价算错账)
   │          / estimated 必须归属"用户取消"否则拒收
   │     3. billing_requests → settlement_pending, 收据+指纹落库
   │     4. BullMQ best-effort 唤醒 worker(失败仅记指标,DB轮询会捡到)
   │
   ├─【成功但 usage 缺失/是估算值】──▶ recordUncertain → status='uncertain'
   │     预扣冻结不退: 等厂商回执/人工复核/小额自动放行 (估算值绝不进资金结算)
   │
   ├─【用户主动取消(断开/中止)】──▶ recordEstimatedCancel(唯一允许估算结算的场景)
   │     ┌─────────────── 取消估算公式（usage-estimator.ts:49）─────────────┐
   │     │ outputTokens = min( round(已透传字节 × tokensPerByte), 输出上界 )   │
   │     │   tokensPerByte 按厂商校准(全局0.12, MiniMax-M3=0.03, 生产实测)     │
   │     │ inputTokens  = estimateInputTokens(body)  ← 与预扣同源              │
   │     │ cached       = 0   ← 2026-08拍板:防"改字破缓存+取消"套利            │
   │     └──────────────────────────────────────────────────────────────────┘
   │     然后走正常 recordSuccess 结算(receipt 带 estimatedFor 归因+bytesRelayed)
   │
   ├─【服务端发布中止(server_draining)】──▶ 全额释放(平台吸收发布成本,不估算不冻结)
   │
   └─【失败】──▶ request.failed 信号:
         upstreamCharge='none'(白名单:invalid_key/4xx/熔断…见 billing-recorder.ts:65)
           → released + 三类预扣(余额/套餐/渠道)全退
         upstreamCharge='unknown'(超时后挂,不知厂商有没有计费)
           → uncertain 冻结

时序保证(防"响应了却没记账"):
   非流式: 收据落库失败 → 503 billing_receipt_unavailable + 保留预扣(绝不误退款)
           (attempt-runner.ts:439: 上游已成功,必须保留 reservation,租约恢复链转 uncertain)
   流式:   withBillingLifecycle 包住 SSE ─ 每 lease/3 续账单租约+续TPM
           flush() 先 await 收据落库, 再让客户端看到 EOF
           (收据失败也照常 EOF: 内容已交付无法收回,预扣留 in_flight 由恢复链转 uncertain)
```

| 步骤 | 一句话解释 |
|---|---|
| 价格快照校验 | 收据的价格必须和授权时一模一样，管理员中途改价不影响在途账单。 |
| uncertain | 分不清该不该收就先冻着，宁可事后放行也不瞎扣或瞎退。 |
| 收据先于 EOF | 内容已经交付给用户了，账必须先落库——这是「正确性边界」。 |
| upstreamCharge 分类 | 确定厂商没收钱才退款；不确定就冻结，防止把已产生成本当失败退掉。 |
| 06 修复注记 | 收据校验不再用「字节数上界 vs 真实 token」判死——厂商会报隐藏 system/cached token，inputTokens 可远超字节数；真正的资损不变量是金额，由 settle 的信用地板兜底。 |

---

## 8. 分图⑥：结算实扣

> 代码：`packages/ledger/src/billing-processor.ts`、`settle.ts`、`apps/worker/src/worker-application.ts`

```
BullMQ 唤醒 / DB轮询扫到 settlement_pending
   │
   1. 认领: FOR UPDATE SKIP LOCKED 批量取 → status='processing'
   │    + claim_owner/claim_token/claim_until(租约) + revision+1   ← 多副本安全
   │    (处理中心跳续租; worker 崩溃 → claim 过期自动重回 retry_wait;
   │     优雅停机 → abandonOwnedClaims 归还全部认领)
   │
   2. settleClaim 单事务（settle.ts:25）:
   │    ┌─────────── 实扣公式（money/amount.ts:42 calcAmount, Decimal全精度不round）───┐
   │    │ cached   = min(cachedInputTokens, inputTokens)   ← 夹住防异常                │
   │    │ uncached = inputTokens − cached                                         │
   │    │ 实扣额 = ( inputPrice × uncached                                        │
   │    │          + cacheInputPrice × cached                                     │
   │    │          + outputPrice × outputTokens ) ÷ 1,000,000 × coefficient       │
   │    │ (负数/NaN/Infinity 全部 safe()→0; 永不返回负金额 — 反向收费防御)           │
   │    └──────────────────────────────────────────────────────────────────────────┘
   │
   │    3. 复验 claim(token/owner/revision/租约) ──输了──▶ claim_lost 幂等返回 already_settled
   │    4. 普通Key: 单条原子 UPDATE users
   │          SET reserved_balance −= 预扣额,      ← 解冻
   │              balance         −= 实扣额        ← 真扣! 按真实用量
   │          (DB约束 balance ≥ −credit_limit 兜底,触底23514→dead人工复核)
   │       包月Key: 释放套餐预占 → planCharge=min(实扣,剩余额度) → used += planCharge
   │          (ε 溢出理论不该发生,真发生→红灯 subscription_quota_exhausted_during_settle)
   │    5. 写 usage_logs(requestId 唯一,幂等) + transactions consume 流水
   │       (ref_type+ref_id 唯一,幂等,带 balanceBefore/After; 0元不写流水)
   │    6. 释放渠道进货敞口; 账单 → settled(再复验claim)
   │    7. 渠道进货真扣: upstreamBudget −= upstreamCost(官方价口径,系数=1)
   │       余额≤阈值 → 渠道熔断status=3 + 路由缓存bump立即生效
   │
   8. 失败分类重试(结构化判定,不做message文本启发式):
        40001/40P01 串行冲突、DB 瞬断 → retry_wait 指数退避(带抖动)
        毒收据/不变量破坏(23514等) → dead + 即时告警 (永不自动处置)

兜底循环(常驻, worker-application.ts):
   runSettlement(轮询):   有唤醒用唤醒,没唤醒扫 DB
   recoverOnce(默认30s):  authorized+租约过期+从未发上游→退款
                          in_flight+租约过期→uncertain
                          processing+claim过期→重排队
   autoRelease:           uncertain小额(≤阈值且滞留≥一个租约周期)
                          /超时(>N小时且≤上限) → 走 resolveUncertain 审计命令自动放行
   reconcile(周期):       advisory lock 单副本跑; balance=Σ流水? reserved=Σ活跃账单?
                          渠道敞口平? 容差1e-9, 不平→reconcile_discrepancies 落表+告警
```

---

## 9. 预扣 vs 实扣对照表

| | 预扣（授权时，gateway） | 实扣（结算时，worker） |
|---|---|---|
| token 数 | 估算：字符特征×权重 + 输出上限 | 真实：厂商返回的 usage |
| 输入单价 | max(inputPrice, cachePrice) 保守 | inputPrice / cachePrice 分开按量 |
| 输出 token | max_tokens（用户声明，封顶 CAP） | 厂商实际生成的 outputTokens |
| 落点 | `reserved_balance += 预扣额`（冻结） | `reserved_balance −= 预扣额` + `balance −= 实扣额`（真扣） |
| 精度 | 数量级正确即可 | Decimal 全精度，永不 round |
| 超预扣？ | — | 允许！实扣 > 预扣照扣，透支由 credit_limit + DB 约束兜底 |
| 退款 | 失败时原额退 | 无（已按事实扣） |

一句话收尾：**预扣回答「这个请求最多花多少钱、先冻住」，实扣回答「实际用了多少、按真实价格精确扣」——两阶段之间的所有中间态（uncertain/dead/retry_wait）都有明确的恢复出口，账本每一步可对账。**

---

## 10. 上游大模型厂商对接

### 10.1 数据模型（管理端配置 → 运行时路由）

| 表 | 职责 |
|---|---|
| `providers` | 厂商（baseUrl + protocol，protocol = ai 包适配器注册键）。 |
| `channels` | 渠道 = 厂商下的一个 API Key（AES 加密 `apiKeyEnc`，支持双 key 轮换窗口）+ 进货额度 `upstream_budget` + 渠道级限流。 |
| `model_mappings` | 对外模型名 → 真实模型名 + 三档价格（input/output/cache_input，元/百万 token）+ `param_rules` + `billing_policy` + fallback 链 + 是否免费。 |
| `model_channels` | 模型↔渠道多对多，带 `priority`（层间降序）和 `weight`（层内流量份额）。 |

路由缓存（`model-router.ts`）：Redis 版本计数失效（任何管理端写操作 bump `route:cache:v`）+ 5min TTL 兜底；渠道缓存只存密文 apiKey，读出后内存解密；Redis 不可用 fail-open 直查 DB。

### 10.2 协议适配层（注册即扩展）

`create-ai.ts:150` 适配器注册表：默认只注册 `OpenAICompatibleAdapter`，同键重复注册启动即抛（杜绝双真相）。新增厂商协议 = 实现 `planRequest / normalizeRequest / finalizeRequestBody / extractUsage / mapError / probeRequests` 六个方法注册即可，编排层零协议字面量。

`openai-compatible.ts` 一个适配器覆盖几乎所有主流厂商（OpenAI/DeepSeek/MiniMax 等兼容端点）：

1. **寻址**：`joinUrl` 处理 baseUrl 尾段版本去重（管理员填 `https://host/v1` 不会拼出 `/v1/v1/...`，BUG-E）。
2. **认证 + 幂等**：`Authorization: Bearer <key>` + `Idempotency-Key: requestId`（C5）。
3. **参数抹平**：按 DB `param_rules` 执行 `ignore → map → clamp → unknown:drop`，带原型键注入防护。
4. **model 双向改写**：请求方向换真实名；响应方向网关改回对外名（白标）。
5. **stream_options 强制注入**：`include_usage:true` + `continuous_usage_stats:true`（计费完整性优先于用户偏好）。
6. **usage 方言归一化**（`normalize.ts`）：兼容 OpenAI（`prompt_tokens_details.cached_tokens`）、DeepSeek（`prompt_cache_hit/miss_tokens`）、`input/output_tokens` 风格；自洽性破坏（input≠hit+miss、cached>input、total 对不上、双字段冲突）返回 null → 上层转 uncertain，不猜。

### 10.3 弹性与自愈

| 机制 | 说明 |
|---|---|
| 熔断器 | 按 `protocol://host` 维度，Redis 存储；流中止按原因分岔（`client_disconnect`/`server_draining` 不计渠道熔断，B6）。 |
| 死凭据追踪 | 401/403 特征计数达阈值 → 本实例停止路由 + 写回 DB `status=4` 永久退出路由。 |
| 重试 | 仅同渠道内、仅首字节前（流式）；指数退避 + 抖动 + 整请求 deadline 预算（fallback 拿剩余预算，绝不重置）。 |
| 流防御 | 首字节超时、空流检测（tee peek）、200+错误体识别（#6643）、首帧错误识别、心跳保活、静默超时。 |
| SSRF 防护 | `fetchUpstream` 带 `allowLocal/allowedHosts` 限制。 |
| 连通性探测 | `probe()` 走 `/v1/models`（GET 无副作用），死凭据错误优先返回。 |

---

## 11. 扣款正确性保障体系

### 11.1 不变量清单

1. **金额安全**：结算无条件按实际金额扣，`calculated > reserved` 不判死；透支由信用模型吸收，`balance ≥ −credit_limit` 是 DB check 约束（触底 23514 → dead 人工复核）（`settle.ts:83`）。
2. **价格口径锁死**：收据必须命中授权 quote 的 candidate（mappingId + 三档价格 + 系数 + billingPolicyFingerprint 全等），否则 `billing_receipt_not_authorized`。
3. **原子性**：条件 UPDATE 守卫内联 WHERE（余额/套餐/渠道三处），不是 check-then-act；SUM 类限额靠 `pg_advisory_xact_lock` 串行。
4. **幂等**：授权重放（requestId+授权指纹）、收据重放（receipt 指纹）、结算认领（claim_token+revision+租约）、usage_logs（requestId 唯一）、consume 流水（ref 唯一）、人工操作（operationId + fund_operations）。
5. **估算分界**：估算 usage 只允许出现在 TPM 预占、预扣敞口、用户侧取消归属结算（`isAttributedEstimate` 结构化判定）；其余进结算直接抛错。
6. **持久化时序**：「收据落库前不许 EOF」（流式 flush 等待）；「DB 收据提交即完成正确性边界，Redis 唤醒不得延迟成功响应」。
7. **故障语义**：`upstreamCharge: none|unknown` 白名单表决定退不退款——宁可冻结用户预扣，绝不把上游已计费的成本当失败退款。
8. **dead 永不自动处置**：不变量被打破 = 缺陷信号，必须人工。

### 11.2 降级矩阵

| 组件故障 | 行为 |
|---|---|
| BullMQ/队列 | DB 轮询兜底扫描 settlement_pending。 |
| Redis 全挂 | 路由缓存 fail-open 直查 DB；TPM/熔断降级；免费模型计数器 fail-closed（503）。 |
| Gateway 崩溃 | in_flight 租约过期 → recoverOnce 转 uncertain；authorized 未发上游 → 退款。 |
| Worker 崩溃 | claim 租约过期 → 重回 retry_wait；优雅停机归还认领。 |
| 结算积压 | 准入控制反向关闭新请求（`assertSettlementCapacity`）。 |
| 收据落库失败 | 非流式 503 + 保留预扣；流式照常 EOF + 恢复链转 uncertain。 |

### 11.3 对账兜底

`reconcile.ts`（周期、advisory lock 单副本）：用户级 `balance = Σ资金流水`、`reserved_balance = Σ活跃账单余额部分`（套餐分流后口径）、渠道在途一致性；容差 1e-9；不平写 `reconcile_discrepancies` + 告警——即使上述所有机制都有 bug，对账是最后发现资损的哨兵。

### 11.4 观测

- OTel 全链路：请求 trace 经 `trace_parent` 贯穿 gateway → worker 结算 span（`settle-telemetry.ts`）。
- 显式收尾节点：每条链路必有 `billing.finalize`（succeeded/uncertain/estimate/failed）。
- 深健康报告：积压/dead/uncertain 清单 + lastError，令牌保护（G2）。
- 指标：`billing_wakeup_failed`、渠道失败/请求计数、settle telemetry。

---

## 12. 边界与取舍

1. **预扣估算可偏小**是刻意接受的敞口（换资金占用）。若某用户 credit_limit=0 且估算偏小，结算触底会 23514 → dead 复核而非正常结算——**信用为零的用户遇到「估算偏小 + 实际用量大」会进 dead**，建议监控 dead 率。
2. `ESTIMATED_INPUT_CACHE_SHARE = 0`（取消估算一律全价）是防套利拍板，对高缓存诚实用户略不友好——代码留了政策开关与切换条件说明（`usage-estimator.ts:37`）。
3. `tokensPerByte` 校准目前只有全局 0.12 + MiniMax-M3 一个模型级覆盖（0.03），新厂商初期取消结算精度依赖 defaults，建议按 `scripts/token-estimate-accuracy.mts` 持续补模型级校准。
4. 非流式收据失败返回 503 会诱导客户端重试（新 requestId 重新计费），响应文案已明确「请勿立即重试」，但 SDK 自动重试策略是否遵守值得在客户端文档强调。

---

## 13. 附录：状态机

```
                    ┌────────────┐
        authorize   │ authorized │ 租约过期+从未发上游 ──recoverOnce──▶ released(退款)
          ────────▶ │  (预扣落账) │
                    └─────┬──────┘
                          │ upstream.started
                          ▼
                    ┌────────────┐
                    │  in_flight │ 租约过期 ──recoverOnce──▶ uncertain
                    │ (流式期间  │
                    │  持续续租) │──上游成功+可信usage──▶ settlement_pending ──worker──▶ settled
                    └─────┬──────┘                              │
                          │                                    └ 失败: retry_wait ⇄ processing
                          ├──上游失败(确定没计费)──▶ released(退款)      └ 永久失败 → dead ──人工──▶ retry_wait / released
                          ├──上游失败(不确定)──────▶ uncertain
                          └──缺可信usage──────────▶ uncertain
                                                    │
                              小额/超时自动放行(审计) ├──▶ released
                              厂商回执补录(人工)     ├──▶ settlement_pending
                              人工确认不收费         └──▶ released
```

---

## 14. 附录：文件索引

| 模块 | 文件 | 职责 |
|---|---|---|
| gateway | `apps/gateway/src/services/pipeline/llm-pipeline.ts` | 管线编排器：准入→限流→授权→候选循环 |
| gateway | `apps/gateway/src/services/pipeline/attempt-runner.ts` | 单渠道尝试：流式/非流式 + 终态分岔 |
| gateway | `apps/gateway/src/services/pipeline/billing-recorder.ts` | 收据组装 + 三条收尾产线 + SSE 生命周期包装 |
| gateway | `apps/gateway/src/services/pipeline/pipeline-shared.ts` | 管线契约 + maxOutputTokens 口径 |
| gateway | `apps/gateway/src/services/pipeline/usage-estimator.ts` | 用户取消估算公式（tokensPerByte） |
| gateway | `apps/gateway/src/services/pipeline/authorize-rejection.ts` | 授权拒绝翻译表 |
| gateway | `apps/gateway/src/services/routing/model-router.ts` | 模型/渠道路由 + 版本计数缓存 + 加权调度 |
| gateway | `apps/gateway/src/services/billing/billing-dispatcher.ts` | BullMQ 结算唤醒（只带 requestId） |
| gateway | `apps/gateway/src/services/auth/auth-service.ts` | 双凭证鉴权 + 爆破防护 + 费率系数 |
| ai | `packages/ai/src/create-ai.ts` | 组装：适配器 + 重试 + 熔断 + 事件 |
| ai | `packages/ai/src/adapters/openai-compatible.ts` | 默认协议适配器（寻址/抹平/终改/计量） |
| ai | `packages/ai/src/transport/relay-stream.ts` | 流透传管道 + SseScanner + 心跳/超时 |
| ai | `packages/ai/src/usage/normalize.ts` | 厂商 usage 方言归一化 |
| ai | `packages/ai/src/usage/token-estimate.ts` | 字符特征 token 估算 |
| ai | `packages/ai/src/usage/calibration.ts` | 估算校准配置（权重/偏移/tokensPerByte） |
| ledger | `packages/ledger/src/billing-flow.ts` | authorize / reserveChannel / signal 状态机 |
| ledger | `packages/ledger/src/settle.ts` | settleClaim 实扣事务 + TPM 回填 |
| ledger | `packages/ledger/src/billing-processor.ts` | 认领/重试/恢复/库存（多副本安全） |
| ledger | `packages/ledger/src/billing-operations.ts` | 人工复核命令（幂等 + 审计） |
| ledger | `packages/ledger/src/auto-release.ts` | uncertain 小额/超时自动放行 |
| ledger | `packages/ledger/src/reconcile.ts` | 对账作业 |
| money | `packages/money/src/reservation.ts` | estimateMaxCost / requiredReservation |
| money | `packages/money/src/amount.ts` | calcAmount 实扣公式（全精度） |
| worker | `apps/worker/src/worker-application.ts` | 结算/恢复/对账/分区维护编排 + 健康门面 |
