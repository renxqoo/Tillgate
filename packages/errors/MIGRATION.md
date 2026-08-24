# @tokenlens/errors 迁移文档（MIGRATION.md）

> 状态：已完成（含 D8/D9 演进：品牌绑定构造、JSON 值上下文 + 传播注记；四门全绿，
> 收口轮 60 用例全绿、覆盖率 100% 四项——git `8643dfb`；本包根契约就位后的消费者侧
> 消解逐片在各迁移单元验收，见 §7 待核销）
> 迁移单元：错误根契约包的**落地**——三性根类 + category 闭集 + 命名空间目录契约 +
> 规范化记录 + 守卫（「按消费者切片」的第一片，只落地根契约本身；http 重组、db pg-error、
> 能力包家谱、face 装配分别属于各自迁移单元，不在此处预建）
> 旧实现：v1 **无独立 errors 包**——错误体系散置于旧仓 `ai-getway`：
> `packages/http` 错误族 3 文件 426 行（error-codes.ts 258 行 151 码集中注册表 +
> errors.ts 141 行 HttpError/errorHandler + flow-error.ts 27 行死代码）、
> 三个 app 的 `src/http/error-map.ts`（325 行：AppError 类 ×3 漂移拷贝 + 翻译表）、
> domain/identity-core/wallet/ledger-core/identity 的 errors.ts 家谱 10 文件 923 行；
> 方案文档 `ai-getway/docs/error-system-design.md`（328 行，「设计定稿待评审」，未实施）
> 目标位置：`/Users/wrr/work/TokenLens-v2/packages/errors`
> 关联：[DESIGN.md](./DESIGN.md)、[IMPLEMENTATION.md](./IMPLEMENTATION.md)（缺陷编号 **E#**
> 出处——本包审计用 E# 系列，无 B#/D# 编号）、[ADR-0001](../../docs/adr/0001-errors-registry-ownership.md)
> （注册表归属与 D1-D9 裁决）、AGENT.md §11（谁必须用/谁禁止用）

## 1. 行为规格基线

v1 无独立包，行为规格锚点是**错误族测试的不变量**（IMPLEMENTATION §2「正面资产」）：

| 旧测试（文件 → 用例数）                               | 内容                                            |
| ----------------------------------------------------- | ----------------------------------------------- |
| domain/wallet `error-contract.test.ts`（4 例，56 行） | instanceof/name/code 非空/包内唯一/结构字段存活 |
| identity-core `error-contract.test.ts`（3 例，56 行） | 同上（21 类家谱）                               |
| ledger-core `error-contract.test.ts`（3 例，38 行）   | 同上                                            |
| wallet `error-contract.test.ts`（1 例，74 行）        | 同上                                            |
| http `error-registry-grading.test.ts`（5 例）         | 注册表分级纪律守卫                              |
| http `error-locale.test.ts`（8+6 例）                 | 大小写/本地化回退（E7/E8 病灶面）               |

**显式删除/改判的用例**（机制已裁决移除 ≠ 功能缺失；裁决出处 IMPLEMENTATION §5）：

- `error-locale`（8+6 例）不移植——语言**选择**归 face，本包无 locale 逻辑（目录定义
  的 message/zh 双字段是本包职责，双语选择不是）。
- `error-registry-grading`（5 例）不移植——分级纪律由 category 闭集结构保证
  （status 从 category 派生），face 装配后的守卫随 P5。
- `errors.test.ts` 的 errorHandler/信封段（7 例）→ 归 http 迁移单元；
  `pg-error-translation`（8 例）→ 归 db 迁移单元（本轮已在各单元落地，非孤儿）。

v2 全部测试为**新写**（8 文件：nature / annotate / category / definition / error-record /
normalize / boundary / guards），用例矩阵见 IMPLEMENTATION §5。

## 2. 审计结论（引用 IMPLEMENTATION.md §2，编号 E#）

- **影响本单元的缺陷**（E1-E13，证据均逐行核验）：E1 四套错误模型并存、E2 25+ 未登记
  出站码 + 影子码遮蔽、E3 client/admin 同名表六处漂移、E4 静默 500 洗白、E5 `wallet_unmapped`
  甩锅 4xx、E6 跨包 code 冲突、E7 大小写同码不同义、E8 zh 本地化结构性失效、E9 message 即 code、
  E10 领域层 HTTP/i18n 知识、E11 ai duck-typed 错误、E12 name 赋值分叉、E13 死件/幻影/隐式默认。
  本包范围内被结构性消解的：E2/E3/E6/E7/E8/E9/E12/E13（D8 之后 E2/E8/E9 升级为编译期封闭）；
  消费者侧残留（三 app error-map、http 注册表、ai classify）的消解在各自迁移单元验收（§7）。
- **契约演进**（ADR-0001 D 系列）：D8 品牌绑定构造（BusinessCode 品牌类型 + `entry()` 绑定
  三元组，自由字符串编译期拒绝）、D9 JSON 值上下文 + `annotate()` 实例稳定传播注记 +
  类型化通道边界 ruled out（目录即 throwable-codes 声明面）。

## 3. 逐模块裁决表

