# Dashboard 趋势图升级（日/小时双粒度 + 多度量 + 按模型堆叠）方案

> 状态：定稿
> 级别：中
> 来源 issue：#68

## 契约

### 后端（apps/client-api）

新增 `GET /v1/usage/trend`（会话态；userId 从会话取，不收请求参数）：

- Query：`granularity=day|hour`（zod enum，缺省 `day`；非法值 400，错误码沿用
  zod query 校验既有形态 `http.*` 目录）；
- 响应信封（与 summary 的 `{list}` 一致风格）：

```jsonc
{
  "granularity": "day",            // 回显
  "list": [                         // 每行 = 模型 × 桶
    {
      "bucket": "2026-10-12",       // day: yyyy-MM-dd（CLIENT_USAGE_TZ 日界）
      "model": "gpt-x",             // usage_logs.external_model
      "requests": 3,
      "inputTokens": 100,
      "outputTokens": 50,
      "cachedInputTokens": 20,
      "cost": "0.012"               // numeric 字符串（全精度，前端按需 Number()）
    }
  ]
}
```

- hour 桶 `bucket` 形态 `yyyy-MM-ddTHH:mm:ss`（前端截取展示；避免歧义用完整本地时点）；
- 窗口语义：
  - `day`：近 14 天（含今日）——前端继续用 `trendWindowFrom` 推导 `from` 传入；
    后端只回有流量的行（补零是前端序列职责，与 summary 现状一致）；
  - `hour`：后端按「请求时刻在 CLIENT_USAGE_TZ 的今日」过滤（`created_at >= 今日当地 00:00`），
    窗口由后端推导（不接受 from/to——hour 模式下前端无法可靠知道「今日」边界以外
    的语义，单一真相放后端）；
- 只读查询，无错误目录新增（复用 HTTP 层校验错误）；无事件副作用。

### DTO（packages/api-client）

新增 `UsageTrendRow`、`UsageTrendPage`（手写快照，与 `UsageDayRow` 同风格）；
`./index` 导出面同步（DTO 文件本身被 index 重导出，无需改 exports 映射——以
`src/index.ts` 现状为准）。

### 前端（apps/client）

- `cost-trend.ts` 扩展：
  - `UsageTrendPoint = { bucket: string; series: Array<{ model: string; cost: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; requests: number }> }`
    （宽表行：每桶一行，模型×度量在行内展开为动态键 `model::metric`，供 recharts 堆叠）；
  - `fillDailyTrendSeries({ rows, days, timeZone, now })`：day 模式补零 14 桶；
  - `fillHourlyTrendSeries({ rows, timeZone, now })`：今日 24 桶补零（含未来小时）；
  - `hourBucketKey(timeZone, at)`：CLIENT_USAGE_TZ 的小时桶键。
- `cost-chart.tsx` 改造为 `TrendChart`：
  - ToggleGroup 1：粒度（按日 / 按小时）；
  - ToggleGroup 2：度量（费用 / Token / 请求）——沿用 by-model 卡的同款交互；
  - Token 度量：三系列（输入/输出/缓存）× 模型堆叠 → 实际 series = 模型 × 3 条
    stacked area；费用/请求度量：模型堆叠单度量；
  - 空数据降级与既有一致。
- `dashboard/page.tsx`：默认 day 模式数据服务端取（与现状同缝）；粒度切换为客户端
  交互，小时数据经组件内 fetch（`/v1/usage/trend?granularity=hour`）懒加载——
  避免服务端多打一发大多数用户不看的请求。
- i18n：`dashboard` 命名空间新增粒度/度量文案（zh/en 同步）。

## 问题域

- 处理：新增 trend 聚合端点（day/hour × 模型维度）；前端趋势卡双粒度双度量切换
  与堆叠渲染；补零序列纯函数；i18n 文案。
- 不处理：
  - admin 控制台趋势（归属 admin-api/observability，票外）；
  - by-model 横条卡（本票不动）；
  - `summary`/`by-model`/`rate` 端点（消费方仍在，形态不变）；
  - 时间范围选择器/周月聚合（票外，未来如需再开票）；
  - 缓存命中率派生指标（by-model 卡已有，不重复实现）。

## 并发/一致性预算

- 纯读路径，无写入、无事务需求；金额仅聚合展示（Decimal 字符串 wire，前端
  Number() 展示——与 summary 现状同口径，不引入资金运算）。
- 查询量级：单用户 14 天/24 小时 × 模型数（典型 <20）行级聚合，走
  `usage_logs(user_id, created_at)` 既有索引形态；无全表扫描风险。

## 拆分

