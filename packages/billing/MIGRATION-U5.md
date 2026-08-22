# U5 支付与兑换迁移文档

> 状态：已核销（默认门禁 234 用例；验收数字见 §7）
> 迁移单元：充值支付（下单/回调入账/关单/复活）+ 兑换码（批次/核销/入账同事务）
> 旧实现：`apps/client-api/src/services/{payments,redeem}.service.ts` + `apps/client-api/src/domain/{topup,epay,stripe}.ts` + `repository/src/{payment-order,redeem-batch,redeem-code}.repo.ts`
> 目标位置：`domain/payment/*` + `ports/payment-ports` + `adapters/{payments/providers,postgres/payment-stores}` + `application/{payments,redemption}`
> 关联：IMPLEMENTATION §2 U5、ADR-0003

## 1. 行为规格基线

旧测试：client-api 支付/兑换服务测试（app 层）——以新能力包测试锁定主干
（协议规则直测 + 下单/回调/复活/回退锚 + 兑换语义区分 + 频率闸）。

## 2. 逐模块裁决表

| 旧模块 | 裁决 | 动作 |
| --- | --- |
| client-api domain/{topup,epay,stripe}（协议纯规则） | 复制+微修 | domain/payment/*（AppError → 目录；语义原样：恒定时间比较/重放窗/三闸事件归一/两位小数面额闸） |
| payments.service（createTopupOrder/handleNotify/orderDetail/listOrders/channels） | 重写 | application/payments（从 app 下沉能力包；RunContext/AppError → port/目录；先落库再调渠道/复活/回退锚资损不变量原样） |
| redeem.service（redeem/history） | 重写 | application/redemption（核销 CAS 与入账同事务；频率闸 fail-closed） |
| repository/{payment-order,redeem-*}.repo | 重写 | ports/payment-ports + adapters/postgres/payment-stores（状态机 CAS 原样；批次 total 必填） |
| PaymentProviderPort + epay/stripe 适配 | 重构迁入 | adapters/payments/providers（fetch 注入可测；无 SDK 依赖） |

## 3. 契约演进

1. AppError（app 层 HTTP 错误）→ billing 目录 12 新键（支付/兑换族）；
   HTTP status 由 app face 按 category 渲染。
2. 频率闸抽为 RateCounterPort（Redis 实现归 runtime 装配；不可达 fail-closed 语义保留）。

## 4. 测试迁移矩阵

| 旧测试 | 新去处 | 动作 |
| --- | --- | --- |
| client-api payments 服务测试主干 | payments.test（内存 provider + store） | 改写：下单回填/金额核对/重复回调幂等/渠道失败关单/过期复活/回退锚/频率闸/多渠道 |
| client-api redeem 服务测试主干 | payments.test（兑换组） | 改写：语义四分（无效/已用/吊销/过期）+ 同事务原子性 + 历史 |
| domain/{topup,epay,stripe} 规则测试 | payments.test（协议规则组） | 改写直测 |

真实 PG（payment_orders 唯一约束竞态/兑换码并发同码）随收口真 PG 套件或 apps 迁移波验证
（记录于 IMPLEMENTATION 收口清单）。

## 5. 回滚方案

单提交可 revert；零 DDL。

## 6. 验收（已核销 2026-08-23）

- 默认门禁 234 用例，覆盖率 93.62/85.15/97.98/95.55；四门全绿。
- 资损不变量逐项：creditAmount 创建定死、验签+金额双闸、单事务 markPaid→credit→
  markCredited、幂等锚 topup/orderId 与 redeem/code:{id}、先落库再调渠道、过期复活、
  回退锚不认领他人会话、兑换核销与入账同事务。
