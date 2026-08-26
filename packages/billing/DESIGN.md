# @tillgate/billing 设计基线（DESIGN）

> 状态：定稿（随迁移单元实施推进；行为语义的唯一标准是代码，本文是导读与裁决记录）
> 裁决：[ADR-0003](../../docs/adr/0003-wallet-ledger-merge-into-billing.md)（wallet + ledger-core → billing 合并取舍）
> 施工图：[IMPLEMENTATION.md](./IMPLEMENTATION.md)（审计 / 裁决表 / 拆分 / 测试计划 / 实施顺序）
> 上位文档：[project-structure-refactoring.md](../../docs/project-structure-refactoring.md) §3/§5/§9-P4

---

## 1. 定位

billing 是**唯一资金与计费事实源**（总纲 §3.4）：金额、钱包、双分录账本、计价、订阅、
支付、兑换、结算与恢复的领域定律与用例编排全部住在本包。表定义与 DDL 住
`@tillgate/db`（billing 的 adapters 消费其 schema 与事务设施）；费率卡/渠道配置的
管理面住 control-plane，billing 只消费只读快照。

依赖方向（总纲 §5.1）：

```text
billing/domain    ← 仅 @tillgate/errors + 纯计算依赖（decimal.js）；零 I/O、零框架
billing/application ← 本包 domain/ports；不直接 import pg/drizzle/Redis/Hono
billing/adapters  ← 本包 ports、@tillgate/db、@tillgate/runtime、外部 SDK（stripe/epay）
```

## 2. 外部契约

### 2.1 形态

- 根入口导出 `createBilling` facade、command/result 类型、领域错误目录、必要值类型，
  以及 ports 契约类型（`WalletStore`/`BillingStore`/`PaymentOrderStore` 等——`WalletConn`
  为 opaque 品牌类型，签名零 `Db/DbTx` 泄漏）与各用例工厂（`createWalletApi` 等，供
  worker 单元消费）；不导出 repository、adapter、供应商 SDK 类型（总纲 §5.3；
  实际导出面由 `__test__/architecture.test.ts` 快照锁死）。
- `./wallet`、`./settlement` 窄子入口在对应迁移单元就绪后开放（供 worker 等单一职责
  消费方避免拉入全量 facade）。
- 事务边界属于发起状态变化的 application 用例；`DbTx` 不出现在任何公开签名
  （总纲 §5.4）。旧仓的 `TxInjection`（调用方共享事务）语义收编为 application 内部
  组合（billing 用例内部在单事务内编排 wallet 动词），不再对外暴露。
- 参数平铺不嵌套、结果判别联合、可选参数全部有缺省（AGENTS.md §9.1 步骤 1）。

### 2.2 金额契约（全包唯一，外部消费方同样遵循）

1. 金额一律**字符串十进制、「元」为单位**（major units）；运算用
   `billing/domain/money` 的 `Decimal`（precision 40，独立构造器不污染宿主全局配置）。
2. **账本永不 round**：全精度参与余额与流水；DB 落库 `numeric(38,18)`。
3. 禁科学计数法落库（PG numeric 不接受 `1e-18`）；`isValidAmountString` 是落库前防线。
4. 指纹/幂等比对的金额输入必须先经 `normalizeAmount` 规范化（`'10'` 与 `'10.000'`
   视为同一命令）。
5. 金额构造的唯一入口是 `parsePositiveAmount` / `parseNonNegativeAmount`；
   负数/NaN/Infinity/科学计数法/超尺度（>18 位小数、>20 位整数）结构性拒绝。
6. **派生支付额跨落库边界必须显式收敛**（单一真相：`domain/commission`）：
   由乘法派生、要进账本的支付额（邀请佣金 = 日合计 × 费率）在进入
   `parsePositiveAmount` 前按 **18 位小数 ROUND_FLOOR** 收敛。floor 只会少付
   不会多付（差额 ≤ 1e-18 元，低于落库尺度不可表示）；「账本永不 round」
   约束的是**账本内加减运算**，不能推出「派生额可带着 >18 位小数去撞落库
   防线」——撞上即 `out_of_scale` 永久拒绝、幂等自然键建不出来（2026-08-25
   审计复核 #5：该形态曾致邀请人当日佣金永久丢失）。floor 到 0 的尘埃额
   由调用方按非正数跳过。

### 2.3 指纹契约（全包唯一）

幂等命令指纹一律经 `billing/domain/fingerprint`：键按码点排序（与 locale 无关）、
数组保序、`-0` 归一为 `0`、**非 JSON 安全值（undefined/NaN/Infinity/bigint/symbol/
function/Date/类实例）显式拒绝**、嵌套深度 ≤64、canonical 总长 ≤1MB。拒绝时抛
`DefectError`（载荷构造缺陷，不重试、细节只进日志）——外部可控长度（memo 等）必须在
进入指纹前由校验层先行截断。

### 2.4 错误契约

按 AGENTS.md §11：本包 domain/application 的业务拒绝经
`defineErrorCatalog('billing', …)` 表达（`business()` 直抛，需要精确捕获处用 `entry()`
固化类）；禁止自造错误类体系或自由字符串码。捕获方按 nature/category 分派，
**不做跨包 instanceof**（旧仓 B6 病灶：两套同名类永不互配）。基础设施故障用
`@tillgate/errors` 的 `InfrastructureError`（码如 `billing.postgres`），不变量破坏用
`DefectError`。

### 2.5 状态机（迁移自旧仓活路径，语义不变）

