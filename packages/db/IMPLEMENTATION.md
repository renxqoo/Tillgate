# @tokenlens/db 迁移实施文档(IMPLEMENTATION)

> 状态:已完成——三阶段落地,四门全绿;真实 PG 集成 6/6、空库迁移探针核销(§6)
> 基线:旧仓 `ai-getway/packages/db`(v1:35 行 index + 32 schema 文件 ~2.4k 行 + 迁移 76 件(0076 identity 七表已入链) + seed 259 行,零测试)及 core/wallet/ledger-core/identity-core/repository/http 中分散的 db 基础设施
> 设计基线见 [DESIGN.md](./DESIGN.md)(定稿);本文是施工图:审计 / 裁决 / 拆分 / 测试计划 / 实施顺序

---

## 0. 原则

1. **迁移单元是 db 基础设施包**(连接/事务/schema/迁移/PG 错误分类),不是业务用例——schema 语义的消费方(能力包)后续波次迁移。
2. **表定义 = 物理 DDL 的镜像**:drizzle 声明不得自行漂移(如 usage_logs.fx_rate_id 无 FK 是物理事实,B6);迁移 SQL 是不可改写的生产事实。
3. **基础设施四件(client/context/transaction/pg-error)是收敛动作**:v1 的 3 份 runTx、4 份 SQLSTATE 探测、4 种句柄类型收拢为单份,行为差异显式裁决。
4. **v1 零测试 → 全部测试为新增门禁**,行为等价的判定依据是:(a) 表定义与 v1 逐字对照(微修改清单外);(b) runTx 重试语义与 v1 拷贝逐字一致(策略注入 {5,15,20} 时);(c) 迁移链与生产 journal 逐件一致。

---

## 1. 全量审计结论

审计范围:v1 db 包全部源文件逐文件过四条标准(正确性/契约符合/实现质量/依赖方向);基础设施部分覆盖 core、wallet、ledger-core、identity-core、repository、http 六包的相关文件;消费面为全仓 grep 计数(两轮独立审计交叉核对)。

### 1.1 真 bug / 违约清单(B#)

| #   | 位置                                                                                             | 问题                                                                                                                                                                                                                                                                                               | 级别                                                        | 处置                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| B1  | `db/src/schema/payments.ts:15`                                                                   | `import { ledgerOperations } from '@ai-gateway/ledger-core'`——db 反向依赖业务包(违反总纲 §5.1 白名单 db→仅 errors);且 `ledger_operations` 表定义在 `db/src/schema/ledger-operations.ts` 与 `ledger-core/src/schema.ts` **双份并存**(同表同列),FK 引用的是旧包那份                                  | 依赖/双事实源(计费级:两份漂移会使 FK 目标与迁移 DDL 不一致) | v2:payments FK 改引本地 `./ledger-operations.js`,db 零内部依赖                                          |
| B2  | `db/src/index.ts:18-27`                                                                          | `createDb` 隐藏默认:连接串兜底 `postgres://postgres:postgres@localhost:5432/ai_gateway`(同款硬编码全仓 6 处:db index / wallet / ledger-core / identity-core migrate-cli / drizzle.config / core env);池默认 max=20 与各 app config 默认 DB_POOL_MAX=10 **两套并存**,真实生效值取决于调用方是否传参 | 配置漂移(违反铁律 3)                                        | v2:配置对象全必填,无任何默认                                                                            |
| B3  | `wallet/src/internal.ts:18-25` vs `identity-core/src/internal.ts:18-27` vs `core/src/pg.ts:5-13` | `isUniqueViolation` cause 链探测深度三处不一致(wallet 3 层 / identity-core 5 层 / core 正则版无限)——wallet 路径深度 >3 的唯一冲突**漏检**,资金路径的兜底信号(并发重放判定)漏报后走未知错误分支                                                                                                     | 正确性(资金路径)                                            | v2:统一全链探测(superset 方向,更深的冲突不再漏检);回归用例锁定                                          |
| B4  | `account-status.ts` vs `users.ts:17-21` vs `admins.ts:9-13`                                      | 账号状态词表三套并存:`ACCOUNT_STATUS`(ACTIVE/BANNED/DELETED,自称"单一真相")与 `USER_STATUS`/`ADMIN_STATUS`(NORMAL/SUSPENDED/DELETED)同值不同名并存于两个表文件                                                                                                                                     | 词表漂移(隐性)                                              | v2:收敛为 `ACCOUNT_STATUS` 一套;users/admins 的局部常量删除,default 引用改 ACCOUNT_STATUS(值不变,0/1/2) |
| B5  | `db/src/schema/logs.ts:77-80`                                                                    | `request_logs` 声明与物理 DDL 漂移:实际 DB 自 0040 起是分区母表(PK (id, created_at),无 FK),drizzle 声明只描述列结构——**对它跑 db:generate 会产生错误 DDL**                                                                                                                                         | 结构(已有警示注释)                                          | v2:注释原样保留;db:generate 操作纪律写入 DESIGN §4;不加测试(drizzle-kit 行为无法在包内拦截)             |
| B6  | `db/src/schema/usage.ts` fxRateId 列                                                             | 注释称"指向 fx_rates 追加表的具体行"但未建 FK(物理 DDL 也无)                                                                                                                                                                                                                                       | 已知缺口(一致性优先)                                        | v2:保持原样——drizzle 声明是物理事实的镜像,不在声明层单方面加约束;记录,不修                              |

