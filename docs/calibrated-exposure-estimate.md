# 收据校准的双口径预估方案（calibrated exposure estimate）

状态：**已实施（代码全量合入 feat/calibrated-exposure-estimate；四轮对抗审查
41 项全部处置：方案轮 34 + 实现轮 P1-P14 + 复审收口）**

级别：大（借件——交付物是新能力叠加在既有计费不变量基线上，非行为等价重构；
借迁移方法论的文档结构，流程按 feature-dev-v2 走）

修订记录：
- v5（2026-10-12）：实现轮对抗审查 14 项处置——P1 conservative 换渠清列 /
  P2 user_side 真实门控（盖章恒随 enabled、billing quote 透传门）/ P3 写侧
  解耦 enabled / P4 指纹排除候选校准界 / P5 store 自持 db / P6 批量信号 /
  P7 mappingId 记实际 / P8 prefixBytes 含 system+tools / P9 no_cache_price /
  P10 写入事务外 / P11 F1 收敛与精确化 / P12 e2e 闭式补强 / P13 reason 标签
  （admin UI 与 waived 日聚合**降级**为后续工单——§12 调整）/ P14 常量单源。
- v4（2026-10-12）：资金安全审查处置——**安全性/经济性分离重构**（B2 钳制
  与死信阈值只消费字节界/保守金额，校准界永不进入安全消费面——I1 从安全
  定理降级为经济启发式，P1/P1a 家族结构性消除）；写入守卫 C7（零钳制收据 +
  seen 字节下限合理性，P2）；残留段价格含写价（P3）；#over 并发败者修复
  F1（P4）；waived 累计监控 D15（P5）；B4 判定改为 reserve 时持久化的
  conservative_channel_amount 列（同轴同时刻，P6/P7）；对账断言按轴拆分（P8）。
- v3（2026-10-12）：并发审查处置——双界方案、B4 二级上界、指纹排除
  calibration、快照 cacheRatio、窗口锚点、回滚排空、tailCost 含写价。
- v2（2026-10-12）：规格盲区审查处置——非聊天端点守卫、多模态内容哈希、
  逐候选/逐渠道语义、归属 inference、KV 契约/ACL、指标改名、部署硬门、
  e2e 闭式断言、FK/清理/回滚细节。

## 1. 背景与问题

生产实测（2026-10-11，channel 8）：长上下文请求预估敞口 3.25 元，实际结算
0.025 元，**130 倍保守**。根因是 `estimateMaxCost`
（`packages/billing/src/domain/rating/pricing.ts:95`）双层保守叠加：

1. token 数取 JSON 字节上界（`conservativeInputTokenUpperBound`）；
2. 价格取 max(输入价, 缓存读价, 缓存写价)，对 97% 缓存命中的负载仍按全价输入计。

后果：渠道侧在途敞口虚占预算，并发即 `channel_budget_exhausted` 503；用户侧
被迫 `fixed 0.01`（等于无闸），已产生 -308 元垫底钱包。

## 2. 核心机制

结算成功时，把「本请求已见的 prompt 前缀 + 实测 usage」写成**校准记录**；
下一笔请求若匹配，用校准记录收缩**预估**（经济性），否则回落保守口径。

### 2.0 安全性/经济性分离（v4 核心原则）

预估的**全部消费方分两类**，校准只作用于第二类：

| 类 | 消费面 | 界/金额来源 | 校准参与 |
| --- | --- | --- | --- |
| **安全性**（错误防御/审计/死信） | B2 验收钳制、usageEvidenceDefects 熔断、B4 死信判定、每日限额 | 字节界 / conservative_channel_amount | **永不** |
| **经济性**（预估/冻结/敞口） | authorize 冻结额、reserveChannel 敞口、reservation_limit | 字节界 或 校准界（按 §2.3 规则） | 是 |

