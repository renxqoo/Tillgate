# 渠道成本价双轨定价（channel cost override）

状态：**已实施**（2026-08-31 一次到位交付：迁移 0108 + 全链换源 + costAffinity + 管理台三面；e2e gateway/channel-cost 3/3 真链验证。调研依据：OpenRouter/Vercel 按实际服务方计价、
new-api 全局模型价×分组倍率、Tillgate 运营商模式裁决为双轨）

## 1. 问题与裁决

同一对外模型（如 minimax-m3）多渠道绑定时，各渠道进货成本不一致（官方价/折扣/免费/
峰谷），但价格只挂在映射层：用户价与渠道成本共用映射官方价 → 免费渠道被全额预留
（额度白占）、高成本渠道预留不足（闸门弱化）、毛利不可核算。

**用户裁决（本轮）**：一步到位交付生产可用实现；重构替换旧口径；删除无用逻辑。

设计裁决（沿用既有架构哲学）：

| # | 裁决 | 依据 |
| --- | --- | --- |
| C1 | 用户卖价不动（映射官方价 × 费率卡），渠道成本价落到 model_channels 绑定层 | 运营商模式：卖价与路由解耦（费率卡/收据授权/价格可预期三资产不破） |
| C2 | 绑定成本列 NULL = 继承映射官方价（SQL COALESCE 单轨收口，零兼容层零回填） | 单一真相：继承语义在读取处一次表达 |
| C3 | 成本快照 hold==settle：resolveChannels 时刻解析（含 cost_config schedule 窗口），预留与结算共用同一快照 | 与变体定价「hold == settle 单一价格快照」同哲学；窗口跨界不破坏 settle 不变式 |
| C4 | costScorer 策略子开关默认关闭 | 单轨化 D2 哲学：不隐式改变存量路由行为 |
| C5 | 收据成本轴不进授权校验（validateReceipt 只锁用户价） | 成本来自渠道绑定（授权时点的另一事实源），与映射价授权正交 |

## 2. 现状资产（本方案直接复用，不重建）

- `computeAmounts`（billing/rating/amounts.ts）已是双口径：calculated（用户）+
  upstreamCost（系数 1）——仅需成本轴换源。
- settle 不变式（cost > reserved → DefectError）、渠道额度扣减（channel-exposure）、
  usage_logs.upstream_cost 落库、管理面 upstreamCost 暴露——全链已存在。
- `estimateMaxCost`（保守上界）与 `matchPricingWindow`/strategyOf（窗口解析）纯函数复用。
- catalog-port 是价格解析既有桥接层（billing 纯函数 + control-plane store → 快照）。

## 3. 数据模型（迁移 0108）

`model_channels` 增加（全部可空，NULL=继承）：

- `cost_input_price` / `cost_output_price` / `cost_cache_input_price` /
  `cost_cache_write_price` / `cost_unit_price`：numeric(38,18)，CHECK 非负。
- `cost_config` jsonb NOT NULL DEFAULT '{}'：形状与 BillingConfigJson 同构
  （schedule 峰谷成本窗口；variant 等策略同构复用 billing 解析器）。

## 4. 计价链改动（逐文件）

| 文件 | 改动 |
| --- | --- |
| db schema + 迁移 0108 | model_channels 成本列；migrations.test 计数 106→107 |
| control-plane channel-store | findRouteCandidates select `coalesce(mc.cost_*, mm.*)` + cost_config → RouteCandidateRow 增 5 个已合并成本价 + costConfig |
| control-plane model-store + application | 绑定/替换写成本列；ports 类型同步 |
| gateway catalog-port | toChannelCandidate 解析 cost_config schedule（now+计费时区）→ ChannelCandidate.costPrices（恒提供：合并价经窗口覆盖） |
| inference types | ChannelCandidate.costPrices（生产恒有；缺省消费方回落映射价）；UsageReceipt.costPrices 快照 |
| inference gates/ports/billing | reserveChannel 透传 costPrices；receipt 构建带 ctx.channel 成本 |
| gateway billing-port | reserve 金额优先 costPrices（回落映射价）；signal 透传 receipt.costPrices |
| billing amounts | upstreamCost = calcAmount(成本轴, 系数 1)；UsageReceipt 类型增 costPrices |
| inference policy + ranker | scorers.cost { enabled:false, floor:0.5 }；层内成本亲和降权 factor=max(floor, cheapest/own) |
| admin-api contracts + openapi | 绑定契约收成本字段；重生成 openapi/DTO |
| admin UI | 绑定弹窗成本覆盖编辑（缺省「继承官方价」）；路由 scorer 卡成本字段；用量日志成本/毛利列 |

## 5. 不处理（归属）

- 用户卖价 per-channel（OpenRouter 按渠计价）：与费率卡冲突，拒绝（C1）。
- 渠道分组倍率（new-api 模式）：变体映射已覆盖该需求（minimax-m3-free 等独立映射）。
- 成本侧 isFree：显式「免费渠道」开关（PricingEditor 成本轴派生态——可见轴全 0 即亮灯；开启置 0 并清策略草稿，避免免费与窗口/档位价矛盾）。语义仍是成本全 0，开关是 UI 显式化（2026-08-31 用户裁决追加）。
- usage_logs 成本价快照列：upstream_cost + channel_id 已可复算毛利，暂不加价列。

## 6. 测试计划

- billing：computeAmounts 成本轴（覆盖/缺省/全 0 免费）；policy schema cost 段默认。
- inference：ranker costScorer 分配；receipt costPrices 快照；gates 透传。
- control-plane：findRouteCandidates COALESCE 合并断言（real）；绑定写读回。
- gateway：billing-port 成本优先级；catalog-port 窗口解析。
- e2e `gateway/channel-cost.test.ts`：免费渠道零预留放行 + 折扣渠道敞口按成本 +
  costScorer 层内偏好（enabled 策略种子）。
- 管理端：bind 表单/routing 表单/用量列（i18n 双语守护）。

## 7. 回滚

迁移为纯 ADD COLUMN（可空）——回滚 = revert 提交 + DROP COLUMN；未配置覆盖的绑定
行为与现状逐字节一致（C2 保证），上线即零行为变化。