### 1.2 重复代码清单(D#)

| #   | 重复                                                                                                                                    | v1 位置                                                                                                    | v2 收敛                                                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `runTx` 事务重试壳 ×3 逐字拷贝(wallet 版多 telemetry 钩子与 SAVEPOINT 注释)                                                             | `wallet/src/internal.ts:46-68`、`ledger-core/src/internal.ts:29-41`、`identity-core/src/internal.ts:41-53` | `transaction.ts` 单份:策略必填注入 + onRetry 钩子(吞错);三份的重试魔法数(尝试 5、退避 `15·2^attempt`、抖动 `rand(0..20)`)显式化为 {maxAttempts, baseDelayMs, maxJitterMs} |
| D2  | `transientTxCode`(40P01/40001)×3 逐字                                                                                                   | 同上三处                                                                                                   | `pg-error.ts#transientTxFailureCode` 单份(全链探测)                                                                                                                       |
| D3  | SQLSTATE 探测 ×4(core 正则无限深 / wallet 深 3 / identity-core 深 5 返回约束名 / repository `wallet.repo.ts:434-443` 方法版)+ http 转发 | 见 B3                                                                                                      | `pg-error.ts` 单份三函数:`pgSqlState`(全链正则,继承 core 语义)+ `isUniqueViolation` + `uniqueViolationConstraint`(identity-core 语义,深度改全链)                          |
| D4  | 事务句柄类型 ×4 变体(`db DbTx` / wallet、ledger-core、identity-core 各自 `Tx` + `AnyPgDatabase` 宽容型)                                 | 各 internal.ts + `db/src/index.ts:32-35`                                                                   | `client.ts#Db/DbTx` + `context.ts#DbLike` 单套;`AnyPgDatabase` 不移植(db 内自持 schema,无跨 schema 泛型需求)                                                              |
| D5  | 连接串默认 ×6                                                                                                                           | 见 B2                                                                                                      | v2 无默认(必填);drizzle.config.ts 同步去除                                                                                                                                |
| D6  | 账号状态词表 ×3                                                                                                                         | 见 B4                                                                                                      | `schema/account-status.ts` 单套(见 B4)                                                                                                                                    |

### 1.3 契约缺口与演进决策(C#)