理由（资金审查 P1/P1a）：`seen` 是厂商计数器上一轮读数，不是内容到 token 的
确定函数——计数口径轮间不一致（如中转命中轮不含 cached）、计数抖动、
tokenizer 差异都可构造诚实流量反例。任何把校准界放进安全消费面的设计，
都会让计数漂移变成「诚实上游被钳制 → 缺陷计数 → 健康渠道熔断」。

**不变量 I0（安全分离，结构保证）**：B2 钳制上限 = 候选字节界（与现状逐字节
一致）；B4 死信上界 = conservative_channel_amount（§3.2c，reserve 时持久化的
保守金额）。校准**在任何输入下**都不能导致钳制事实、缺陷计数、死信——
校准预估偏低的代价被限制为「一笔超额事件」（§4.2 有界路径），仅此而已。

**不变量 I1'（经济性，启发式非定理）**：计数器确定性且口径一致时
`calibratedBound ≥ 真实 inputTokens`（同渠道同 mapping 同内容 ⇒ 同 tokenizer
⇒ 前缀 token = seen；尾部 ≤ 字节界）。违反条件（口径漂移/抖动）由写入守卫
（§2.2 C7）拦截大部分，残余违反的代价 = 一笔 calibration_over_exposure 事件
（金额有界于 §4.2 二级上界内），**无钳制、无缺陷计数、无熔断**。

### 2.1 前缀哈希（消息哈希链）

- **逐消息哈希**：`h_i = sha256(canonical_json(messages[i]))`；
  `h_sys = sha256(canonical_json({system, tools}))`。canonical JSON 按
  字段名排序、UTF-8、无空白。**多模态 part 按完整规范化 JSON 参与哈希
  （含 url/base64 内容），不做长度占位**（同哈希 ⇔ 同内容 ⇒ 厂商对同内容
  计数确定；body 全量缓冲，一遍哈希无增量成本）。
- **链式前缀哈希**：`chain(k) = sha256(h_sys || h_0 || … || h_{k-1})`。
  存储 `prefixHash = chain(messagesLen)`。
- **匹配语义（只追加）**：下一笔对本请求消息哈希序列一次线性递推，算出
  各记录 `messages_len` 处的 chain 值比对（O(messages) 一遍；禁止
  N×全量重哈希）。system/tools 变化 → 全部 chain 变 → 不匹配。服务端计算。

### 2.2 匹配与写入条件

**读侧匹配（全部满足才打折）**：

| # | 条件 | 防的攻击/误判 |
| --- | --- | --- |
| C1 | 同 userId + 同 mappingId | 跨用户/跨映射污染 |
| C2 | chain(记录.messages_len) == 记录.prefixHash（只追加） | 改写历史 |
| C3 | 目标渠道 channelId == 记录 channel（金额消费点判定；授权时刻未知渠道 → 用户侧 token 界按渠道未知规则，见 §2.3） | 换渠道冷缓存 + tokenizer 漂移 |
| C4 | quote-prep 时刻 − settled_at ≤ window_ms − margin（margin=30s 结构常量） | 缓存 TTL 过期 + 等待期放大 |
| C5 | 记录源自 `estimated === false` 收据 | 估算收据无真实数据 |
| C6 | §2.0' 适用域守卫：chat 族且 messages 非空（读写双侧） | 非聊天端点空哈希碰撞（sticky.ts:17 先例） |

**写侧守卫（C7，v4-P2）**——结算写记录前全部通过：

| # | 条件 | 防的污染 |
| --- | --- | --- |
| C7a | 收据**零钳制事实**（acceptTrustedUsage 后 clamps 为空） | 被钳收据的计数器不可信，不得成链路锚点 |
| C7b | `seen ≥ prefixBytes / 4`（前缀 JSON 字节下限；文本 bytes/token ≤ 4 恒成立，媒体段只增不减） | 低报计数器（prompt_tokens:0 / Anthropic 式口径排除 cached / 命中轮口径漂移）—— seen 低于物理下限即拒绝写入 |
| C7c | seen、messagesLen、各 id 为有限正整数 | 结构垃圾 |

