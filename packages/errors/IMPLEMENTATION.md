# @tokenlens/errors 实施文档（IMPLEMENTATION）

> 状态：已完成 + D8/D9 演进（品牌绑定构造；JSON 值上下文 + 传播注记 + 类型化通道边界，ADR-0001）：四门全绿，用例数与覆盖率见 §7
> 基线：旧仓 `ai-getway` 错误体系全量审计（2026-08-23，三路并行：http 三件套 + 测试、
> 3× app error-map + gateway 出站面、domain/identity/wallet/ledger-core 家谱 + 契约测试 + ai v1 errors）
> 关联：[DESIGN.md](./DESIGN.md)、[ADR-0001](../../docs/adr/0001-errors-registry-ownership.md)、
> [project-structure-refactoring.md](../../docs/project-structure-refactoring.md) §9-P3

---

## 1. 原则

沿用 AGENT.md §9 七步流程与 ai 包实践：审计驱动裁决、测试先行、四门验证。
本包是"按消费者切片"（§9-P3）的第一片——**只落地根契约本身**，http 重组、db pg-error、
各能力包家谱与 face 装配分别属于各自迁移单元，不在此处预建。

## 2. v1 审计结论（缺陷编号 E#，证据均为逐行核验）

| #   | 结论                                                                                                                                                                                                                                                                                                           | 证据（旧仓位置）                                                                                     |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| E1  | **四套错误模型并存**：3 份 `AppError` 拷贝互相漂移（gateway 无 headers 字段；client 无 PG/HttpError 分支；admin 无 wallet 族分支）+ `HttpError` 注册表模型仅被 trace-receiver 消费，三个主 app 均不走共享 errorHandler                                                                                         | `apps/*/src/http/error-map.ts` ×3、`apps/*/src/app.ts` onError、`packages/http/src/errors.ts:98-141` |
| E2  | **25+ 个出站自由字符串码未登记**：无中文、无分级治理、改码静默失效；注册表内 5 码被 differently-named 影子码遮蔽（`upstream_error`↔`upstream_failed`、`channel_budget_exhausted`↔`INSUFFICIENT_BUDGET` 等）                                                                                                    | gateway error-map 18 码、client 12+、admin 3；error-codes.ts L189-207                                |
| E3  | **client/admin 同名表六处漂移 + 文档谎言**：`user_not_found` 401/404、`plan_disabled` 422/400、`plan_not_purchasable` 422/400、`seats_not_allowed` 422/400、`downgrade_not_allowed` 422/409、`subscription_inactive` 缺席/409、`RefKeyConflict` 双码；admin 表头注释宣称"与 client-api 同一分级口径"与事实相反 | client error-map L40-52 vs admin L46-59                                                              |
| E4  | **静默 500 洗白**：admin 无 wallet 族翻译（`InsufficientBalanceError`→500）、client 无 PG 翻译（约束违例→500）、client 无 `OperationConflictError`（→500）                                                                                                                                                     | admin error-map 无 wallet 分支；client 无 PG_HTTP                                                    |
| E5  | **`wallet_unmapped` 400 甩锅调用方**：未映射的服务端域错误被翻译成 4xx，契约码不稳定且归责错误                                                                                                                                                                                                                 | client L90-93、gateway L112-115                                                                      |
| E6  | **跨包 code 冲突**：`invalid_input`×3（identity-core/wallet/ledger-core）、`insufficient_balance`×2、`idempotency_conflict`×3、`reservation_limit_exceeded`×2；唯一性只在包内断言，全仓无门禁                                                                                                                  | 各包 error-contract.test.ts                                                                          |
| E7  | **大小写同码不同义 ×4**：`subscription_forbidden`（402/403）、`rate_card_disabled`（403/400）、`insufficient_balance`、`model_not_found`；`localizeMessage` 的 `toUpperCase()` 回退可命中错误面的 spec                                                                                                         | error-codes.ts L135/L206、L149/L219 等；L255                                                         |
| E8  | **zh 本地化结构性失效**：仅当出站 message 与注册表英文**逐字节相等**才换中文；实际 throw 点全用定制英文，中文客户端全线英文                                                                                                                                                                                    | error-codes.ts L254-258                                                                              |
| E9  | **message 即 code**：`SubscriptionDomainError` 默认 message = code，用户直接看到 `"plan_disabled"`；无文案无中文                                                                                                                                                                                               | domain/subscription/errors.ts L25                                                                    |
| E10 | **领域层 HTTP/i18n 知识**：domain/wallet 头注释携带状态码阶梯；identity 中文用户文案写进 domain（`验证码发送过于频繁…`）；ai classify 中文正则与中英混杂 suggestion                                                                                                                                            | domain/wallet/errors.ts L2-7、identity/src/errors.ts L24-52、ai classify.ts                          |
| E11 | **ai duck-typed 错误**：`new Error(msg) as UpstreamError` 后贴标志位，无类无 instanceof 判别                                                                                                                                                                                                                   | ai classify.ts L76-95（v2 已由 `UpstreamError` + ErrorKind 裁决取代）                                |
| E12 | **name 赋值分叉**：手抄字符串（漏写即错标子类）vs `new.target.name`（仅 identity/src 用对）                                                                                                                                                                                                                    | 各包 errors.ts；identity/src/errors.ts L17                                                           |
| E13 | **死件/幻影/隐式默认**：`suggestion` 字段从不渲染、`FlowError` 零使用、`errorHandler`+`PG_CODE_MAP` 生产死、504 仅存于注释、notFound 死文案 ×4、`BY_INSTANCE` 循环内不可达分支 ×3、admin `?? 400` 隐式状态默认、cause 深度限制两套（5 vs 无界）                                                                | http errors.ts L79-141、flow-error.ts、admin error-map L91/L104                                      |