| #   | 事项                                                                                                                                                                                                                                                                                                            | 决策                                                                                                                                                                                                                         |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | db 收口逻辑(`db.$client.end()`)在 5 个 app 的 shutdown 内近似拷贝(gateway/client-api/admin-api 同构,trace-receiver/worker 内联)                                                                                                                                                                                 | v2 提供 `closeDb(db)`;apps 迁移(P5)时消费,本文档不迁 app                                                                                                                                                                     |
| C2  | 健康检查 `select 1` 在 health.repo / trace-receiver 内联;worker readyz 实际只查内存标志不 ping DB(与注释不符)                                                                                                                                                                                                   | v2 提供 `ping(db)`;worker 差异记录在案,P5 修正                                                                                                                                                                               |
| C3  | 业务状态词表无常量导出:channels status 0-4、generation_tasks status、billing_requests status(8 值)、notify event(NOTIFY_EVENTS 在 worker)等,魔法数字散布在 v1 消费方                                                                                                                                            | **不随 db 移植**(铁律 4:无消费方不写);各能力波次随消费者落词表;db 仅保留与 CHECK 约束成对的 ACCOUNT_STATUS(v1 先例)                                                                                                          |
| C4  | 生产库叠加 **4 条迁移链**:identity-core provision(7 表,IF-NOT-EXISTS 无版本)、ledger-core provision(1 表)、db drizzle-kit(76 件,0076 起 identity DDL 进统一链)、wallet migrate(5 件,sha256 checksum + advisory lock);root `db:migrate` 按序串 4 链;**0055 起 drizzle 迁移依赖 provision 链先建表**(CI 注释明示) | v2 原样接管 drizzle 链(含 journal 历史缺口:tag 缺 0036、idx 跳 37——迁移链物理事实);三条 provision 链收口按总纲 §9 P3「按能力迁移逐步收口,每次验证空库/存量/回滚,禁止一次改完」→ P4 能力波次;**空库迁移验证范围 = 0000-0054** |
| C5  | `scripts/seed-dev.ts`(259 行)依赖 `@ai-gateway/core` 的 encrypt(channel apiKey 加密)与 ENCRYPTION_KEY | **已移植(2026-08-23,原「暂缓」回销)**:落到 `scripts/seed-dev.ts` 逐语义移植——encrypt 替换为 runtime cipher(`createCipher`,enc:v1,与 v1 存量密文逐字节兼容);cipher 经**相对路径注入脚本**(dev 装配面,`../../runtime/src/crypto/cipher.js`),不进 db 的 package.json(零内部依赖纪律不变;bun 隔离安装下未声明依赖亦无法按包名解析,相对路径是唯一不破坏依赖纪律的接入方式)。适配:users 无 balance 列(v2 资金事实唯一在 wallet)、createDb 必填配置对象、closeDb 收口、v1 默认连接串删除(B2/D5)、db.query 去防御可选链(全 schema 绑定后类型精确);scripts/ 纳入 tsconfig include(typecheck 覆盖)。dev 库实跑两轮:固定唯一键段全跳过,测试 Key 段随机明文每次新插(= v1 行为原样) |
| C6  | `repository/context.ts` 的 Actor/RepoContext(执行元数据)与 `service/context.ts` 的 RunContext/inTx                                                                                                                                                                                                              | 归能力包 application/adapters 层;v2 context.ts 仅 `DbLike`                                                                                                                                                                   |
| C7  | `runEffect`(提交后 best-effort 副作用)×2(ledger-core/identity-core)                                                                                                                                                                                                                                             | 不移植:与事务无关(纯 try/catch 包装),归能力包                                                                                                                                                                                |
| C8  | identity-core 的 advisoryLock 键构造器(credentialSetLockKey/challengeLockKey)                                                                                                                                                                                                                                   | 锁原语 `advisoryLock` 进 db;**业务键名**归 identity 包                                                                                                                                                                       |

### 1.4 消费面快照(v1,迁移后由能力波次逐步切换)

- `@ai-gateway/db` 主入口 import 180 处(gateway 61 / admin-api 49 / repository 47 / client-api 26 / service 21 / worker 11 / tracing 3 / trace-receiver 3 / http 3 / identity 2 / 根 scripts 4);`./schema` 子入口显式 6 处。
- `createDb` 生产调用 9 处(5 app assembly/index + seed);`Db/DbTx` 类型消费以 repository(17 文件)与 service(10 文件)为主;http/tracing/identity 为纯 `type Db` 依赖。
- v1 分层约束(repository boundary test:只准依赖 drizzle-orm 与 db;service/app architecture test 禁直连 db/ledger-core)——新仓由能力包波次重建对应门禁,本包只保证零内部依赖。