### 2.3 双界与打折口径

quote 候选携带**两个** token 上界：

- `inputTokenUpperBound`：现行字节界，**语义与全部现有消费方不变**；
- `calibratedInputTokenUpperBound`（可选）：= seen + tailTok（tailTok =
  新增尾部消息字节界）。仅命中候选携带。

**消费规则（按消费面，v4 表）**：

| 消费面 | 用哪个界 | 条件 |
| --- | --- | --- |
| B2 验收钳制 / 缺陷计数 | 字节界（不变） | 永远 |
| B4 死信二级上界 | conservative_channel_amount（§3.2c） | 永远 |
| 用户侧冻结额（user_side=true） | 校准界（命中候选）；否则字节界 | authorize 时刻渠道未知——用户侧消费校准界**不区分渠道**，tokenizer 漂移风险由「B2 不用校准界」兜底（错估只影响冻结额 → #over 路径，无钳制/死信） |
| 渠道侧敞口金额 | 渠道匹配（reserve 时 channel == 记录 channel）才用校准口径分段；否则保守 | tokenizer + 冷缓存双保险 |
| reservation_limit / 每日限额 | 消费上述预估结果 | 逻辑不变 |

**渠道侧金额分段**（仅渠道匹配时）：

```
cacheSegTok = floor(seen × cache_ratio)              # 动态配置，缺省 0.9
cacheSegCost = cacheSegTok × max(缓存读价, 缓存写价)
restTok      = (seen + tailTok) − cacheSegTok        # 残留 10% + 尾部
restCost     = restTok × max(输入价, 缓存写价)       # v4-P3：残留段同样含写价
金额 = cacheSegCost + restCost + 输出价 × 输出上限
```

（无缓存写价配置时 max = 输入价，退化为 v3 口径；增量缓存把 cache_control
打在尾部时每轮尾部发生写计费，残留段同理，两段都必须覆盖写价——对照现行
`estimateMaxCost` 对全部输入取 max(输入,读,写) 的覆盖面，校准公式不得倒退。）

**快照纪律（v3-R5）**：`cacheRatio` 生效值随 quote 快照（§3.2）；授权/预留/
结算三处消费同一值；TTL 漂移只影响各自新请求。

### 2.4 候选链语义

- 每候选独立解析校准（键含 mappingId）；mappingId 匹配且 C1-C6 通过的候选
  得校准界，其余保字节界。金额/冻结取链上 max——与 `calculateRequired`
  语义一致（`calculate.ts:45-73`）。无位置敏感分支。
- 结算写记录记**实际服务的 mappingId/channelId**（fallback 发生时记
  fallback 的）。

## 3. 契约

### 3.1 新表 `prefix_calibrations`（migration 0113）

```sql
create table prefix_calibrations (
  user_id      bigint not null references users(id) on delete cascade,
  mapping_id   bigint not null,
  prefix_hash  text not null,
  channel_id   bigint not null,
  input_tokens bigint not null,
  messages_len integer not null,
  request_id   uuid not null,
  settled_at   timestamptz not null,
  created_at   timestamptz not null default now(),
  primary key (user_id, mapping_id, prefix_hash)
);
create index prefix_calibrations_recent_idx
  on prefix_calibrations (user_id, mapping_id, settled_at desc);
```

- FK 裁决：仅 user_id 带外键；mapping/channel 是历史事实，软删除不毁约，
  不带 FK（有意裁决 D10）。mapping 软删路径同事务清理其校准行。
- 写入：结算事务**末尾**（wallet/channel 腿之后——v3-R4 消除跨表加锁序死锁）
  upsert 单行，ON CONFLICT DO UPDATE。
- 保留：每 (user_id, mapping_id) 最近 N 条（缺省 8）；清理**移出结算事务**
  （worker 批提交后 best-effort，幂等 DELETE，失败只打日志）。
- 回滚 SQL：`drop table prefix_calibrations` + KV 清理；migration 双向。