正面资产（值得延续）：`identity-core` 的 21 类家谱（code + 结构字段 + 防枚举统一文案）、
三个 error-contract.test 的不变量集（instanceof/name/code 非空/包内唯一/结构字段存活）、
error-registry-grading.test 的分级纪律、`new.target.name` 惯例、wallet `ReservationError`
的 `declare readonly code` 收窄技巧。

## 3. 逐模块裁决表（v1 → v2）

| v1 文件/机制                                                     | 裁决                                                                  | v2 去向                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 三性/category 根契约概念（v1 设计 §4.1）                         | **重构移植**                                                          | `packages/errors`（本包，P1）                                                          |
| `http/src/error-codes.ts` 151 码集中注册表                       | **不移植整体**；按域拆归能力包目录（`defineErrorCatalog`），face 装配 | 各能力包迁移单元                                                                       |
| `http/src/errors.ts`（HttpError/errorHandler/errorResponseBody） | 重构                                                                  | http 迁移单元：category 默认渲染 + onError + 信封                                      |
| `PG_CODE_MAP` / `pgSqlState` cause 爬树 / admin `PG_HTTP`        | 重构合并（三处重复→一处源头分类）                                     | `db/src/pg-error.ts`                                                                   |
| 3× `error-map.ts`（AppError + 翻译表 + BY_INSTANCE）             | 删除                                                                  | app 迁移单元：face override 表 + onError；类拷贝消亡                                   |
| `FlowError`（零使用死代码）                                      | 不移植                                                                | —（身份由 code 承担，审计 `kind` 场景未出现）                                          |
| domain/identity/wallet/ledger-core 各 errors.ts 家谱             | 重构移植                                                              | 各能力包迁移单元：`extends BusinessError` 固化身份 + context 结构化                    |
| `domain/subscription` 单类多码形态                               | 合法形态保留                                                          | subscription 用例随 billing 迁移（`catalog.business(key)` 即此形态的目录化）           |
| ai v1 `errors/`（classify 正则/overflow/internal）               | 已另行裁决                                                            | `packages/ai` v2 §3.2（adapter 翻译 + ErrorKind 封闭词表；与根契约映射 = ADR-0001 D7） |
| v1 error-contract.test 不变量                                    | **通用化移植**                                                        | 本包 `nature.test.ts`（§5 映射）                                                       |
| v1 grading/守卫三件套                                            | 随消费者延后                                                          | 第一个能力包迁移单元落地（ADR-0001 §4.3），不预建                                      |

## 4. 目录结构

```text
packages/errors/
├── DESIGN.md / IMPLEMENTATION.md
├── package.json / tsconfig.json / vitest.config.ts
├── src/
│   ├── nature.ts         # 三性根类（TokenlensError/Business/Infrastructure/Defect）+ ErrorContext
│   ├── category.ts       # category 闭集 + CATEGORY_DEFAULTS + isErrorCategory
│   ├── definition.ts     # ErrorDefinition + defineErrorCatalog + composeErrorCatalogs
│   ├── error-record.ts   # ErrorRecord 联合 + recordOf + handlingOf + ROOT_ERROR_CODES + cause 链
│   ├── normalize.ts      # normalizeError(unknown) 边界兜底
│   ├── guards.ts         # 四个 instanceof 守卫
│   └── index.ts          # 出口桶（boundary.test 快照锁定）
└── __test__/             # nature / category / definition / error-record / normalize / boundary / guards（扁平，铁律 14）
```