---

## 2. 逐模块裁决表

### 2.1 schema 32 文件(裁决基准:与物理 DDL 逐字对照,微修改清单外零改动)

| 文件                    | 表                                               | 裁决      | 动作                                                                     |
| ----------------------- | ------------------------------------------------ | --------- | ------------------------------------------------------------------------ |
| account-status.ts       | (词表)                                           | 复制+微修 | B4/D6:收敛三套词表为 ACCOUNT_STATUS;isAccountUsable 保留                 |
| users.ts                | users                                            | 复制+微修 | 删局部 USER_STATUS,default/注释改 ACCOUNT_STATUS(值 0/1/2 不变);其余逐字 |
| admins.ts               | admins                                           | 复制+微修 | 同上(删 ADMIN_STATUS)                                                    |
| apps.ts                 | apps                                             | ✅ 复制   | 无改动                                                                   |
| api-keys.ts             | api_keys                                         | ✅ 复制   | 无改动                                                                   |
| providers.ts            | providers                                        | ✅ 复制   | 无改动                                                                   |
| channels.ts             | channels                                         | ✅ 复制   | 无改动(status 0-4 词表缺口见 C3,不新增)                                  |
| channel-recharges.ts    | channel_recharges                                | ✅ 复制   | 无改动                                                                   |
| model-mappings.ts       | model_mappings + model_channels                  | ✅ 复制   | 无改动                                                                   |
| billing.ts              | rate_cards + rate_card_coefficients              | ✅ 复制   | 无改动                                                                   |
| usage.ts                | usage_logs                                       | ✅ 复制   | 无改动(fx_rate_id 无 FK 保持,B6)                                         |
| transactions.ts         | transactions                                     | ✅ 复制   | 无改动                                                                   |
| billing-requests.ts     | billing_requests                                 | ✅ 复制   | 无改动                                                                   |
| billing-reservations.ts | billing_reservations                             | ✅ 复制   | 无改动                                                                   |
| redeem.ts               | redeem_batches + redeem_codes                    | ✅ 复制   | 无改动                                                                   |
| logs.ts                 | request_logs + audit_logs                        | ✅ 复制   | 分区漂移警示注释保留(B5)                                                 |
| plans.ts                | plans + user_subscriptions                       | ✅ 复制   | 无改动                                                                   |
| organizations.ts        | organizations                                    | ✅ 复制   | 无改动                                                                   |
| org-members.ts          | org_members                                      | ✅ 复制   | 无改动                                                                   |
| org-invitations.ts      | org_invitations                                  | ✅ 复制   | 无改动                                                                   |
| reconcile.ts            | reconcile_discrepancies                          | ✅ 复制   | 无改动                                                                   |
| relations.ts            | (19 组 relations)                                | ✅ 复制   | 无改动                                                                   |
| tracing.ts              | trace_spans                                      | ✅ 复制   | 无改动                                                                   |
| payments.ts             | payment_orders                                   | 复制+微修 | B1:FK 改引本地 ./ledger-operations.js,解除 ledger-core 依赖              |
| referrals.ts            | referrals                                        | ✅ 复制   | 无改动                                                                   |
| marketing.ts            | marketing_settings                               | ✅ 复制   | 无改动                                                                   |
| notifications.ts        | notification_channels + notify_outbox            | ✅ 复制   | 无改动                                                                   |
| generation-tasks.ts     | generation_tasks                                 | ✅ 复制   | 无改动                                                                   |
| wallet.ts               | wallet_accounts/transactions/legs/authorizations | ✅ 复制   | 无改动(收敛终态定义,DDL 真源 0059)                                       |
| ledger-operations.ts    | ledger_operations                                | ✅ 复制   | 无改动(收敛终态定义,DDL 真源 0059)                                       |
| fx.ts                   | fx_rates + system_configs                        | ✅ 复制   | 无改动                                                                   |
| index.ts                | (barrel)                                         | ✅ 复制   | 30 行 `export *` 逐字(schema 出口设计即全量导出)                         |