- **钱包授权**：`active → settled（0 < settled ≤ amount）| released | expired`；
  结算/释放互斥由 CAS + 唯一终态保证；`expires_at` 是结算的权威截止（数据库时钟复查）。
- **计费请求**：`authorized → in_flight → settlement_pending → processing →
(settled | retry_wait ⇄ processing | dead) | released`；`revision` 兼作 worker fencing。
- **支付单**：`created → paid → credited`，`expired` 为关单标记（非资金事实，可复活）。
- **订阅**：`有效(0) → 到期(1) / 取消(2)`；每用户/组织单有效订阅（部分唯一索引）。
- **兑换码**：`未用(0) → 已核销(1) / 已吊销(2)`；核销与入账同事务。

## 3. 内部问题域（处理 / 不处理）

**处理**：金额值对象与规范化；命令指纹；钱包账户/冻结/授权/结算/释放/退款/转账/授信；
双分录过账定律与链式余额；计价（计量→定价策略→预扣策略→收据验收→结算分摊）；
资金来源瀑布（订阅 → PAYG，超额补扣 `#over` 负余额路径）；每日限额与订阅可用性闸；
结算认领/结算/失败退避/死信/滞留恢复；对账核验（只读不变量扫描）；订阅开通/续费/
变更/取消/加油包；充值支付单两跳 CAS + 渠道回调核销；兑换码批次与核销；usage 投影。

**不处理**（写清归属，不留白）：

| 不处理项                     | 归属                                                             |
| ---------------------------- | ---------------------------------------------------------------- |
| 通知投递（入箱后）           | `notifications` 包；billing 经 port 在**同一事务**写 outbox 事实 |
| 费率卡/汇率配置管理与 CRUD   | `control-plane`；billing 只消费只读快照并保存实际采用的报价快照  |
| 用户/组织/API Key 资料与关系 | `accounts`；billing 只接收 `userId/orgId` 等标识                 |
| 渠道熔断/死凭据健康状态      | `inference`（订阅 AiEvent 维护）；billing 只收结算事实           |
| 上游协议/传输                | `ai` 包；billing 不接触模型上游                                  |
| HTTP wire schema / 队列协议  | 各 app 的 contracts；billing 零 HTTP/队列依赖                    |
| 表 DDL 与迁移顺序            | `@tillgate/db`（billing 语义变化需要 DDL 时同一迁移单元提交）    |

## 4. 并发与性能预算（数字化硬约束）

1. **事务重试**：40P01/40001 自动重试 ≤5 次，退避 `15×2^attempt + rand(0..20)ms`
   （`@tillgate/db` runTx 语义；迁移自旧仓活路径与 ledger-core 共同口径）。
2. **锁定序**：多账户写按账户 id 升序 `SELECT … FOR UPDATE`（全局定序防死锁）；
   认领用 `FOR UPDATE SKIP LOCKED`；对账哨兵用 advisory lock 单副本。
3. **幂等三重**：唯一索引（并发兜底）+ CAS 状态迁移 + 命令指纹（同键异参拒绝）。
   并发同键恰好一次由唯一索引保证，输家走重放读回首答回执。
4. **热路径零同步结算**（铁律 12）：推理请求的落账走 `signal → outbox/wakeup →
worker 结算`，授权阶段只冻结不动余额；观察 tap 丢失由结算恢复/对账兜底，
   禁止用热路径同步结算换确定性。
5. **金额运算**：precision 40 覆盖 numeric(38,18) 全尺度加减不丢位；零 round 调用
   （架构测试锁死）；1e-18 级金额定点表示（禁科学计数法）。
6. **指纹**：深度 ≤64、总长 ≤1MB；超限即拒（防爆栈/洪水），不做静默截断。
7. **结算事务**：认领租约由 `renewClaims` 保活；毒行逐单事务隔离（单行故障不阻塞
   队列）；P99 慢结算的锁持有与保活频率匹配在 apps/worker 迁移时压测复核（待办）。

## 5. 文档与实施

- 迁移单元划分、逐模块裁决、B#/D# 登记与测试矩阵见 [IMPLEMENTATION.md](./IMPLEMENTATION.md)。
- 每个迁移单元一份 MIGRATION-U#.md（行为规格基线 / 测试迁移矩阵 / 回滚 / 验收）。
- 旧仓路径：`/Users/wrr/work/ai-getway`（审计与行为语义的证据源）。
- U6（管理读侧面）：plans 目录 CRUD/订阅管理列表/兑换批次管理/死信单笔复审——
  admin-api 消费的 facade 组与独立 `createRedeemBatchApi`；明文码生成器注入（不 import http）；
  死信 abandon 三路归还复用 U3 releaseAllReservations；规格见 MIGRATION-U6.md。

## 增量：authorize 快路径（2026-08-26 定稿；F-2 根治——live-fire 红队压测发现）

> 动机与方案全文见 IMPLEMENTATION.md「增量：authorize 快路径」。
> 契约变化两条：① wallet.authorize 的资金门从「SELECT FOR UPDATE + 内存守卫
> + 过账」三段改为**单语句原子条件占用**（守卫口径进 WHERE，锁窗口 =
> UPDATE→commit）；② billing authorize 的 per-user advisory 串行**按需获取**
> ——仅每日限额（user/key 任一）非 NULL 时取（SUM 口径需要），默认路径跳过。
> 订阅 reserve（tryReserveQuota）与钱包门自身条件安全，probe 过期由守卫输家
> 干净回滚兜底（语义等价）。不变量基线零变化：deferred coherence、恰好一次、
> 幂等三段式、失败零扣费全保留（验收 = wallet-invariants/wallet-contract
> real 测试 + live-fire 81/81）。

