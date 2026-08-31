# 免费定价单源化：删除平行免费标记，免费 = 价格取值

状态：已实施（2026-08-31，用户裁决：不要多个免费字段，免费针对价格本身）

## 背景与裁决

- 生产事故复盘（2026-08-30/31）暴露双事实源雷区：`model_mappings.is_free` 与
  `model_channels.cost_is_free` 是与价格平行的布尔标记，与价格不一致时触发
  `invalid_quote` 结构性拒绝（授权/结算口径分裂防御）。
- 用户裁决：系统不应有多个「免费」值；免费是价格的取值，不是平行字段。
- 行业对齐：OpenRouter `:free` = pricing 全 0（无标记字段）；new-api 免费 =
  倍率 0 / 固定价 0 / 发额度；火山方舟营销免费 = 赠送额度。三家的「免费」
  都不是独立布尔。
- 既有事实：`control-plane/domain/model/model-pricing.ts` 的 `isFreeByPrice`
  （全零价 = 免费）已是目录导入的推导口径——本方案将该口径升格为系统唯一口径。

## 设计

### 删除的两个平行标记

| 列 | 原作用 | 删除依据 |
| --- | --- | --- |
| `model_mappings.is_free` | 免费意图声明 + 授权 fast-path 判据 | `isFreeByPrice` 推导等价；「零价未声明拒绝」保护随零价即免费语义取消 |
| `model_channels.cost_is_free` | 绑定级「进货成本恒 0」声明 | 0110 修复后「成本未配置(NULL)」与「标记免费」的记账结果完全一致（都按 0） |

### 免费判定唯一口径

- **用户侧**：模型价格五轴全 0 → 免费模型（授权 0 元 fast-path 不校验余额、结算 0）。
- **渠道侧**：绑定成本五轴全 0（显式）或全 NULL（未配置）→ 进货记账 0。
- 公开 API 的 `isFree` 字段**保留但改推导来源**（形状不变，消费方零破坏）。

### 明确不处理

- 「免费渠道服务 → 用户免费」的定价联动：不做（破坏授权 ≥ 结算不变式、
  定价不可预期；行业无此做法）。营销免费走钱包赠送/兑换码（火山式）。
- 防误配印刷机保护（原「零价未声明免费拒绝」）：后端保护随标记删除而取消，
  职责移交管理台交互（价格清零需过确认）与审计日志。

### UI 快捷开关（保留便利、不再是存储事实）

- 模型编辑「免费」：勾选 = 五价一键清零 + 输入禁用；勾选态由价格推导（全零即勾）。
- 绑定成本「免费」：勾选 = 成本五轴一键清零；勾选态由成本值推导。

## 实施顺序

1. db：迁移 0111 双列 DROP + schema 声明删 + journal/计数测试
2. control-plane：model-store / create / update / list / bind-channels / channel-store 删两标记读写
3. inference：Snapshot/QuoteCandidate 删 isFree 透传
4. billing：calculate 的 explicitlyFree 改纯价格判定（全零 fast-path 保留，矛盾态校验删）
5. gateway：toQuote 删 isFree 分支；costPricesOf 删 costIsFree 分支
6. admin-api / client-api：isFree 改推导；绑定契约删 costIsFree；openapi/DTO 重生成
7. admin 前端：两处免费开关改「价格清零」快捷方式 + i18n

## 测试口径

- 推导正确性：全零 / 部分零 / 空值 / 负值（表驱动）
- 免费模型请求：授权 0 预扣不校验余额、结算金额 0
- 绑定成本 0（显式与 NULL）记账 0；配价按价记账
- 回归：目录导入 isFree 推导、编辑模型价格补丁合并、绑定列表展示