### 2.2 基础设施(裁决)

| v1 来源                                                    | 裁决                | v2 去处                                                                                          |
| ---------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------ |
| `db/src/index.ts` createDb/Db/DbTx                         | **重构**            | `client.ts`:配置必填(B2)+ `ping`(C2)+ `closeDb`(C1);池参数语义(30s/5s/1000 的注释)保留为参数文档 |
| `repository/context.ts` DbLike                             | 复制                | `context.ts`(仅 DbLike;Actor/RepoContext 不随迁,C6)                                              |
| `wallet/src/internal.ts` runTx(telemetry 版)               | **重构**            | `transaction.ts#runTx`:三拷贝合并(D1),策略必填注入,onRetry 钩子保留吞错语义;SAVEPOINT 注释保留   |
| `identity-core/src/internal.ts` advisoryLock               | 复制                | `transaction.ts#advisoryLock`(pg_advisory_xact_lock(hashtext(key)));键构造器不迁(C8)             |
| `core/src/pg.ts` pgSqlState                                | ✅ 复制             | `pg-error.ts`(全链正则语义逐字)                                                                  |
| `identity-core` uniqueViolationConstraint                  | 复制+微修           | `pg-error.ts`:深度 5 → 全链(统一 B3 裁决)                                                        |
| wallet/ledger-core/identity-core `Tx/AnyPgDatabase/DbLike` | 不移植              | D4 收敛为 Db/DbTx/DbLike 单套                                                                    |
| `ledger-core`/`identity-core` runEffect                    | 不移植              | C7(归能力包)                                                                                     |
| `http` PG_CODE_MAP + pgSqlState 转发                       | 不移植              | PG→HTTP 翻译归未来 http 包(db 只出分类)                                                          |
| `scripts/seed-dev.ts`                                      | **复制+微修**        | C5:已移植 `scripts/seed-dev.ts`(encrypt→runtime cipher 相对路径注入;差异清单见 §1.3 C5)           |
| `drizzle.config.ts`                                        | 复制+微修           | 去默认 URL(D5):缺 DATABASE_URL 显式报错                                                          |
| `migrations/`(76 SQL + meta 55 snapshot + journal)         | ✅ 复制 + 0076 增量 | v1 物理事实一字不改(缺口 0036/idx37 保留);0076 为 v2 DDL-first 首件(IF NOT EXISTS 幂等)          |

---

## 3. v2 拆分决策

目录结构见 DESIGN §4。增量决策(全部引用审计证据):

1. **schema 保持平面 32 文件,不预先按能力分组**——分组需要真实归属知识(users 归 accounts、admins 归 control-plane、marketing 归属待裁决……),P4 能力波次随迁移落地;现在分组是猜测(总纲 §3 树注为目标态)。审计裁决表以文件名 1:1 映射,可追溯性最高。
2. **`pg-error.ts` 是分类不是翻译**:输出 SQLSTATE 事实与判定函数;HTTP 语义(4xx/5xx)在 http 包。db 不认识 HttpError(依赖方向)。
3. **`transaction.ts` 策略必填**(铁律 3):v1 隐藏的 {5,15,20} 由装配层注入;测试注入同值证明行为等价,装配默认值归未来 apps 的 config schema。
4. **`runTx` 句柄类型用重载支持 `Db | DbTx`**:v1 三包靠 `AnyPgDatabase<any>` 规避 drizzle 泛型不变性;v2 自持 schema 无此需求,重载给两态精确类型。
5. **迁移一致性测试(新增门禁)**:journal↔SQL 文件 1:1、tag 编号严格递增无重复、历史缺口(0036/idx37)显式断言——v1 从未有过任何迁移链结构检查。
6. **测试分层**:unit(无 PG,默认门禁)+ real(真实 PG,缺 DATABASE_URL 自动 skip,不进默认门禁;资金级边界行为——SAVEPOINT、唯一冲突、advisory lock——必须真实 PG,总纲 §5.6)。

