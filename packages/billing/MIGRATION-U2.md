# U2 计价与授权链迁移文档

> 状态：已核销（U2a domain 纯函数 + U2b application/adapters；验收数字见 §7）
> 迁移单元：计价流水线（计量→定价策略→预扣策略→公式→收据验收）+ 计费授权链
> （authorize 资金瀑布 / signal 四事件 / admission 积压准入 / reserveChannel 渠道敞口）
> 旧实现：`domain/src/{rating,billing,channel-budget}` + `service/src/{billing,funding,channel-budget}` + `repository/src/{billing-request,billing-reservation,channel,subscription(额度原语),usage-log(读侧)}.repo.ts`
> 目标位置：`packages/billing/src/domain/{rating,billing}` + `application/billing/*` + `ports/{billing-store,funding-ports}` + `adapters/postgres/billing-store`
> 关联：DESIGN §2/§4、IMPLEMENTATION §1.2 B2/B3/B6 / §3、ADR-0003

## 1. 行为规格基线

旧测试：rating 11 文件 + domain/billing 2 文件（gate-rules/settle-rules）+ service
billing/billing-limits —— 全部行为以新测试锁定（文件映射见 §5）。operations 幂等壳
（service/shared/operations）**移至 U4**（其消费方是订阅购买与管理端死单复核，
不在授权链上）。

## 2. 审计结论引用

- B2：calculateRequired 组装漏传 cacheWritePrice（修：显式传入 + 免费一致性检查纳入写价）。
- B3：decode/validate 的 Decimal 构造异常逃逸毒收据家族（修：finiteDecimal 捕获归类）。
- B6：ReservationError/家谱双类跨包永不匹配（修：全部进 billing 目录，捕获按 nature/code）。
- 死信家族改按「DefectError ∨ 毒收据/配置码前缀」判定——未来 channel-budget 不变量
  以 DefectError 表达即自动进死信，无需下行依赖（契约演进，MIGRATION §4）。

## 3. 逐模块裁决表

| 旧模块                                                       | 裁决                 | 动作                                                                                     |
| ------------------------------------------------------------ | -------------------- | ---------------------------------------------------------------------------------------- |
| domain/rating 14 文件                                        | 复制+微修            | domain/rating/*（B2/B3 修复；错误进目录）                                                |
| domain/billing 7 文件 + channel-budget/reserve-rule          | 复制+微修            | domain/billing/*（含 channel-exposure 决策纯函数）                                       |
| service/billing/{authorize,signal,admission,reserve-channel} | 重写                 | application/billing/*（RunContext 移除；credential 解析改 port）                         |
| service/funding 7 文件                                       | 重写                 | application/billing/funding/*（来源操作收 WalletTx 事务句柄）                            |
| service/channel-budget（release/deduct）                     | 重构并入             | ports/ChannelExposureStore + reserve-channel/settle 消费（U3 接线 deduct）               |
| repository/{billing-request,billing-reservation}.repo        | 重写                 | ports/billing-store + adapters/postgres（CAS/revision/乐观锁语义原样）                   |
| repository/subscription 额度三原语 + org-member 限额         | 重写                 | ports/funding-ports（SubscriptionQuotaStore）+ adapter（user_subscriptions/org_members） |
| repository/channel 敞口/扣减/熔断                            | 重写                 | ports/funding-ports（ChannelExposureStore）+ adapter（SQL 侧熔断判定保留）               |
| repository/credential.resolveSourceAndLimits                 | 不移植（跨能力事实） | ports/FundingSourceResolver——app assembly 桥接 accounts/identity（总纲 §5.2）            |
| repository/usage-log 读侧（sumSettledSpend）                 | 重写                 | billing-store（usage_logs 为 billing 投影；写侧随 U3）                                   |

## 4. 契约演进（引用 IMPLEMENTATION §3）

1. **事务句柄统一**：billing/wallet 两 store 的 tx 句柄同源于同一 DbTx——计费事务内
   把句柄注入钱包动词（TxChannel）实现跨 store 单事务（SAVEPOINT 隔离 + 瞬态重试）。
2. **跨能力解析 port 化**：凭证→订阅绑定/限额由 FundingSourceResolver 注入，
   billing 不回查 accounts 表（防环；总纲 §5.2）。
3. **死信家族按码判定**（§2）。
4. **casUpstreamStarted 重放语义确认**：authorized|in_flight 恒命中（重复事件
   changed=true 自然幂等）——与旧活路径一致。

## 5. 测试迁移矩阵

| 旧测试                                                                                                                                        | 新去处                                                              | 动作                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| rating 11 文件（pricing/calculate/amounts/coefficient/decode/receipt/measurement/pricing-strategy/reservation-strategy/attribution/fixtures） | rating-pricing/rating-receipt/rating-strategies + rating-fixtures   | 移植 + B2/B3 回归 ×5                             |
| billing gate-rules/settle-rules                                                                                                               | billing-rules                                                       | 移植（死信判定改码断言）                         |
| service wallet→billing/billing-limits 主干                                                                                                    | billing-authorize（authorize/signal/reserveChannel/admission 四组） | 改写（内存 stand-in）                            |
| service funding plan/registry（stub 零 DB）                                                                                                   | billing-funding + billing-authorize（瀑布切分）                     | 改写                                             |
| funding 来源 settle/release 分支（U3 接线前）                                                                                                 | billing-funding                                                     | 直驱来源锁死语义（#over 补扣/零额释放/守卫脱节） |

真实 PG：授权链的 CAS/advisory/守卫原子 UPDATE 竞态语义随 **U3 结算真实套件**统一
验证（同库同表族一次搭起）；本单元真 PG 不单独开文件（记录于收口清单）。

## 6. 回滚方案

U2a/U2b 各一提交可独立 revert；零 DDL（billing_requests 等表已在新仓 db 链）。

## 7. 验收（已核销 2026-08-23）

- U2a：四门全绿，154 用例（含 U1 的 81），覆盖率 96.19/90.65/97.83/97.99。
- U2b：四门全绿，183 用例，覆盖率 92.63/85.98/97.14/94.58；B2/B3/B6 回归通过。
- 行为对照：授权瀑布（PAYG/订阅切分/免费/重放/不足/日限/单请求上限）、
  signal 四事件（含竞态指纹幂等）、渠道三模式 + 预算拒绝、积压准入双分支。