## 5. 测试计划（新写；v1 契约不变量 → v2 通用化映射）

| 用例组       | 断言要点                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 回归映射                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| nature       | 三类 instanceof 链；`name === new.target` 子类名；nature 字面量；code/category/context/retryAfterMs/cause 保留；家谱形态（`entry()` 绑定 + 测试内子类）；**编译锁：自由字符串 code 不可构造**（`@ts-expect-error`，typecheck 门禁生效）；**context 收递归只读 JSON 值**（数组/嵌套对象透传，D9a）                                                                                                                                                                  | E12；identity/wallet/ledger 三份 error-contract 不变量通用化；E2 编译期封闭（D8） |
| annotate     | 返回同一实例（instanceof 与分类不动）；构造上下文为底、注记按时间序合并、后写胜出；符号键非枚举（序列化不被污染）；多次注记累积；固化类经注记仍可精确捕获（D9b）                                                                                                                                                                                                                                                                                                   | 传播富化的实例稳定契约（对比 anyhow 包装丢 downcast）                             |
| category     | 闭集与文档词表逐项一致（硬编码对照）；DEFAULTS 键集 == 闭集无缺无余；isErrorCategory 双向；冻结                                                                                                                                                                                                                                                                                                                                                                    | 词表封闭锁 #1（编译期 union 之外）                                                |
| definition   | `code()` 前缀拼接；`entry()` 返回绑定三元组（code/category/message/zh，与定义逐项相等且冻结、miss/坏形状同 business 防呆）；get/has 命中与 miss；`business()` 的文案/身份/分类来自**定义**而非调用点；context/opts 透传；未知 key → `errors.catalog_key_missing`；坏形状 key/namespace/空文案 → `errors.catalog_key_invalid`；定义入目录后源对象变异不泄漏；目录冻结；compose 跨目录查找、重复命名空间 → `errors.duplicate_namespace`；不同命名空间同名 key 不冲突 | E2/E3/E6/E7/E8/E9/E13；E8/E9 构造点偏离的编译期封死（D8）                         |
| error-record | 三性记录字段映射（business 必带 category）；handlingOf 全矩阵（7 category + infra + defect）；cause 链（嵌套根类/外来 Error/非错误值）；深度上限截断                                                                                                                                                                                                                                                                                                               | 处理语义单点锁；E5（记录不判责，出站归 face）                                     |
| normalize    | 根类直达 `recordOf` 等价；外来 Error → `errors.unhandled`（message 保留、name 进 context、空 message 回退）；非 Error 值（string/number/object/null/Symbol/toThrowing toString）→ `errors.non_error` 且不炸                                                                                                                                                                                                                                                        | v1 errorHandler "未知一律按缺陷"语义的通用化                                      |
| boundary     | `dependencies`/`peerDependencies` 为空（零依赖叶子运行时断言）；出口面快照 == 预期 19 个值导出                                                                                                                                                                                                                                                                                                                                                                     | 铁律 11 边界可执行；词表封闭锁 #2                                                 |

v1 中**不移植**的用例及理由：error-locale（8+6 例）——语言选择归 face，本包无 locale 逻辑；
pg-error-translation（8 例）——归 db 迁移单元；error-registry-grading（5 例）——分级纪律
随能力包目录与 face 渲染落地；errors.test.ts 的 errorHandler/信封（7 例）——归 http 迁移单元。

## 6. 实施顺序

- **P1（本阶段，单提交）**：包落地——七文件 + 包配置 + §5 全部用例，四门全绿。
- **P2+（各消费者切片，本包不再变动或仅加法演进）**：
  1. `http` 重组：category 默认渲染 + face override + onError；
  2. `db`：`pg-error` 源头分类（三处 PG 翻译合一）；
  3. 能力包家谱迁移（identity → billing → …），各携 MIGRATION.md 与守卫测试；
  4. app face 装配（compose + override 表 + wire 快照），删除三份 error-map.ts。
     每片独立提交、独立可 revert（§9.1 迁移规约）。

## 7. 验收

- 四门（typecheck / lint / test / build）全绿；覆盖率 ≥ 阈值 90/85（铁律 16：数字如实报告，
  只补测试不调阈值）。
- §5 用例矩阵全绿；E2/E3/E6/E7/E8/E9/E12/E13 在本包范围内被结构性消解
  （消费者侧残留的消解在各迁移单元验收）；D8 之后 E2/E8/E9 升级为编译期封闭。
- 出口面 == DESIGN §2 声明（19 个值导出）；`dependencies` 为空。