- `apps/client-api/src/http/contracts/usage.ts`：trend query schema + wire 类型；
- `apps/client-api/src/adapters/usage-read.ts`：`trend()` 聚合（day/hour 桶 + 模型分组）；
- `apps/client-api/src/http/routes/usage.ts`：路由注册（UsageReads 接口扩展）；
- `apps/client-api/src/assembly.ts`：无需改（usageRead 已注入，接口扩展自然透出）；
- `packages/api-client/src/dto/client-api.ts`：DTO 快照；
- `apps/client/src/features/dashboard/trend-series.ts`（由 cost-trend.ts 更名扩展）：
  纯函数层；
- `apps/client/src/features/dashboard/trend-chart.tsx`（由 cost-chart.tsx 更名扩展）：
  渲染层；
- `apps/client/src/app/(main)/dashboard/page.tsx`：装配；
- 依赖方向不变（client → api-client ← client-api）。

## 实施顺序

1. 后端契约 + 聚合 + 路由 + DTO + client-api 契约测试（红→绿）；
2. 前端纯函数（补零序列/桶键）+ 单测（红→绿）；
3. 前端图表组件改造 + page 装配 + i18n + 渲染切片测试；
4. 四门 + format；
5. 对抗审查（pr-review-loop）→ 修复循环；
6. e2e 旅程核对（verify-harness 盘点：client-journey 装置存在，为 trend 端点补
   一条断言或确认装置覆盖面——依赖 PG/Redis 可用性，不可达时如实标注）。

每阶段独立提交可回滚；无过渡态（新端点纯加法，旧 summary 不动）。

## 裁决

- [用户裁决] 双粒度切换（day 14 天 + hour 今日 24 桶）；
- [用户裁决] 度量切换 + Token 三系列分列；
- [用户裁决] 按模型堆叠；
- [用户裁决] hour 桶 = CLIENT_USAGE_TZ 今日 00:00 起到当前小时、未来小时补零；
- [默认裁决，可否决] 新增独立端点 `GET /v1/usage/trend`（不动 summary）；
- [默认裁决，可否决] hour 窗口由后端推导（今日当地 00:00 下界），不接受 from/to；
- [默认裁决，可否决] 前端小时数据懒加载（切换时组件内 fetch），日数据保持服务端预取；
- [默认裁决，可否决] cost-trend.ts/cost-chart.tsx 更名扩展为 trend-series/trend-chart
  （职责已超出 cost；git mv 保留历史）。
- [落档不改——审查 Round 1 裁决] NEXT_PUBLIC_DISPLAY_TZ 必须与 CLIENT_USAGE_TZ 同值部署
  （耦合约束，非默认同值兜底可解除）：两值漂移时后端桶键按 CLIENT_USAGE_TZ 生成、
  前端序列窗按 DISPLAY_TZ 生成，键集合不相交 → trend（day/hour）与 summary 序列
  静默全零空态、无任何报错。该耦合自 summary 时代继承（day 模式既有）。彻底解法
  （后端响应回显时区、前端按回显值生窗）是契约变更，超出本票——待单独开票。

## 测试口径

### 契约断言（client-api app.test.ts）

- `granularity=day`：回显 + 行含 model 维度 + envelope `{granularity, list}`；
- `granularity=hour`：bucket 为小时键形态；
- `granularity=garbage`：400；
- 缺省 granularity=day；
- fake deps 单元语义（trend() 的 SQL 形态靠 adapter 层断言不可行——app.test 走
  fake；真实 SQL 由 e2e/装置覆盖，如实标注边界）。

### 边界清单

- 空窗口（今日无流量 → hour 模式 list 为空，前端补零后 24 桶全零）；
- 窗口外行（summary 既有口径：前端丢弃窗口外行）；
- 模型名含特殊字符（仅作 group by 键，无注入面——drizzle 参数化）；
- 未来小时补零；DST 时区（hour 桶用 Intl 推导，测试覆盖 Asia/Shanghai 与
  非整点偏移时区如 Asia/Kathmandu）；
- 前端垃圾行防御（NaN cost → 0，沿用 `Number(x) || 0` 口径）。

### 分层清单

- 单元：trend-series 纯函数（补零/桶键/宽表展开）——pure-logic.test.ts 扩展；
- 契约：client-api app.test.ts（trend 四断言）；
- 渲染切片：trend-chart（切换交互、空态、堆叠 series 存在性）——jsdom；
- e2e：client-journey 装置核对（PG/Redis 可达时跑；不可达标注）。

### 表驱动清单

- 粒度×度量×（空/有数据）渲染矩阵的代表性子集（非全笛卡尔积——渲染切片成本高）。

## 验收清单

- [ ] 外部契约：granularity enum 校验/缺省/回显；envelope 形态；DTO 同步；
- [ ] 边界：空窗补零、窗口外丢弃、未来小时、DST、垃圾行；
- [ ] 并发/一致性预算：纯读、无资金运算（复核）；
- [ ] 四门 + 覆盖率数字如实报告 + e2e 旅程（或不可达标注）；
- [ ] i18n parity 测试通过；
- [ ] issue #68 验收标准逐条核销，PR 含 `Closes #68`。