## 4. 测试计划(v1 零测试,全部新增;铁律 14 目录约定:包根 `__test__/` 平铺)

| 测试文件                     | 覆盖         | 关键用例                                                                                                                                                                                                                                        |
| ---------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **test**/migrations.test.ts  | 迁移链结构   | journal 条目 ↔ SQL 文件 1:1 双向;tag 编号严格递增;历史缺口 0036/idx37 断言在案                                                                                                                                                                  |
| **test**/pg-error.test.ts    | 错误分类     | 深度 0/1/3/5/10 的 23505 与 40P01/40001;非字符串 code / 无 code / 无 cause;约束名提取(有/无名);**B3 回归:深度 4 的 23505(wallet v1 盲区)必须检出**;5 位大写码正则边界(4 位/6 位/小写不匹配)                                                     |
| **test**/transaction.test.ts | 事务壳       | 首试成功直通;瞬态→重试→成功;非瞬态一次抛出;耗尽 maxAttempts 抛最后错误;退避序列 = base·2^attempt + [0,maxJitter)(fake timers,累计时刻 25/65/135ms);onRetry 收到 {attempt, code};onRetry 抛错被吞                                                |
| **test**/client.test.ts      | 连接         | 池参数逐字段透传(spy pg.Pool 构造);无默认值(类型面:缺字段编译失败);closeDb → $client.end;ping 走 real                                                                                                                                           |
| **test**/schema.test.ts      | 表定义结构   | 39 表导出齐备(v1 清单,封闭词表);**外键物化:遍历全部 FK 调用 reference(),断言目标表均在封闭集合内**(同时执行所有 `.references(() => …)` 惰性回调);users/admins default 引用 ACCOUNT_STATUS;全 src 零跨包 import 断言                             |
| **test**/pg.real.test.ts     | 真实 PG 语义 | createDb→ping→closeDb;runTx 提交可见/回滚不可见;**SAVEPOINT:外层事务内 runTx 失败只回滚内层**;advisoryLock 同事务可重入;真实 23505 检测 + uniqueViolationConstraint 拿到约束名(`*.real.test.ts` 按文件名排除默认门禁,缺 DATABASE_URL 自动 skip) |

**真实 PG 的行为规格锚点**:SAVEPOINT 退化、唯一冲突阻塞-重放、advisory lock 互斥,是 P4 资金波次(billing)复用本包时的不变量前提,real 层必须有;DATABASE_URL 缺失时整组 skip(与 ai 包 `*.real.test.ts` 同约定,铁律 14)。

## 5. 实施阶段(每阶段独立提交 + 四门全绿)

| 阶段 | 内容                                                                                                                                                                                                                             | 提交引用                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| P0   | 本文档 + DESIGN.md 定稿                                                                                                                                                                                                          | `d6f8575` ✅                                                                              |
| P1   | schema 32 文件(3 处微修)+ 迁移链原样 + drizzle.config + package.json/tsconfig/vitest 接线 + migrations/schema 单测                                                                                                               | `4529f53` ✅(schema/迁移文件本体因并行会话的整树提交先期入库,内容与本文裁决一致,差异为零) |
| P2   | client/context/pg-error/transaction 四件 + 单测(B3 回归用例)                                                                                                                                                                     | `710a9ad` ✅                                                                              |
| P3   | real 集成测试 + 行为核销 + 状态推进「已完成」                                                                                                                                                                                    | `fda8a19` ✅                                                                              |
| P4   | 新规适配(铁律 14/16):测试迁 `__test__/` 平铺 + `*.real.test.ts` 文件名区分;覆盖率阈值 90/85 写入 vitest;新增外键物化契约测试                                                                                                     | `128a83d` ✅                                                                              |
| P5   | §11 错误根契约采纳:db→`@tokenlens/errors` 依赖(白名单唯一内部依赖);ping 失败源头分类为 `InfrastructureError('db.unavailable')`(cause 链保留 pg 事实,SQLSTATE 裸上浮 + pg-error 事实层维持不变——协议翻译归 http);边界测试白名单化 | 本次提交 ✅                                                                               |

