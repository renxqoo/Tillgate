# rating —— 计价域

> 出口：`@ai-gateway/ledger/rating`
> 源码：`src/rating/{types,quote,amounts,coefficient}.ts` + 22 例测试

## 1. 职责与边界

「一次 AI 调用值多少钱」的**全部算术**：授权前推最坏费用、结算时算双口径实费、
费率卡系数解析、收据验收。**纯函数为主、无资金写动作、无业务状态机**——
被 authorize（落账前）、signal（收据入库前）、settle（结算前）、管理端预览四处共用，
是名副其实的单一真相。

依赖：`wallet/metering`（Decimal/estimateMaxCost/calcAmount，元 + 全精度永不 round）。

## 2. 领域概念

### UsageReceipt（durable receipt 的类型契约）
一次上游调用的完整计费事实：requestId（幂等键）、身份（userId/apiKeyId/appId/credentialType）、
模型（external/real/mappingId）、渠道（channelId/channelKey）、usage
（input/cachedInput/output tokens + units 单位计量 + estimated 标记）、价格快照
（inputPrice/outputPrice/cacheInputPrice/unitPrice + coefficient）、
`billingPolicyFingerprint`（多模态策略快照）、`estimatedFor`（估算结算归属）。

### BillingQuote（授权报价）
候选链（fallback 顺序）+ `maxOutputTokens`（已含 n 等倍数）+ `explicitlyFree`。
每候选带 `inputTokenUpperBound`（可证明上界：文本字节或模型硬上限）与 `unitUpperBound`。

### 估算归属白名单（G1 不变量）
`ESTIMATE_ATTRIBUTIONS = 用户取消三态 + 完成缺 usage 两态`——估算 usage 只允许
归属这五类；无归属/白国外的估算收据一律结构化拒绝（防借估算口径开后门）。

## 3. 对外 API

### quote.ts —— 授权金额推导 + 收据验收
| 函数 | 干什么 |
|---|---|
| `calculateRequired(quote, limit): Decimal` | 候选链取**最贵**（fallback 更贵不得透支）→ 每候选 `estimateMaxCost`（输入按两种输入单价较高者、输出按上界、单位按上界，× 系数）→ `requiredReservation` 过单请求上限（超限拒绝**绝不截断**）。免费口径一致性（R6）：`explicitlyFree` 但候选有价 → 结构性拒绝 |
| `validateReceipt(userId, quote, receipt)` | 五道验收：userId 一致 → 估算归属合法（G1）→ usage 数值自洽（非负/整数/cached ≤ input/durationMs）→ 价格快照**命中授权候选**（mapping/模型/四价/系数/策略指纹全比对，防中途改价算错账）→ 金额资损不变量交由 settle 的信用地板（不用 token 计数设防——厂商会报隐藏 token） |

### amounts.ts —— 结算双口径
`computeAmounts(receipt): { calculated, calculatedAmount, upstreamCost }`
- **calculated（用户侧实扣）**= `calcAmount`：真实 usage × 价格快照 × 系数，Decimal 全精度；
- **upstreamCost（渠道侧成本）**= 官方价口径（系数恒 1）、负值钳 0——渠道进货额度按此扣减。
  同一收据两个口径分离，是「用户毛利率」的结构保证。

### coefficient.ts —— 费率卡系数
| 函数 | 干什么 |
|---|---|
| `loadRateCardCoefficients(db, rateCardId)` | 单查询载入整卡快照（`{status, global, model: {}, group: {}}`）；卡不存在 null；行级脏数据不炸——pick 兜底 '1' |
| `pickCoefficient(snapshot, {modelMappingId, pricingGroup})` | 纯函数挑选：**model > group > global > '1'**；snapshot=null 恒 '1' |

消费方：gateway coefficient-cache（鉴权热路径加缓存）、client-api 公开定价页、
admin-api 系数预览——**口径必须一致，不得自行查表**。
`usage_logs.coefficient` 是按请求快照，结算不受事后改系数影响。

## 4. 技术架构

- **纯函数域**：quote/amounts 零 IO，可独立单测；coefficient 只有一个只读加载器。
- **精度纪律**：全程 `wallet/metering` 的 Decimal（元 + 小数字符串，无整数编码）；
  存储用 `toStorage`，比较用 Decimal.eq——永不 round。
- **上界哲学**：授权宁可多押不可少押（输入取两种单价较高者、token 取可证明上界）；
  结算按实际——两者的差在 settle 的补充授权模式里收敛。

## 5. 测试（22 例）

- `quote.test.ts` 14 例：候选链最贵/缓存价覆盖/系数放大/免费一致性 R6/空候选/
  负价/非正系数/超限拒绝不截断 + 收据验收五道（错用户/G1 拒绝/五类归属通过/
  usage 自洽三态/改价改系数 not_authorized）。
- `amounts.test.ts` 5 例：双口径同额、系数只作用用户侧、缓存命中按缓存价、
  单位计量、负价钳 0。
- `coefficient.test.ts` 3 例：优先级全链、无卡/脏数据兜底、停用卡状态透传
  （含测试数据清理纪律）。