### 3.2 billing_requests 扩展

**a) quote jsonb 可选子对象**（授权快照）：

```jsonc
{
  "calibration": {
    "mappingId": 13, "prefixHash": "…", "inputTokens": 50593,
    "channelId": 8, "cacheRatio": 0.9
  }
}
```

- **指纹排除**：calibration 子对象不参与 authorize fingerprint 载荷
  （v3-R3：inputTokens 时变，进指纹使同 requestId 重放随并发结算漂移）。
- failover 整轮重跑不重新 authorize，快照不漂移。

**b) 校准界进 quote 候选**：候选携带可选 `calibratedInputTokenUpperBound`
（用户侧消费；B2 侧的 boundsOf 逻辑**不读它**——I0）。

**c) 新列 `conservative_channel_amount`（numeric(38,18) nullable，
migration 0113 同批）**：reserve 时由 gateway 与校准金额**同调用、同价格
快照、字节界口径**算出，经 `casClaimChannel` 与 `channel_reserved_amount`
同语句维护（换渠重写）。NULL = 未按校准预留（B4 走原路径）。

- 这是 B4 二级上界的**唯一判定与数值来源**：同轴（渠道成本价）、同时刻
  （reserve 时快照）——价格漂移（reserve 后调价）会被它抓住：upstreamCost
  超 reserve 时点的保守金额 → 死信，与现行 B4 检测目标严格一致（v4-P6/P7：
  不得用结算时 receipt 价格现算——那会把漂移一并抬升，探测器失明）。

### 3.3 动态配置（system_configs KV `billing_calibration`）

```ts
z.object({
  enabled: z.boolean(),                                  // 缺省 false
  window_ms: z.number().int().positive().max(3_600_000), // 缺省 300000
  cache_ratio: z.number().gt(0).lte(1),                  // 缺省 0.9（P8：值域锁死）
  user_side: z.boolean(),                                // 缺省 false
}).superRefine(enabled=false 时拒 user_side=true)
```

- PUT 整替换；admin settings API + 审计动作 `settings.billing_calibration`；
  ACL：endpoint_permissions migration（0097/0099 模式）。
- gateway 读取：`adapters/reservation-policy.ts` 同款 TTL reader 语义
  （DB 错 fail-loud / 值异常回落保守 + warn）；TTL = 新 config 键
  `calibrationTtlMs`（config.ts + .env.example + 配置测试）。
- admin 前端 settings 面校准卡。
- **写侧不受 enabled 门控**（结算写记录无条件；enabled 只控读侧——避免
  打开时冷启动零命中）。

### 3.4 观测

- span 属性（授权时）：`calibration.hit`、`calibration.seen`、
  `calibration.authz_miss_reason`（guard|prefix|channel|window|no_record|
  disabled|no_cache_price）。
- 计数器（结算时）：`calibration_over_exposure{reason=
  channel_switch|cache_ttl|calibration_gap}`（授权命中校准、结算时实际成本
  超**校准预留**但 ≤ 保守金额的事件）。
- 计数器（授权时）：`calibration_hit`。
- 死信家族（超保守金额，无论校准与否）不打 calibration_*（口径隔离）。
- **waived 监控（v4-P5/D15）**：waived_amount 为累计无界平台补贴——按
  user/day 聚合告警（阈值 admin 可配，缺省观察模式）；§9 步骤 3 的
  go/no-go 显式包含「waived 日增量趋零」。

## 4. 消费方改动

### 4.1 渠道侧金额（gateway `channelCostAmount`）

候选 costPrices 存在、mappingId 匹配、且 reserve 时 channel == 记录
channel → 按 §2.3 分段 + 同时算出 conservative_channel_amount 一并传入；
任一不满足 → 金额 = 保守口径，conservative_channel_amount = NULL。
costPrices 缺失仍 '0' 口径（现行）。

### 4.2 渠道侧 B4 分支（billing settlement）

