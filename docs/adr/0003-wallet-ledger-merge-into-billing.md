# ADR-0003: wallet + ledger-core 合并入 billing 的取舍

> 状态：Accepted（P4 资金波启动前置裁决，总纲 §3.5 必需 ADR 清单第 1 项）
> 日期：2026-08-23
> 关联：[project-structure-refactoring.md §3.2/§3.4/§9-P4](../project-structure-refactoring.md)、
> [packages/billing/DESIGN.md](../../packages/billing/DESIGN.md)、
> [packages/billing/IMPLEMENTATION.md](../../packages/billing/IMPLEMENTATION.md)

## 背景

旧仓（ai-getway）资金能力横跨五个一级 package，同族算法存在多份拷贝：

1. `packages/wallet`——自带 schema/DDL/迁移链的独立钱包引擎（约 3.6k 行，21 个动词/内核文件，
   25 个真实 PG 测试文件）。自称「业务无关、可整目录拎出独立仓复用」。
2. `packages/ledger-core`——幂等操作档案引擎（约 0.7k 行），含全仓最严格的 canonical 指纹实现。
3. `packages/domain/src/{wallet,billing,rating,subscription}`——纯函数领域定律（约 1.8k 行）。
4. `packages/service/src/{billing,wallet,funding,settlement,subscription}`——生产用例层（约 3.5k 行）。
5. `packages/repository` 资金 repo + `packages/db` schema/migrations（约 3.4k 行）。

2026-08-23 的全量审计（证据见 IMPLEMENTATION.md §1）确认：

- **生产写路径唯一**：apps 全部经 `service + repository + db` 写 wallet 四表；
  `packages/wallet` 引擎被三处架构测试列为禁入冻结包，生产唯一活性消费点是
  worker 对账任务的**只读**核验 `maintenance.verifyInvariants`。
- `ledger-core` 的 run 引擎同样被 `service/shared/operations.ts` 平行重写替代，
  生产仅剩 db 包 FK 引用其表定义。
- 真实的「双实现」形态是**同一算法的多份拷贝、一份存活**（指纹 ×3、money ×2+空壳、
  posting 定律 ×4、错误家谱 ×2），不存在生产同表双写冲突。

## 决策

1. **合并**：`wallet + ledger-core + domain/service/repository 的资金部分` 收敛为新仓
   `packages/billing`（唯一资金与计费事实源）。**牺牲** wallet 包自述的
   「业务无关、可整目录拎出独立仓」特性，换取资金能力内聚——该特性在旧仓已被
   架构测试实质否决（service 禁止 import 它，导致平行复刻而非复用），保留只会
   继续生产重复拷贝。
2. **以活路径为蓝本**：billing 的运行时语义以 `service + repository + db` 写路径为唯一
   行为基准；`packages/wallet` 引擎整体**不移植**，例外仅一项——`maintenance.ts` 的
   `verifyInvariants` 对账 SQL 重构迁入 billing 结算域（对账哨兵是生产活性行为）。
   其 25 个引擎专属 PG 测试不搬运，由活路径的边界测试按 §5.6「替换而不是叠加」重建。
3. **指纹统一为严格版**：三套指纹实现收敛为 `ledger-core/src/fingerprint.ts` 的严格
   canonical 语义（键码点排序、显式拒绝 undefined/NaN/Infinity/类实例/Date、深度与
   长度上限），落位 `billing/domain/fingerprint.ts`。宽松版（localeCompare 排序、
   静默丢 undefined、NaN→null 碰撞）废除——审计确认其存在重放顶替与跨环境指纹
   漂移两个真缺陷（B4）。
4. **金额唯一归 billing**：两套 money.ts 合并为 `billing/domain/money.ts`（超集语义）；
   旧仓空目录 `packages/money/` 的历史占位不再复现，金额构造、运算与序列化只存在于
   billing（总纲 §3.2 已裁决）。
5. **错误家谱收敛进目录**：wallet/domain 两套同名错误类废除，按 AGENT.md §11 经
   `defineErrorCatalog('billing', …)` 表达；跨包 instanceof 匹配（旧 B6 病灶）由
   nature/category 守卫取代。
6. **迁移链冻结确认**：wallet/ledger-core 的 provision/migrate 链不移植；DDL 唯一真源
   已经是 `packages/db/migrations`（0058/0059/0068/0069 完成收敛），billing 不携带任何
   自建迁移机制。

## 备选方案与取舍

| 备选 | 取舍 |
| --- | --- |
| 保留 wallet 为独立引擎包，billing 依赖消费它 | 否决——旧仓已实证此路不通：service 层为绕开它复刻了全部动词；「可拎出」特性八年无人消费，且引擎与活路径语义已出现漂移（如 collectOverage 只在活路径存在、分片只在引擎可达）。维持两份即维持 D1–D8 重复。 |
| 以 wallet 引擎为蓝本重写 service 语义 | 否决——引擎在生产零调用方，其行为未被生产验证（如 expiresAt 复查、billing 域耦合均以活路径为准）；以死码为基准重写活码是本末倒置，且引擎缺失 collectOverage 等 billing 必需能力。 |
| wallet 与 ledger-core 各自保留为 billing 的依赖包 | 否决——二者体量（3.6k/0.7k）与接口面（各 19/5 个错误类、自有迁移链）会形成两个永久浅边界；billing 内聚后其「复杂度隐藏价值」由包内 domain/application 分层承担。 |
| ledger-core 整包不移植（连指纹也重写） | 否决——其指纹实现是全仓唯一通过防顶替/防爆栈/防洪水测试的严格版本，重写无收益；按「基于语义重写」原则吸收其算法与测试规格。 |

## 影响

- 新仓 billing 包结构按总纲 §3 目标态落地（domain/application/ports/adapters + facade）。
- 旧仓 `packages/wallet`、`ledger-core` 在对应迁移单元核销后整包删除（大体量删除按
  铁律 8 开 issue 列清单等维护者确认）；`packages/money` 空目录直接删除。
- 旧仓 `domain/src/{wallet,billing,rating,subscription}`、
  `service/src/{billing,wallet,funding,settlement,subscription}`、资金 repo 随各垂直
  用例迁移单元逐个切换删除，禁止提前搬运或兼容转发。
- 审计发现的真缺陷（B1–B7）在对应迁移单元修复并各配回归用例；裁决/死码项（B8–B10）
  在 IMPLEMENTATION.md 登记归属。
- worker 对账任务从 `@ai-gateway/wallet/maintenance` 切换为 billing facade 的事件，
  在 apps 迁移波（P5）完成；billing 先以可测试的只读核验能力承接该语义。
