# 结算用量验收门（usage acceptance gate）方案
> 状态：已核销
> 级别：中

## 契约

- **收据契约**：`UsageReceipt` 新增可选 `outputEvidenceBytes?: number`——输出证据字节
  （流式 = 中继帧字节 `relay-stream.bytesRelayed`；非流式 = 响应体序列化 UTF-8 字节）。
  jsonb 向后兼容：旧收据缺省 = 无 B3 证据界，仅走 B1/B2。
- **结算对外行为**：金额、账本、usage_logs 投影全部改消费**验收后用量**；估算收据
  （`estimated: true`，我方口径）跳过验收门——本门只审「上游发票」。
- **错误面**：B4 经济闭合（钳后官方成本 ≤ 账单渠道预留）违反 → `DefectError`
  （`billing.usage_economic_bound`）进死信族——钳后 B4 应为定理，违反即内部不一致。
- **副作用时序**：验收（纯函数，零 IO）→ 钳制结算照常完成 → 缺陷计数（同事务单条
  UPDATE，原子）→ 计数过阈即熔断渠道（复用既有 broken 机制）→ 事务提交后
  `onUsageDefect` 观察钩子（best-effort，装配接日志+审计）。终态最后、一次性事件恰好一次。

## 问题域

- 处理：可信 usage 的三类上界钳制（B1 输出 ≤ quote.maxOutputTokens[含 n]；B2 输入侧
  ≤ 命中候选 inputTokenUpperBound，含 cached/cacheWrite/units 同界；B3 输出 ≤
  outputEvidenceBytes——字节数 ≥ token 数为定理，帧开销只放大上界，安全方向）；
  钳制事实落渠道缺陷计数与审计；B4 经济闭合断言。
- 不处理：
  - **对称低报检测**（设计讨论稿曾含）：SSE 帧开销使中继字节作下界不成立
    （千块×一 token 场景 bytes/tokens ≈ 100+，任何安全系数都假阳）——归属：
    运营对账报表（usage_logs vs 渠道发票），后续可观测项，不入本门。【设计修订，落档原因】
  - 估算收据验收：估算值本身派生自我方特征/字节，有界性由构造保证。
  - 存量事故数据修复（alice -20,009.5 等）：保留作事故存证（用户裁决）。

## 并发/一致性预算

- 验收门为纯函数：零 IO、零定时器； receipts 与 quote 均已在结算事务内读出，无额外查询。
- 缺陷计数：单条 `UPDATE channels SET usage_evidence_defects = usage_evidence_defects + 1
  ... RETURNING`（原子，无读改写竞态）；阈值判定在 SQL 侧。
- 三本账同源：用户扣费/渠道扣减/平台收入消费同一钳后收据（computeAmounts 单次）。

## 拆分

- `packages/billing/src/domain/rating/usage-acceptance.ts`（新，纯函数单一真相）；
  settle.ts 事务体接线；`ChannelExposureStore` 增 `recordUsageDefect`（port +
  postgres 适配器）；迁移 0098（channels.usage_evidence_defects 列）。
- `packages/inference`：receipt 增证（流式 trusted 分支透传帧字节；非流式序列化响应体）。
- 装配：`createBilling` options 增 `usageDefectBreaker: number`（阈值，必填注入）与
  `onUsageDefect` 钩子；gateway/worker config 各自 env（`BILLING_USAGE_DEFECT_BREAKER`，
  缺省 5）。
- 依赖方向不变（inference → billing 类型已有；billing 不新增外部依赖）。

## 实施顺序

1. billing domain 验收函数 + 单测（表驱动）；
2. receipt 契约扩展 + inference 增证 + 单测；
3. settle 接线 + 缺陷计数 port/适配器 + 迁移 0098 + 阈值/钩子装配（gateway+worker）；
4. 回归测试（含「伪造发票打穿渠道预算」在旧实现复现、新实现被钳制的症状用例）；
5. 四门 + e2e + 部署实测（mock 重放今晨攻击 → 预算不动、缺陷+1、审计落库）。
   过渡态：旧收据（无 outputEvidenceBytes / 无 quote 候选界）→ 对应界跳过；无版本双轨。

## 裁决

- 完整方案（验收门三界 + 三账同源 + 缺陷熔断）与「不修 alice 存量」：用户裁决（讨论定案）。
- 对称低报检查退出本门（证据不可靠）：默认裁决，理由落档于「不处理」。
- 钳制而非死信作为主处理（用户即时结算，缺陷另路熔断）：沿用讨论定案。

## 测试口径

- 契约：B1/B2/B3 钳制矩阵（表驱动：越界值 × 各界在场/缺省）；估算收据直通；
  旧收据（无证据字段）缺省路径；B4 钳后违反 → DefectError。
- 边界：maxOutputTokens=0（免费/embeddings）、inputTokenUpperBound 缺失（旧 quote）、
  cached > input、cacheWrite 越界、units 越界、全部界同时越界、恰好等于界（不钳）。
- 集成：结算事务内——钳后渠道扣减 ≤ 预留（预算不穿底断言）；缺陷计数递增、
  过阈熔断；onUsageDefect 钩子异常不反杀结算。
- 回归（症状命名）：「上游伪造 30M token 发票打穿渠道预算至 -3999 万」——旧实现
  预算被穿，新实现钳至准入敞口且缺陷计数 +1。
- e2e：部署栈重放攻击旅程（mock 强制 usage）→ 渠道预算余额不变、
  usage_logs 计费用钳后值、audit 出现 usage_evidence_violation、渠道 defects+1。

## 验收清单
- [x] 外部契约逐条（outputEvidenceBytes 兼容 / 三账同源 / DefectError B4）
- [x] 边界/异常清单逐条（验收门 9 用例 + 结算 3 症状回归）
- [x] 并发/一致性预算逐条（纯函数 / SQL 侧原子计数 / 无定时器）
- [x] 四门全绿（billing 371、inference 165）+ billing-recovery e2e 3/3 + 部署栈攻击重放：伪造 3000 万 token 发票被钳到准入界（渠道 -326 而非 -4 万）、缺陷计数 +1、审计行带钳制明细落库
