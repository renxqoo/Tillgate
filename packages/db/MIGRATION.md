# @tokenlens/db 迁移文档（MIGRATION.md）

> 状态：已完成（三阶段落地、四门全绿；验收清单 [IMPLEMENTATION.md](./IMPLEMENTATION.md) §6 全部核销，
> 含真实 PG 集成 6/6 与空库迁移探针）
> 迁移单元：db 基础设施包——连接、事务、schema、迁移链、PG 错误分类（不是垂直业务用例；
> schema 语义的消费方随 P4 能力波次另行迁移）
> 旧实现：`/Users/wrr/work/ai-getway/packages/db`（src 33 文件 ~2.2k 行 = index.ts 35 行 +
> schema 32 文件；迁移 75 件 SQL（0000-0075，历史缺口 0036）+ meta snapshot/journal；
> scripts/seed-dev.ts 259 行；**零测试**）及 core / wallet / ledger-core / identity-core /
> repository / http 六包散置的 db 基础设施（runTx ×3、SQLSTATE 探测 ×4、事务句柄类型 ×4 变体）
> 目标位置：`/Users/wrr/work/TokenLens-v2/packages/db`
> 关联：[DESIGN.md](./DESIGN.md)（设计基线，定稿）、[IMPLEMENTATION.md](./IMPLEMENTATION.md)
> （B#/D#/C# 编号出处）、[ADR-0002](../../docs/adr/0002-http-db-decoupling.md)、
> [project-structure-refactoring.md](../../docs/project-structure-refactoring.md) §3.4/§5.1/§9-P3

## 1. 行为规格基线

**v1 零测试——无可移植用例，也无删除用例**。行为等价的判定依据（IMPLEMENTATION §0.4）：

- (a) 表定义与 v1 逐字对照（微修改清单之外 diff 为零，P1 提交记录佐证）；
- (b) `runTx` 注入 v1 魔法数 `{maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20}` 时，
  重试语义与 v1 三份拷贝逐字一致（退避公式 fake-timers 验证累计 25/65/135ms）；
- (c) 迁移链与生产 journal 逐件一致（0000-0075 一字不改，缺口 0036/idx37 原样保留）。

全部 v2 测试为**新增门禁**（v1 从未有过任何迁移链结构检查）：

| 新测试（`__test__/` 平铺）                                                  | 用例数           | 性质                                  |
| --------------------------------------------------------------------------- | ---------------- | ------------------------------------- |
| migrations / schema / pg-error / transaction / client                       | 4+6+10+10+6 = 36 | 新增规格（默认门禁）                  |
| pg.real.test.ts（真实 PG，缺 `DATABASE_URL` 自动 skip；`test:real` 单独跑） | 6                | 新增规格（资金级边界行为必须真实 PG） |

## 2. 审计结论（引用 IMPLEMENTATION.md §1，不重复抄写）

- **真 bug / 违约**：B1（payments FK 反向依赖 ledger-core，同表双定义）、B2（createDb 隐藏
  默认连接串 ×6 与双套池默认）、B3（SQLSTATE 探测深度三处不一致——wallet 资金路径漏检）、
  B4（账号状态词表三套并存）、B5（request_logs 分区母表声明漂移警示）、B6（fx_rate_id
  无 FK 保持——记录不修）。全部处置见 §1.1 表。
- **重复提取**：D1（runTx ×3 合一）、D2（transientTxCode ×3）、D3（SQLSTATE 探测 ×4 合一）、
  D4（事务句柄 ×4 收敛 Db/DbTx/DbLike）、D5（连接串默认 ×6 清除）、D6（词表 ×3 收敛）。
- **契约缺口**：C1-C8（closeDb/ping 收口、worker readyz 差异、业务词表不预建、provision
  四链收口归 P4、seed-dev 已移植（C5 回销）、Actor/RepoContext 归能力包、runEffect 不移植、
  advisoryLock 键名归 identity）。

## 3. 逐模块裁决表

### 3.1 schema 32 文件（完整逐文件表见 IMPLEMENTATION §2.1）

