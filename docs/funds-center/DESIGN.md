# 资金中心模块 + 币种落库 方案
> 状态：已核销
> 级别：中（跨 admin 控制台/admin-api/control-plane/billing 与四 app 装配；无破坏性契约变更）

## 契约
- 导航：permissions 页节点 `nav.channelFunds` 原地升格为 `nav.funds`（path `/dashboard/funds`），
  按钮 funds:adjust/recharge/floor 随页迁移；新增按钮权限 `funds:fx`（汇率管理）；
  fx 四端点重绑：GET /v1/fx/catalog → funds:read，PUT/DELETE override + PUT buffer + POST refresh → funds:fx。
- 资金中心页 `/dashboard/funds` 三页签：渠道资金（原页整体并入）/ 风控参数（地板+预扣+时区卡自设置页迁入）/
  汇率与币种（新汇率卡消费既有孤儿 API；币种卡 P2）。设置页瘦身为账号与集成域。
- 币种（P2）：KV `platform_currency`（种子 CNY）；GET/PUT /v1/settings/platform-currency（funds:floor 绑定）；
  **写一次守卫**：存在 wallet_accounts / channel_recharges / usage_logs 任一行即 409（用户裁决红线）。
  四 app 启动读一次（不可变期间无热读）；删除 GATEWAY_CURRENCY / CLIENT_CURRENCY env、
  ADMIN_CURRENCY 常量、worker 两处硬编码；BILLING_GUARDS.currencies 派生自币种
  （存量审计：'USD' 白名单项全库无调用方，安全收敛为单币种）。
- 汇率 env 三键（FX_SOURCE_URL/TTL/TIMEOUT）保留：拉取机制参数非资金决策（默认裁决，否决窗口）。

## 问题域
- 处理：控制台信息架构聚合（资金管理单入口）；fx 管理 UI 化（后端 API 已存在仅孤儿）；
  币种单一真相落库 + 处女系统守卫；币种 env/常量删除。
- 不处理：换币数据迁移（显式流程，将来「财务中心」需求）；用户钱包/支付订单/结算复核页面归属；
  fx 数据源运营切换（env 保留）。

## 并发/一致性预算
- 币种启动读一次：迁移种子保证全进程一致；PUT 仅处女系统可达，无并发换币窗口。
- fx 卡操作走既有 control-plane fx 用例（审计已有）；导航为 DB 数据，无代码路由分支。

## 拆分
- P1（纯前端 + 导航迁移）：console funds 页（复用 ChannelFundsClient/三张设置卡 + 新 FxCard +
  funds-actions.ts）；迁移 0100（permissions 节点升格 + funds:fx + fx 端点重绑）；i18n；设置页瘦身；
  删旧 channel-funds 页目录（不留重定向——默认裁决）。
- P2（币种落库）：billing platform-currency 键/解析/读取件（composition 出口）→ control-plane
  settings 面（读回落 CNY / 写 + 处女守卫 + 错误码 invalid_platform_currency / conflict）→
  admin-api 端点 + openapi/DTO/契约测试 → 四 app 装配替换 + env 删除 → 币种卡。
- 实施顺序：P1 全绿部署 → P2；过渡态：P2 前各进程 env 值与种子一致（CNY），无观察窗口。

## 裁决
- 汇率权限独立 `funds:fx`（推荐，默认裁决）；旧路由不重定向（默认裁决）；
  币种写一次守卫红线=钱包/进货/用量任一存在即锁（用户裁决）；
  计费时区进资金模块（用户裁决）；fx 拉取三键留 env（默认裁决）。

## 测试口径
- 契约：导航迁移后 rbac 双源对账（ENFORCED_CODES + funds:fx ⊆ 种子）；fx 重绑后 rbac-matrix 全命中；
  platform-currency GET 回落 / PUT 处女通过 / 非处女 409（真 PG e2e）/ 非法 ISO 码 400。
- 边界：非法币种码（长度/小写/数字）、空 body、fx 卡 override/buffer/refresh 动作矩阵。
- 回归：设置页迁移后原卡功能不回退（server actions 原样）；channel-funds 列表在 funds 页签内可用。
- e2e：admin 旅程补资金中心导航命中 + platform-currency 端点族。

## 验收清单
- [x] 契约逐条：导航 nav.funds 升格 / 三页签 / fx+币种端点权限重绑 / 币种处女守卫（部署实测 409 platform_currency_locked）
- [x] 边界清单逐条（非法币码 400 / 非法上限 / fx 表驱动；billing 375、cp 270、admin-api 225、gateway 182、worker 75、admin 254、client-api 110）
- [x] 并发预算逐条（四 app 启动单次读;guard 白名单自币种派生,旧 'USD' 死项收敛）
- [x] 四门全绿 + admin e2e 24/24 + 部署实测：资金中心页三页签 SSR 渲染、汇率状态（auto 6.7209）、币种读 CNY、非处女 409、非法码 400