```
if (upstreamCost > channelReservedAmount) {
  if (conservative_channel_amount is NULL) {
    → 死信（现行 B4 原样——非校准请求，红灯不动）。
  } else if (upstreamCost > conservative_channel_amount) {
    → 死信（二级上界：reserve 时点的保守口径都超了 = 价格漂移/投影脱节/
      上游虚高，B4 原检测目标，红灯不动）。
  } else {
    → 超额扣减：deductBudgetAndMaybeBreak 按实际 upstreamCost 扣（渠道余额
      可为负），计 calibration_over_exposure{reason}，不死信。
  }
}
```

- 容错区间精确 = `(校准预留, reserve 时保守金额]`；超出任何一端都是红灯。
- 敞口归还按 `channelReservedAmount` 原样释放，实际成本走
  deductBudgetAndMaybeBreak——两路径分离（机械记账经审查核实对平，无双扣
  无泄漏）。

### 4.3 用户侧（authorize 冻结额）+ #over 修复（F1）

- user_side=true 时冻结额消费校准界（§2.3 表）；超冻结走既有 `#over`
  补充授权，钳 `可用 + debit_floor`，超出 waived。
- **F1（v4-P4，随本方案修复的存量缺陷）**：`#over` 并发败者路径——
  `wallet.authorize` 的 `collectOverage` 守卫失败时抛
  `DefectError('authorize.gate_unclassified')`（`authorize.ts:158-171`）→
  死信家族 → 用户全免 + 渠道不扣 + 上游真金已付。同用户并发结算同时超
  冻结时 `overCollectCeiling` 的无锁读使败者可期。修复：`payg-source.ts`
  的 over 分支捕获守卫失败后**重读天花板、钳到新值、余额 waived**（重试
  一次，不抛 DefectError）；配套回归测试（并发双 over 场景断言零死信）。
  校准使 over 从偶发变常态，此修复是本方案的前置依赖而非顺手。

### 4.4 收据验收（零改动）

B2 与缺陷计数只消费字节界——与现状逐字节一致。校准界不进入
usage-acceptance 的任何路径（I0）。诚实流量零新增钳制/缺陷/熔断，
**由构造保证而非由 I1 成立性保证**（v4 与 v3 的本质区别）。

## 5. 问题域

**处理**：写校准记录（C7 守卫 + 事务末尾 upsert）；读校准 + 哈希链匹配 +
双口径预估；渠道侧金额分段 + conservative_channel_amount 持久化 + B4 分支
+ reason 标签；用户侧校准界消费；F1 #over 败者修复；动态配置 + ACL + UI +
观测 + waived 监控。

**不处理（归属）**：
- 非聊天端点（embeddings/images/audio/generation/multipart）：§2.0' 守卫
  结构性排除（读写双侧），不依赖「自然回落」；
- cacheWriteTokens 独立资金工单：既有归属；预估侧 max(读,写) 全段覆盖
  （v4 后含残留段），不动结算计价；
- 上游谎报 usage：既有 B2 字节界钳制 + 缺陷熔断（口径不变）；
- **URL 引用媒体的字节界低估**（~100B URL vs ~1000+ token）：存量缺陷，
  字节界口径对 referenced media 本就不完备（`output-cap.ts:83-89`），
  与本方案无关，**登记挂账**（见 §13 已知遗留）；
- 多模态变体（同图不同编码/URL）：内容哈希 miss 回落（安全方向损失）；
- reservation_limit / 每日限额：消费预估结果，逻辑不变；
- 渠道预算告警/充值运营：另行。

## 6. 并发/一致性预算

- **校准读**：(user, mapping) top-N（N=8）索引点查 + 内存过滤；每请求
  O(messages) 哈希链递推；P95 < 2ms；读到旧/空记录均安全（回落）。
- **窗口锚点**：C4 锚 quote-prep 减 30s margin（v3-R7）。
- **校准写**：结算事务末尾 upsert（v3-R4）；清理移出事务批后 best-effort。
- **读写竞态**：写晚于读 = 回落（错过打折非资损）；同请求并发 upsert =
  后写覆盖（无累积语义）。