| 旧文件                                                   | 裁决      | 审计状态 | 动作                                                                          |
| -------------------------------------------------------- | --------- | -------- | ----------------------------------------------------------------------------- |
| users.ts / admins.ts                                     | 复制+微修 | B4/D6    | 删局部 USER_STATUS/ADMIN_STATUS，default 改引 ACCOUNT_STATUS（值 0/1/2 不变） |
| payments.ts                                              | 复制+微修 | B1       | FK 改引本地 `./ledger-operations.js`，解除 ledger-core 依赖                   |
| logs.ts                                                  | ✅ 复制   | B5       | 分区母表警示注释原样保留（对它跑 generate 会产生错误 DDL）                    |
| 其余 25 个表定义文件 + relations.ts + index.ts（barrel） | ✅ 复制   | 无发现   | 接管时与旧仓 diff 为零                                                        |
| account-status.ts                                        | 复制+微修 | B4/D6    | 三套词表收敛为 ACCOUNT_STATUS 单套                                            |

v2 侧增量（非 v1 迁移，随 identity 能力波次）：`schema/identity.ts` 七表 + 迁移 0076
（DDL-first、IF NOT EXISTS 幂等；f716844/d2e18d9）——表集 39 → 46、迁移链 76 件。

### 3.2 基础设施与周边（完整表见 IMPLEMENTATION §2.2）

| 旧来源                                      | 裁决      | 审计状态 | 动作                                                                 |
| ------------------------------------------- | --------- | -------- | -------------------------------------------------------------------- |
| `db/src/index.ts` createDb/Db/DbTx          | **重构**  | B2       | `client.ts`：配置必填无默认 + `ping`（C2）+ `closeDb`（C1）          |
| `repository/context.ts` DbLike              | 复制      | —        | `context.ts`（仅 DbLike；Actor/RepoContext 不迁，C6）                |
| wallet/ledger-core/identity-core `runTx` ×3 | **重构**  | D1/B3    | `transaction.ts#runTx` 单份：策略必填注入 + onRetry 吞错             |
| identity-core `advisoryLock`                | 复制      | C8       | `transaction.ts`（业务键名构造器不迁）                               |
| `core/src/pg.ts` pgSqlState                 | ✅ 复制   | —        | `pg-error.ts`（全链正则语义逐字）                                    |
| identity-core uniqueViolationConstraint     | 复制+微修 | B3       | 深度 5 → 全链（superset 方向，更深的冲突不再漏检）                   |
| 各包 `Tx/AnyPgDatabase` 句柄变体            | 不移植    | D4       | 收敛为 Db/DbTx/DbLike 单套                                           |
| ledger-core/identity-core `runEffect`       | 不移植    | C7       | 与事务无关，归能力包                                                 |
| http `PG_CODE_MAP` + pgSqlState 转发        | 不移植    | ADR-0002 | PG→HTTP 翻译归 http 包（db 只出分类）                                |
| `scripts/seed-dev.ts`                       | 复制+微修 | C5       | 已移植：encrypt → runtime cipher（enc:v1）相对路径注入，不进 db 依赖 |
| `drizzle.config.ts`                         | 复制+微修 | D5       | 去默认 URL：缺 DATABASE_URL 显式报错                                 |
| `migrations/`（75 SQL + meta + journal）    | ✅ 复制   | C4       | 物理事实一字不改；0036/idx37 缺口保留                                |
| `db:generate` 脚本                          | 移除      | C4 补充  | snapshot 链止于 0054，恢复生成链须先补 snapshot + 双验证 + ADR       |

## 4. API 对照

| 旧签名                                                              | 新签名                                                                                   | 变化理由                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `createDb(url?)` 兜底 `postgres://…localhost/ai_gateway`，池默认 20 | `createDb({ url, poolMax, idleTimeoutMillis, connectionTimeoutMillis, maxUses })` 全必填 | B2/D5 零写死；缺省值唯一归属装配层                   |
| `runTx(db, fn)`（魔法数 5/15/20 内藏，三拷贝漂移）                  | `runTx(db, fn, { maxAttempts, baseDelayMs, maxJitterMs }, { onRetry? })`                 | D1 合一；策略显式化（注入 {5,15,20} 时行为逐字等价） |
| wallet/identity-core 自有 `Tx` / `AnyPgDatabase` 宽容型             | `DbTx`（同 v1 推导式）+ `DbLike = Db \| DbTx`                                            | D4 单套句柄词汇                                      |
| `isUniqueViolation` 深度 3/5/无限三处                               | 全 cause 链探测（含约束名提取 `uniqueViolationConstraint`）                              | B3 资金路径漏检修复                                  |
| 各 app 内联 `db.$client.end()` / `select 1`                         | `closeDb(db)` / `ping(db)`（失败源头分类 `db.unavailable`）                              | C1/C2 收口；§11 错误根契约（P5）                     |
| seed 直用 `@ai-gateway/core` encrypt                                | `createCipher`（runtime，enc:v1 逐字节兼容）相对路径注入                                 | C5；db 零内部依赖纪律不变                            |
| `db:generate`（基于 0054 snapshot）                                 | 移除（本仓迁移为手写 DDL-first 实践，0076 已验证）                                       | C4 补充：防重复生成 0055-0076 DDL                    |