| 旧文件/机制                                             | 裁决           | 审计状态   | 动作                                                                |
| ------------------------------------------------------- | -------------- | ---------- | ------------------------------------------------------------------- |
| 三性/category 根契约概念（v1 error-system-design §4.1） | **重构移植**   | 方案文档   | `nature.ts` + `category.ts`（v1 定稿方案在 v2 首次落地）            |
| `http/src/error-codes.ts`（151 码注册表）               | 不移植整体     | E2/E7      | 按域拆归能力包目录（`defineErrorCatalog`），face 装配合成           |
| `http/src/errors.ts`（HttpError/errorHandler/信封）     | 重构           | E1/E13     | 归 http 迁移单元（category 默认渲染 + onError + 信封）              |
| `http/src/flow-error.ts`（零使用死代码）                | 不移植         | E13        | —（身份由 code 承担）                                               |
| 3× `error-map.ts`（AppError 拷贝 + BY_INSTANCE 表）     | 删除           | E1/E3/E4   | app 迁移单元：face override 表 + onError；类拷贝消亡                |
| domain/identity-core/wallet/ledger-core 家谱 errors.ts  | 重构移植       | E9/E10/E12 | 各能力包迁移单元：`extends BusinessError` 固化身份 + context 结构化 |
| `domain/subscription` 单类多码形态                      | 合法形态保留   | —          | 随 billing 迁移（`catalog.business(key)` 即此形态的目录化）         |
| ai v1 `errors/`（classify 正则/overflow/internal）      | 已另行裁决     | E11        | `packages/ai` v2 §3.2（ErrorKind 封闭词表；映射 = ADR-0001 D7）     |
| 4× error-contract 不变量                                | **通用化移植** | 正面资产   | `__test__/nature.test.ts`（编译锁 + 家谱形态）                      |
| `new.target.name` / `declare readonly code` 惯例        | 延续           | E12        | nature.ts / 家谱形态保留                                            |

## 4. API 对照

| 旧签名/机制                                                                   | 新签名                                                                            | 变化理由                                             |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `new HttpError(code, message?, details?, headers?, suggestion?)` + 注册表查表 | `defineErrorCatalog(ns, defs)` + `Catalog.business(key, context?)` / `entry(key)` | ADR-0001 D1：身份/分类/文案单点来自目录定义（E2/E9） |
| 3× `AppError(status, code, message)` 自由字符串                               | `BusinessError(绑定三元组, context)`——`BusinessCode` 品牌类型                     | D8：未登记码编译期拒绝（E2 编译期封闭）              |
| `localizeMessage`（出站 message 逐字节相等才换中文）                          | 目录定义 `message`/`zh` 双字段；选择归 face 渲染                                  | E8 结构性失效的根除                                  |
| error-map BY_INSTANCE 翻译表                                                  | `is*Error` 守卫按 nature/category 分派 + face override                            | ADR-0001（v1 E1/E3 病灶）                            |
| `FlowError(kind, spec)`                                                       | —（不移植）                                                                       | 零使用死代码（E13）                                  |
| 各包自有 `*InternalError` / 不变量断言                                        | `DefectError`（自由码）/ `InfrastructureError`                                    | 三性判例映射（DESIGN §3.1）                          |
| 无（v1 缺）                                                                   | `annotate(err, facts)` / `normalizeError(unknown)` / `recordOf` / `handlingOf`    | D9 传播注记 + 边界兜底新契约                         |

## 5. 测试迁移矩阵

| 旧测试                                | 新去处                                                                             | 动作（移植 / 改写 / 删除+理由）                          |
| ------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 4× `error-contract.test.ts`（11 例）  | `__test__/nature.test.ts`（9 例）                                                  | **通用化移植**：包内唯一不变量 → 三性通用不变量 + 编译锁 |
| `error-registry-grading.test.ts`（5） | —（category 闭集结构保证）                                                         | 删除：分级纪律改由 `category.test.ts` 闭集双锁承载       |
| `error-locale.test.ts`（8+6）         | —（语言选择归 face）                                                               | 删除：目录双字段由 `definition.test.ts` 断言其存在       |
| `errors.test.ts` errorHandler 段（7） | http 迁移单元 `handler/render.test.ts`                                             | 改写归属 http（渲染出口职责）                            |
| `pg-error-translation.test.ts`（8）   | db 迁移单元 `pg-error.test.ts` + http `handler.test.ts`（探测注入）                | 改写归属 db/http（ADR-0002）                             |
| （无对应）                            | annotate / error-record / normalize / boundary / guards / definition（新写 44 例） | 新增规格（D8/D9 演进面、词表封闭锁、零依赖断言）         |

## 6. 回滚方案

- 单提交落地（P1）+ D8/D9 两个演进提交（`2e96c62` / `8643dfb`），各自独立可 revert；
  本包是新增叶子包，revert 不影响旧仓（只读未动）。
- 消费者接入（http → errors workspace 依赖等）随各消费者迁移单元的提交独立回滚；
  本包自身零依赖（`dependencies` 恒空，boundary.test 运行时断言），无连带。
- 无 DDL、无数据迁移、无对外 wire 契约变更（wire 投影归 face，尚未切换）。

## 7. 验收（全部满足才算完成）

- [x] 四门全绿；覆盖率 100%（statements/branches/functions/lines）≥ 阈值 90/85，未调阈值
- [x] §5 用例矩阵全绿（收口轮 60 用例，git `8643dfb`）；出口面 == DESIGN §2 声明
      （19 个值导出，boundary.test 快照锁定）；`dependencies` 为空
- [x] E2/E3/E6/E7/E8/E9/E12/E13 在本包范围内结构性消解；D8 后 E2/E8/E9 升级为编译期封闭
- [x] 既有消费者（http，§11 接入后）typecheck 全绿——根契约可用性实证
- 待核销（消费者切片，非本单元）：① http 重组（category 默认渲染 + face override）已随
  http 迁移单元落地；② 能力包家谱目录化（identity → billing → …）逐包随迁；③ 三 app
  face 装配（compose + override 表）与三份 error-map.ts 删除归 P5；④ 全仓守卫测试
  （throw 点码必登记、`as BusinessCode` 违规扫描）随第一个能力包迁移单元落地
  （ADR-0001 §4.3）——以上均有归属，无孤儿。