- **哈希链**：一遍线性；>4MB 走既有拒载。
- **多副本 TTL 漂移**：cacheRatio 已快照进 quote（v3-R5）；副本间差异只
  影响各自新请求。
- **#over 并发**：F1 修复后败者钳新天花板 waived，零死信（§11 并发测试）。

## 7. 拆分与依赖方向

归属原则：校准判定（C1-C7）、哈希链、双口径公式全部归 **inference**；
billing 零新增核心计价逻辑（B4 分支、store、conservative_channel_amount
维护）；inference **零 billing import**（architecture 白名单不破）。

| 层 | 位置 | 内容 |
| --- | --- | --- |
| db | `schema/prefix-calibrations.ts` + migration 0113（含 billing_requests 新列 + down） | 表/列定义 |
| billing adapters | `adapters/postgres/calibration-store.ts`、billing-store casClaimChannel 扩展 | upsert/findRecent/cleanup；双金额列维护 |
| billing 装配 | `billing.ts` / `composition.ts` / settlement env | store 注入、B4 分支、结算 upsert |
| billing facade | `index.ts` 导出面 + composition 子入口 | findRecent 读 API |
| billing application | `funding/payg-source.ts` | F1 over 败者钳制修复 |
| inference | `application/calibration.ts` + `ports/calibration.ts` + quote.ts 扩展 | 守卫、哈希链、C1-C7、双口径公式、候选盖章 |
| gateway | `adapters/calibration-port.ts`、`billing-port.ts`、`calibration-policy.ts`、`assembly.ts`、`config.ts` | port 装配、双金额产出与传入、KV reader、TTL 键 |
| worker | settlement 批后清理调用 | best-effort retention |
| admin-api | settings contracts/routes/openapi + ACL migration | KV 面 + 审计 |
| admin 前端 | settings 面校准卡 | UI |

架构契约测试同步：inference 导出面快照、billing 分层门禁，新增导出/依赖
处在对应阶段同批更新。

依赖方向：db ← billing ←（gateway 装配桥接）→ inference ← gateway；无新环。

## 8. 实施顺序（每阶段独立提交、四门全绿）

| 阶段 | 内容 | 验收点 |
| --- | --- | --- |
| P1 | db schema + migration（双向）+ calibration-store + inference 校准纯函数（含 C7 守卫） | 表/函数契约绿；C1-C7 × 公式表驱动；prefixBytes/4 下限边界 |
| P2 | quote 哈希链 + 双界盖章 + quote.calibration 快照 + fp 排除 | 哈希稳定性矩阵；回归锚（回落=逐字段保守）；fp 排除断言 |
| P3 | gateway 装配（port + KV reader + config 键 + 双金额产出） | 分段/保守双金额闭式；KV 缺省方向；fail-loud/回落语义 |
| P4 | settlement B4 三分支 + casClaimChannel 双列 + 结算 upsert + reason 标签 + worker 清理 | 三分支表驱动；敞口归还；对账（按轴拆分） |
| P5 | user_side 消费 + F1 #over 修复 + admin settings（contract/ACL/UI/审计） | 开关矩阵；superRefine；F1 并发回归（零死信） |
| P6 | 观测 + waived 监控 + e2e 三旅程 | 指标断言；e2e 闭式断言 |

**部署硬门**：P4 部署前 KV 缺失或 false（P3-P4 窗口误开 = 校准预留 +
旧 B4 = 生产死信事故）；**§9 放量始于 P6 部署后**。

过渡态：P1-P6 enabled=false 部署（现状逐字节等价）。收口单轨：enabled 只控
校准参与，关闭即完全回落，无双轨字段。

## 9. 上线顺序（用户裁决 D1：一次到位，配置分步切；始于 P6 部署后）