## 5. 测试迁移矩阵

| 旧测试 | 新去处                                   | 动作                                                                                                                   |
| ------ | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| （无） | `__test__/migrations.test.ts`（6）       | 新增：journal↔SQL 1:1 双向、编号严格递增、缺口 0036/idx37 断言                                                         |
| （无） | `__test__/schema.test.ts`（10）          | 新增：46 表封闭词表、FK 物化（遍历全部 `.references()` 惰性回调、目标表必在封闭集合）、全 src 零跨包 import            |
| （无） | `__test__/pg-error.test.ts`（10）        | 新增：深度 0/1/3/5/10 探测、**B3 回归（深度 4 的 23505 必须检出）**、约束名提取、5 位码正则边界                        |
| （无） | `__test__/transaction.test.ts`（6）      | 新增：退避序列 25/65/135ms（fake timers）、仅 40P01/40001 重试、耗尽抛最后错误、onRetry 吞错                           |
| （无） | `__test__/client.test.ts`（4）           | 新增：池参数逐字段透传、无默认类型面证明（`@ts-expect-error`）、closeDb → `$client.end`                                |
| （无） | `__test__/pg.real.test.ts`（6，真实 PG） | 新增：SAVEPOINT 内层回滚外层提交、真实 23505 检出含约束名、advisoryLock 同事务重入、瞬态重试端到端、closeDb 后连接拒绝 |

## 6. 回滚方案

- 每阶段提交独立可 revert（P1-P5 见 IMPLEMENTATION §5 提交表：`4529f53`/`710a9ad`/`fda8a19`/
  `128a83d`/P5 §11 采纳）；全部为新增文件，不触碰 ai 包与根配置。
- 迁移链为纯复制，revert 无数据面影响；新仓未对生产库执行任何迁移（生产库不动）。
- DDL 与代码迁移分离：0076 是 v2 侧 DDL-first 增量（幂等 IF NOT EXISTS），revert 不破坏
  0000-0075 物理链。
- 空库迁移探针（一次性手工验证）已确认空库升级范围 = 0000-0054；0055+ 依赖 provision 链
  先行（C4 收口属 P4 能力波次，未在本单元执行——rollback 语义与 v1 CI 记录一致）。

## 7. 验收（全部满足才算完成；证据见 IMPLEMENTATION §6 逐项打勾）

- [x] 四门全绿（typecheck / lint 0 错 / test 36 单测 + 6 real / build 双入口产物）
- [x] 表定义与 v1 逐字一致（微修改仅 B1/B4 三处，接管 diff 为零）；B3 回归用例绿
- [x] 迁移链一致性与零内部依赖（schema.test 扫 import 断言）；createDb/runTx 无隐藏默认
- [x] runTx 注入 {5,15,20} 时与 v1 三拷贝等价；real PG 用例绿（SAVEPOINT/唯一冲突/advisory lock）
- [x] 覆盖率 99.52% statements / 100% branches / 99.17% functions / 99.46% lines ≥ 90/85，未调阈值
- [x] §11 错误根契约采纳（P5：ping 失败 = `InfrastructureError('db.unavailable')`，守卫用例锁定）
- [x] seed-dev 移植核销（C5 回销：门禁复核 + dev 库实跑两轮幂等）
- [x] 不移植清单（C1-C8）各有归属标注，无孤儿
- 待核销（非本单元，显式挂账）：provision 三链收口与 worker readyz 差异修正归 P4/P5
  能力波次（C1/C2/C4 的消费侧兑现）；bun.lock 曾因混入并行会话条目未随 P5 提交
  （铁律 15，待协调收口——不阻塞本单元行为等价结论）。
