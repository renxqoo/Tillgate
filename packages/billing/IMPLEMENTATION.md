# @tokenlens/billing 施工图（IMPLEMENTATION）

> 状态：实施中（U0–U5 已核销；收口 facade 进行中——见 MIGRATION-U5.md）
> 设计基线：[DESIGN.md](./DESIGN.md)；合并裁决：[ADR-0003](../../docs/adr/0003-wallet-ledger-merge-into-billing.md)
> 旧仓：`/Users/wrr/work/ai-getway`（下称旧仓；审计时点 2026-08-23，行号以当日 HEAD 为准）

---

## 1. 审计结论（§9.1 步骤 2 产出，2026-08-23 三路并行审计）

### 1.1 核心事实（修正总纲 §2.2「资金双实现」的表述）

- **生产写路径唯一**：四个 apps 的全部资金动词经
  `service/src/{billing,wallet,funding,settlement,subscription}` +
  `repository/*.repo.ts` + `db` schema 落库。`packages/wallet` 引擎
  （`createWallet(db, options)`）生产零调用方——被 `service` 架构测试列为禁入包
  （`service/src/__tests__/architecture.test.ts:17-24`），apps 侧列为冻结包
  （`apps/{client-api,admin-api}/src/__tests__/architecture.test.ts:34/37`）。
- `packages/wallet` 生产唯一活性消费点：`apps/worker/src/tasks/reconcile.ts:9` 的
  `createWalletMaintenance(db).verifyInvariants()`（**只读**对账核验）。
- `ledger-core` 的 run 引擎被 `service/src/shared/operations.ts:33-60` +
  `repository/operations.repo.ts` 平行重写替代；生产仅剩 `db/src/schema/payments.ts:15`
  FK 引用其表对象。`ledger-core` 的 `fingerprint.ts` 是全仓唯一通过防顶替/防爆栈/
  防洪水测试的严格指纹实现。
- **不存在生产同表双写**。「双实现」的真实形态：同一算法多份拷贝、一份存活
  （详见 D1–D9）。若把 wallet 引擎当活码迁入才会制造真双写（ADR-0003 决策 2）。

### 1.2 真 bug 登记（B#；迁移时修复，每条一个回归用例，§10.1）

| #   | 症状                                                                                                                                                                                                                | 旧仓位置                                                                                                                             | 状态                                                     | 修复单元                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------- |
| B1  | credit-line 幂等竞态兜底跳过指纹校验——并发同键异额的输家把自己的输入当回执返回，回执撒谎                                                                                                                            | `service/src/wallet/credit-line.ts:78-81`                                                                                            | 实测确认                                                 | U1                                                       |
| B2  | `calculateRequired` 组装预估时漏传 `cacheWritePrice`，`estimateMaxCost` 的贵价口径被击穿——cacheWrite 价高于输入价时授权金额低于保守上界（Anthropic 1.25×/2× 场景真实可达）                                          | `domain/src/rating/calculate.ts:69-78`（对照 `pricing.ts:82-103`）                                                                   | 实测确认（单测只直测了 estimateMaxCost，未覆盖组装路径） | U2                                                       |
| B3  | `decodeReceipt`/`validateReceipt` 用 `new Decimal(垃圾串)` 会抛 decimal.js 异常，逃逸出毒收据家族——死信判定失手，被误分类为瞬态错误空耗重试                                                                         | `domain/src/rating/decode.ts:29`、`receipt.ts:43-47`                                                                                 | 实测确认                                                 | U2                                                       |
| B4  | 宽松指纹 canonical 的两个缺陷：① `JSON.stringify` 把 NaN/Infinity 归 null → `{a:NaN}` 与 `{a:null}` 同指纹（重放顶替温床）；② 键排序用 `localeCompare`，跨 locale/ICU 结果不稳定 → 同参数不同环境指纹漂移（假 409） | `domain/src/wallet/fingerprint.ts:18,27` = `wallet/src/idempotency.ts:13,23`（对照严格版 `ledger-core/src/fingerprint.ts:40-42,80`） | 实测确认                                                 | U0（统一为严格版，结构性消灭）                           |
| B5  | authorize 重放路径返回 DB 原串金额未规范化——首调得 `'10'`、重放得 `'10.000000000000000000'`，字符串比较消费方行为漂移                                                                                               | 引擎侧 `wallet/src/authorize.ts:56,122` 实测确认；**活路径 `service/src/wallet/authorize.ts` 待对照**                                | 实测确认（引擎）/ 待审计（活路径）                       | U1（迁移时以测试锁死：重放回执金额必须 normalizeAmount） |
| B6  | `ReservationError` 双类无继承关系（`extends WalletError` vs `extends Error`），跨包 instanceof 永不匹配；wallet 版全仓零消费                                                                                        | `wallet/src/errors.ts:239-245` vs `domain/src/rating/pricing.ts:115,133-139`                                                         | 实测确认                                                 | U2（目录统一，废除双类）                                 |
| B7  | 引擎 transfer 内部科目出账错误文案带 `user 0`，误导定位                                                                                                                                                             | `wallet/src/transfer.ts:74`（引擎侧；活路径对照待审计）                                                                              | 实测确认（引擎）/ 待审计（活路径）                       | 随 D9 不移植；U1 实现时错误 context 不携带误导用户号     |