1. 全量代码上线，enabled=false（现状等价）。
2. 开渠道侧（enabled=true, user_side=false）：观察 calibration_hit、
   calibration_over_exposure（reason 分布）一天。**中止条件**：
   over_exposure 占比 > 20% 或 reason=calibration_gap 主导（C7 守卫不足，
   回退调 cache_ratio 或关停）。
3. 开用户侧（user_side=true）：观察 waived 日增量（**go/no-go：趋零/可解释**）、
   负余额深度、#over 事件率。
4. `billing_reservation_policy` 切 `full`，fixed 0.01 下线。
5. 回滚阶梯（顺序不可颠倒）：改 KV（秒级）→ 排空在途（≤ lease 5 分钟）→
   revert + migration down。直接 revert 会让旧 settle 消费已授权校准 quote。

## 10. 裁决落档

| # | 裁决 | 来源 |
| --- | --- | --- |
| D1 | 一次到位，配置分步启用 | 用户裁决（2026-10-11） |
| D2 | debit_floor 零改动 | 用户裁决（2026-10-11） |
| D3 | fallback 候选不特殊化，链上取 max | 用户裁决（2026-10-11） |
| D4 | 按价格轴自动判定适用性，不加白名单 | 用户裁决（2026-10-11） |
| D5 | B4 红灯保留 | 用户裁决（2026-10-11） |
| D6 | 运营参数全走 system_configs，零硬编码业务值 | 用户裁决（2026-10-11） |
| D7 | 前缀哈希绑定；分段授权不做 | 用户裁决（2026-10-11） |
| D8 | 用户侧只消费校准 token 界（保守 max 价） | 方案裁决 v2 |
| D9 | 校准逻辑归属 inference | 方案裁决 v2（架构门禁） |
| D10 | 仅 user_id 带 FK；mapping 软删同事务清理 | 方案裁决 v2 |
| D11 | 适用域守卫为结构性代码，不设开关 | 方案裁决 v2 |
| D12 | 双界 + 渠道匹配消费 + 指纹排除 calibration | 方案裁决 v3 |
| D13 | B4 二级上界 = conservative_channel_amount（reserve 时同轴快照） | 方案裁决 v4（细化 v3-D13 的数值来源） |
| D14 | cacheRatio 快照；C4 锚减 margin；残留+尾部均含写价 | 方案裁决 v4 |
| D15 | waived 累计无界为已知接受项，监控+告警+go/no-go 门 | 方案裁决 v4（P5 处置；硬限额需新状态机，不做） |
| D16 | I0 安全/经济分离：B2 与死信阈值永不消费校准界（结构性，非配置） | 方案裁决 v4（P1/P1a 处置；本方案最重要的一条） |
| D17 | F1（#over 并发败者死信）随本方案修复 | 方案裁决 v4（P4 处置：over 是本方案设计的常态路径，前置依赖） |

## 11. 测试口径（先于实现定稿）

### 契约级
- quote jsonb calibration：命中五字段齐全（含 cacheRatio）；未命中字段缺失。
- billing_requests.conservative_channel_amount：校准预留时非空且 = 闭式
  保守金额；非校准预留为 NULL；换渠（casClaimChannel）随 channel_reserved_amount
  同步重写。
- KV zod：值域/superRefine/整替换/解析失败回落缺省 + warn。
- upsert 幂等；migration up/down 双向。

### 边界与异常
- §2.0' 守卫矩阵（embeddings/images/audio/空 messages）。
- C7 守卫矩阵：钳制收据不写；seen < prefixBytes/4 不写（构造 0/极小值/
  口径排除型收据）；结构垃圾不写。
- messages 收缩/system 变/tools 变/早期改写/超窗（含 margin 边界）/换渠道/
  换映射 → 回落。
- estimated=true 不写；免费链不查；>4MB 拒载。
- cache_ratio 1.0/0.5 极值：公式单调、无除零、无负段（值域 ≤1 由 zod 锁）。
- **回归锚**：所有回落路径金额与 token 界逐字段等于现行保守口径。
- fp 排除：同 requestId 重放（quote.calibration 存在）→ 幂等重放不
  state_conflict。