## 6. 验收清单(全部满足才算完成)

- [x] 四门全绿(typecheck / lint 0 错 / test 39 单测 + 6 real / build 双入口产物);
- [x] 表定义与 v1 逐字一致(微修改仅 B1/B4 三处;接管时与旧仓 diff 为零,P1 提交记录);
- [x] 迁移链 76 件(0076 identity 七表,f716844 收口),一致性测试绿(journal↔SQL 1:1 双向、编号单调、缺口 0036/idx37 断言在案);
- [x] db 零内部依赖(package.json 无 @tokenlens/*;schema.test 扫全 src import 行断言);
- [x] createDb/runTx 无隐藏默认(参数全必填;client.test 含 @ts-expect-error 类型面证明);
- [x] B3 回归用例绿(深度 4/7 的 23505 均检出);
- [x] runTx 注入 {5,15,20} 时重试语义与 v1 三拷贝等价(退避公式 fake-timers 验证累计 25/65/135ms、尝试上限、仅瞬态触发、钩子吞错);
- [x] real PG 用例绿(本地 PG,DATABASE_URL 显式注入):SAVEPOINT 内层回滚外层提交、真实 23505 检出含约束名 `kv_pkey`、advisoryLock 同事务同键重入、瞬态重试端到端、closeDb 后连接拒绝;scratch schema 结束即删;
- [x] **空库迁移探针**(一次性手工验证,临时库已删):drizzle 编程式 migrator 在全新库上推进至 0055 失败(`identity_session_anchors` 不存在,由 identity-core provision 建)并整体回滚——与 v1 CI 注释记录的行为一致;结论:**空库升级范围 = 0000-0054**,0055+ 需 provision 链先行(C4 收口属 P4 能力波次);
- [x] 不移植清单(C1-C8)各有归属标注,无孤儿;
- [x] 铁律 14/16 适配(2026-08-23 新规):`__test__/` 平铺 + `pg.real.test.ts` 文件名区分;覆盖率阈值 90/85 落入 vitest thresholds——P5 后实测 **99.52% statements / 100% branches / 99.17% functions / 99.46% lines**(41 单测,client.ts 100%),达标未调阈值;
- [x] §11 错误根契约(2026-08-23 新规):依赖白名单收窄为 `@tokenlens/errors` 单内部依赖;ping 失败 = `InfrastructureError('db.unavailable')`(isInfrastructureError 守卫用例锁定);runTx/pg 事实层不包装不改判(禁止清单合规);bun.lock 因混有 runtime 流同款变更未随本提交入库(铁律 15,待协调收口)。
- [x] seed-dev 移植核销(2026-08-23,C5 回销):`scripts/seed-dev.ts` 逐语义移植,cipher 替换(runtime enc:v1)与差异清单见 §1.3 C5;门禁复核 typecheck 0 错 / lint 0 警 0 错(47 文件) / 41 单测全绿;dev 库实跑两轮幂等验证。

## 7. 回滚方案

- 每阶段提交独立可 revert;P1-P3 均为新增文件,不触碰 ai 包与根配置(仅新增 workspace 成员,bun.lock 随 P1 提交)。
- 迁移链为纯复制,revert 无数据面影响;新仓尚未执行任何迁移(生产库不动)。

## C4 补充(边界收口轮):drizzle snapshot 链与 db:generate

- **事实**:meta snapshot 止于 0054(0055-0076 为 provision 依赖期与 DDL-first 手写件,
  无对应 snapshot);journal 尾条 0076 的 when 为收口回填值,0047/0048 历史非单调已修正。
- **风险**:基于 0054 snapshot 运行 `drizzle-kit generate` 会把 0055-0076 的 DDL 重新
  生成一遍(重复迁移)。
- **处置**:移除 `db:generate` 脚本(本仓迁移为手写 DDL-first 实践,0076 已验证该路径);
  若未来需要恢复生成链,必须先补齐 0055-0076 snapshot 并以空库/存量双验证护航,
  按总纲 §3.5 ADR 流程裁决。