### 1.3 裁决/死码/迁移中新发现登记（B8–B13）

| #   | 事项                                                                                                                                                       | 裁决                                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| B8  | `reconcile_discrepancies` 表零写入方（worker 对账实际写 `notify_outbox`），表注释与实现脱节                                                                | 表已随 db 链存在于新仓（DDL 不动）；billing 只读核验不写该表；是否补写入或删表在 apps/worker 迁移单元（P5）裁决                     |
| B9  | 引擎分片能力（0–255）在活路径钉死 shard 0（`repository/wallet.repo.ts:98-116`）                                                                            | 活路径语义唯一：shard 恒 0；`sharding.ts` 不移植；唯一键 `(code,currency,shard)` 保留（DDL 冻结），实现注释固化「分片保留位未启用」 |
| B10 | 计费授权重放对终态单（released/settlement_pending）抛 409——有意防重放还是缺陷需结合 gateway 重试策略                                                       | 待审计：apps/gateway 迁移单元（P5）对照 pipeline 重试层后裁决；U2 迁移时先保留现语义并测试锁死                                      |
| B11 | 「按 id 定序锁定防死锁」在引擎与活路径均无显式 ORDER BY——定序实际依赖 PK 索引扫描顺序的实现细节（U1b 复读发现）                                            | 已修：adapter `lockAccounts` 显式 `ORDER BY id`（MIGRATION-U1 §4）；死锁竞速测试通过                                                |
| B12 | refund 重放回执返回带符号腿金额（`'-2'`），与首笔正号命令金额（`'2'）不一致——replayLegged 对 credit 恰好无恙、refund 暴露（U1b 契约测试实测发现；B5 同族） | 已修：replayLegged 回执改回命令金额（MIGRATION-U1 §4）；内存与真 PG 回归各一                                                        |
| B13 | 旧活路径 release 经 lockActiveAccounts 对冻结账户直接拒绝 → 风控冻结后 in_flight 永久占用；引擎版刻意容忍（释放预占不动资金）（U1b 契约测试实测发现）      | 已修：release 改裸锁容忍冻结（settle 保持拒绝——引擎 security 语义）；真 PG 回归一                                                   |

### 1.4 重复代码登记（D#）

| #   | 重复                                                                                                                                     | 收敛                                                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| D1  | 指纹 ×3：`ledger-core/fingerprint.ts`（严格）、`domain/wallet/fingerprint.ts`、`wallet/idempotency.ts`（后两份逐行同、宽松）             | `billing/domain/fingerprint.ts` 唯一（严格版语义）                                                       |
| D2  | money ×2 + 空壳：`domain/wallet/money.ts`（超集）、`wallet/money.ts`（子集）、空目录 `packages/money/`                                   | `billing/domain/money.ts` 唯一（超集语义）                                                               |
| D3  | posting 定律 ×4：`domain/wallet/posting.ts`（纯校验）、`wallet/posting.ts`（写入口内嵌）、`service/wallet/posting.ts`（编排）、DB 触发器 | 定律唯一住 `billing/domain/wallet/posting.ts`；application/adapters 复用；DB 触发器兜底保留（db 链不动） |
| D4  | 敞口守卫 ×2：`domain/wallet/account.ts` ≡ `wallet/exposure.ts`                                                                           | `billing/domain/wallet/exposure.ts` 唯一                                                                 |
| D5  | 错误家谱 ×2 + 科目常量 ×2 + 白名单守卫 ×2                                                                                                | `billing` 错误目录唯一；常量/词表唯一住 domain                                                           |
| D6  | 表定义副本：`wallet/src/schema.ts` vs `db/src/schema/wallet.ts`（drizzle）；DDL 双链（wallet 5 版 vs db 0058/0059/0068/0069）            | db 链唯一（已收口）；wallet 侧不移植                                                                     |
| D7  | operationId 契约 ×2：`ledger-core/validation.ts` vs `domain/shared/operation-id.ts`                                                      | `billing` 目录 + domain 词表唯一                                                                         |
| D8  | 幂等 run 引擎 ×2：`ledger-core/operations.ts` vs `service/shared/operations.ts` + `repository/operations.repo.ts`                        | 迁移活路径语义；吸收 ledger-core 的 16KB 回执上限与 kinds 白名单加固（U2）                               |
| D9  | 引擎整包死码（21 文件 + 25 测试）                                                                                                        | 不移植；例外：`maintenance.ts` verifyInvariants 对账 SQL 重构迁入（U3）                                  |

## 2. 逐模块裁决表（§9.1 步骤 3）

| 旧仓模块                                                                                                                     | 裁决                                                               | 去处 / 动作                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `domain/wallet/money.ts` + 测试                                                                                              | 复制+微修（超集胜出；错误改目录表达）                              | U0 → `billing/domain/money.ts`                                                       |
| `ledger-core/fingerprint.ts` + 测试                                                                                          | 复制+微修（严格版胜出；DefectError 分类）                          | U0 → `billing/domain/fingerprint.ts`                                                 |
| `domain/wallet/{fingerprint,posting,account,authorization,accounts,guards,errors}.ts`                                        | 重构（定律保留，指纹换严格版，错误进目录）                         | U1 → `billing/domain/wallet/*`                                                       |
| `service/src/wallet/*`（15 文件）+ `repository/wallet.repo.ts`                                                               | 重写（基于语义：动词编排改 application，SQL 改 adapters/postgres） | U1 → `billing/application/wallet/*` + `billing/adapters/postgres/wallet*.ts`         |
| `domain/billing/*`（reservation/settle-allocation/settle-failure/daily-limit/daily-window/subscription-availability/errors） | 复制+微修（修 B3 涉及的 decode/receipt 在 rating）                 | U2 → `billing/domain/billing/*`                                                      |
| `domain/rating/*`（14 文件 + fixtures）                                                                                      | 复制+微修（修 B2、B3、B6）                                         | U2 → `billing/domain/rating/*`                                                       |
| `service/src/billing/*` + `repository/{billing-request,billing-reservation}.repo.ts`                                         | 重写（活路径语义；修 B5 若活路径同样存在）                         | U2 → `billing/application/billing/*` + adapters                                      |
| `service/src/funding/*`                                                                                                      | 重写（来源瀑布；PAYG/订阅两 source）                               | U2 → `billing/application/billing/funding/*`                                         |
| `service/src/shared/operations.ts` + `repository/operations.repo.ts`                                                         | 重写（吸收 D8 加固）                                               | U2 → `billing/application/billing/operations.ts` + adapters                          |
| `service/src/settlement/*` + `repository/usage-log.repo.ts`                                                                  | 重写（认领/结算/恢复/投影）                                        | U3 → `billing/application/settlement/*` + adapters                                   |
| `wallet/src/maintenance.ts`（verifyInvariants 只读 SQL）                                                                     | 重构迁入（对账核验）                                               | U3 → `billing/application/settlement/reconcile.ts`                                   |
| `domain/subscription/*` + `service/src/subscription/*` + `repository/{plan,subscription}.repo.ts`                            | 复制+微修 / 重写                                                   | U4 → `billing/domain/subscription/*` + `application/subscriptions/*`                 |
| `apps/client-api/services/payments.service.ts` + `repository/payment-order.repo.ts`                                          | 重写（从 app 下沉到能力包；stripe/epay 经 ports）                  | U5 → `billing/application/payments/*` + `ports/payment/*` + `adapters/{stripe,epay}` |
| `apps/client-api/services/redeem.service.ts` + `repository/{redeem-batch,redeem-code}.repo.ts`                               | 重写（同上）                                                       | U5 → `billing/application/redemption/*`                                              |
| `repository/fx.repo.ts`、`rate-card.repo.ts`、`rating.repo.ts`                                                               | 不移植（配置管理面）                                               | 归 control-plane（P4-2 波）；billing 只消费只读快照（U2 经 port 注入）               |
| `packages/wallet` 其余全部（动词引擎/schema/migrations/migrate-cli/sharding/telemetry/testing/idempotency…）                 | 不移植（D9 死码；B7 随之消灭）                                     | —                                                                                    |
| `packages/ledger-core` 其余（operations/ledger/schema/migrate-cli）                                                          | 不移植（D6/D8；指纹已单列吸收）                                    | —                                                                                    |
| 空目录 `packages/money/`                                                                                                     | 不复现                                                             | —                                                                                    |

## 3. 拆分决策（§9.1 步骤 4；每条引用审计证据）

1. **domain 零 I/O**：wallet 引擎的「schema+动词一体」形态不保留——定律（posting/
   exposure/authorization/词表）进 domain，SQL 全部进 `adapters/postgres`（总纲 §5.1；
   证据 D3/D4/D6：一体形态在旧仓直接导致了 service 平行复刻）。
2. **动词一文件**（AGENT.md 铁律 5）：credit/authorize/settle/release/refund/transfer/
   credit-line/freeze 各一文件，编排壳一个文件——沿用旧仓活路径的文件切分
   （`service/src/wallet/` 已是此形态）。
3. **application 内部共享事务**：旧仓 `TxInjection` 对调用方开放的能力收编——billing
   用例（如计费授权→钱包冻结）在 application 内单事务编排，facade 不暴露 tx
   （DESIGN §2.1；总纲 §5.4）。
4. **对账只读**：verifyInvariants 保持纯 SELECT 语义；差异告警的 outbox 写入是
   worker（消费方）的职责，billing 不拥有通知副作用（总纲 §3.4 通知行；证据 B8）。
5. **`#over` 补扣与负余额**：PAYG 超额与纯订阅链超额走 `authorize#over +
settle#over`（允许负余额）——活路径独有语义，引擎版无此能力（审计一 §7 证据），
   迁移时以契约测试锁死。
6. **余额更新风格二象性保留**：钱包腿 = 锁 + 读改写 + 触发器兜底；订阅/渠道额度 =
   单语句守卫原子 UPDATE。两种并发正确性论证不同，禁止「统一重构」误伤
   （审计三 §8 迁移裁决建议 4）。

## 4. 测试计划（§9.1 步骤 5）

- **旧测试 = 行为规格**，逐文件迁移矩阵在各单元 MIGRATION-U#.md；本节只记总原则。
- 资金边界测试**必须打真实 PostgreSQL**（总纲 §5.6 类别 2）：并发（同键恰好一次、
  不超卖、CAS 竞态）、幂等（重放回执全等、同键异参 409）、恢复（滞留回收、租约过期、
  毒行隔离）、对账（verifyInvariants 三类漂移）。
- 纯 domain（money/fingerprint/posting 定律/exposure/计价）零 I/O 直测。
- 每个 B# 一个回归用例，用例名注明编号与症状（AGENT.md §10.1）。
- 引擎 25 个 PG 测试不搬运（D9），但其**不变量断言清单**（Σ腿=0、链恒等、
  in_flight 投影、账本不可变、冻结拒动）在新契约测试中逐项重现——不变量本身
  是 DB 触发器 + 活路径共同维护的生产事实。
- 覆盖率 90/90/90/85 进 vitest thresholds（AGENT.md §10.3）。

## 5. 实施顺序（每单元独立提交 + 四门全绿 + 可独立回滚）

| 单元 | 内容                                                                                                                                                        | 前置     | 状态                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------- |
| U0   | 包骨架 + `domain/money`（D2 收敛）+ `domain/fingerprint`（D1/B4 收敛）+ 错误目录初始条目                                                                    | ADR-0003 | 实施中                                              |
| U1   | 钱包垂直：domain/wallet 定律 + application/wallet 动词 + adapters/postgres + 真实 PG 契约/并发/幂等测试（修 B1；锁死 B5 重放规范化）                        | U0       | 待办                                                |
| U2   | 计价与授权链：domain/{rating,billing} + application/billing（authorize/signal/admission/reserve-channel + funding 瀑布 + operations 幂等壳）（修 B2/B3/B6） | U1       | 实施中（U1a 已核销：56 用例/96.47-95.65-100-96.92） |
| U3   | 结算与恢复：application/settlement（claim/settle/process/recover/usage-projection）+ 对账核验迁入（D9 例外）                                                | U2       | 待办                                                |
| U4   | 订阅：domain/subscription + application/subscriptions                                                                                                       | U2       | 待办                                                |
| U5   | 支付与兑换：application/{payments,redemption} + ports/payment + adapters/{stripe,epay}                                                                      | U4       | 待办                                                |
| 收口 | facade `createBilling` 全量冻结 + `./wallet`、`./settlement` 子入口 + README                                                                                | U5       | 待办                                                |

U0–U5 全部核销后：旧仓对应模块整包删除清单开 issue（铁律 8）等维护者确认。

## 6. 与上位文档的同步承诺

- 实现推翻设计时同一提交先改文档（铁律 13）；B5/B10 的「待审计」项结论出来当轮回写本表。