### 资金安全（重点）
- **I0 分离断言**：构造 seen 低报/口径漂移场景（校准界 < 真实 input）→
  B2 钳制仍按字节界（零新增钳制事实、零缺陷计数）；金额走 over_exposure
  或保守预留路径；**无任何路径因校准产生死信**（除 §4.2 二级上界，其
  触发条件与现行 B4 同口径）。
- B4 三分支表驱动：NULL → 原死信；(校准预留, 保守金额] → 超额扣减 + 指标；
  > 保守金额 → 死信。价格漂移（reserve 后调价）场景 → 死信（探测器）。
- 敞口归还 = channelReservedAmount；渠道借方总额 = Σ实际成本（机械对账）。
- 用户侧超冻结：#over 钳 debit_floor，waived_amount 落账。
- **F1 并发回归**：同用户两笔并发 over（一胜一败）→ 败者钳新天花板 waived，
  **零死信**（旧实现此场景死信——红测先行）。
- 对账（按轴拆分，v4-P8）：Σ钱包扣款 = Σ收据用户额 − Σwaived；
  Σ渠道扣减 = ΣupstreamCost。两轴分别断言。
- 多笔并发 over 深度：DB 敞口地板触发器回归（既有）。

### 表驱动
- C1-C7 × {命中, 各单条件破坏} 矩阵（C4 含 margin；C7 含 bytes/4 边界）。
- 价格矩阵：全价=缓存价/缓存价缺失/三价不等/全零/尾部+残留写价场景。
- cache_ratio × window 边界表。
- 双界消费矩阵：{渠道匹配,不匹配}×{用户侧,渠道侧金额,B2}——B2 列恒字节界。

### e2e（复用既有装置；闭式断言）
- 旅程一：同前缀两笔 → prefix_calibrations 行内容 + quote.calibration 五
  字段 + channel_reserved_amount = 闭式 + conservative_channel_amount =
  闭式保守值；第三笔改前缀 → 逐字段保守。
- 旅程二：校准请求超校准预留但 ≤ 保守 → 超额扣减 + 指标 + 渠道负余额 +
  不死信。
- 旅程三：实际成本 > 保守金额（替身虚高 usage）→ B4 死信红灯。

### 假绿对抗抽查点（收口时执行）
- 回落断言逐字段；命中断言闭式公式值（非不等式）。
- I0 断言在「校准界刻意做小」的故障注入下仍零钳制零死信。
- 死信分支断言 error code 非文本。

## 12. 验收清单
- [x] 契约 §3 逐条（表/列/KV/ACL/观测）——admin 前端校准卡降级为后续工单（P13）
- [x] 四门 + 覆盖率数字如实报告（typecheck/lint/build/test 全 34 任务绿；
      e2e 校准三旅程 3/3 真实 PG 绿）
- [ ] 边界清单 §11 逐条
- [ ] 并发/一致性预算 §6 逐条
- [ ] 资金安全断言 §11 全绿（I0 分离 + B4 三分支 + F1 并发 + 按轴对账）
- [ ] 四门 + 覆盖率数字如实报告
- [ ] e2e 三旅程绿（闭式断言）
- [ ] 部署硬门 + 回滚阶梯落 runbook
- [ ] 架构契约测试同步更新
- [ ] 裁决 D1-D17 落档且实现一致

## 13. 已知遗留（登记挂账，不阻塞本方案）
- URL 引用媒体的字节界低估（output-cap.ts 对 referenced media 按字节计，
  厂商按尺寸计）：存量缺陷，保守口径下即可触发现行 B4；另行工单。
- waived 累计无界：D15 监控接受；如需硬限额属新状态机（不在本方案）。
- 计数器口径轮间不一致的厂商（C7b 拦截大部分）：残余表现为
  calibration_gap 指标，§9 步骤 2 中止条件覆盖。
