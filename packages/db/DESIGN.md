# @tillgate/db 设计基线(DESIGN)

> 状态:定稿
> 迁移单元:db 基础设施包——连接、事务、schema、迁移、PG 错误分类(不是垂直业务用例)
> 旧实现:`/Users/wrr/work/ai-getway/packages/db`(index 35 行 + schema 32 文件 ~2.4k 行 + 迁移 75 件 + seed 259 行,**零测试**),以及分散在 core / wallet / ledger-core / identity-core / repository 的事务与错误分类基础设施(SQLSTATE 探测 4 份、runTx 3 份、事务句柄类型 4 种变体)
> 目标位置:`/Users/wrr/work/Tillgate/packages/db`
> 关联:docs/project-structure-refactoring.md §3(db 目标结构)、§3.4(schema 登记点职责)、§5.1(依赖白名单:db → 仅 errors;logger/clock 经参数注入)、§9 P3;审计与裁决见同目录 [IMPLEMENTATION.md](./IMPLEMENTATION.md)

---

## 0. 原则

1. **db 是物理 schema、迁移顺序和事务基础设施的统一登记点,不是业务事实所有者**(总纲 §3.4【用户裁决=总纲文档】)。表定义在此登记,表语义的消费与演进属于各能力包。
2. **依赖白名单 = 仅 `@tillgate/errors`**(总纲 §5.1;AGENTS.md §11 错误根契约):db 自产的基础设施错误按根契约源头分类(`InfrastructureError` 自由码,如 `db.unavailable`);PG SQLSTATE 裸事实经 `pg-error.ts` 上浮供消费方判定,协议边界翻译(→HTTP)归 http 包。v1 对 ledger-core 的反向依赖清除(IMPLEMENTATION.md B1);除此之外零内部依赖。
3. **零隐藏默认**(铁律 3):连接串、池参数、重试策略全部必填注入;v1 的 6 处硬编码默认连接串与三份 runTx 的魔法数(5 次 / 15ms 基数 / 20ms 抖动)全部显式化到装配层。
4. **迁移链是不可改写的物理事实**:76 件迁移(0000-0075,含 journal 历史缺口 0036/idx37)原样接管,已应用于生产的 SQL 一字不改;空库可迁移范围受 0055+ 与包外 provision 链耦合限制(IMPLEMENTATION.md C4)。

## 1. 外部契约(v2 API,定稿)

```ts
import {
  createDb,
  ping,
  closeDb,
  runTx,
  advisoryLock,
  pgSqlState,
  isUniqueViolation,
  uniqueViolationConstraint,
  transientTxFailureCode,
} from '@tillgate/db';
import { users, walletAccounts, ACCOUNT_STATUS } from '@tillgate/db/schema';

// 连接(全部必填,无默认——装配层从 env 读)
const db = createDb({
  url, // 连接串
  poolMax, // 池上限(并行测试:worker 数 × poolMax < PG max_connections)
  idleTimeoutMillis, // 空闲回收
  connectionTimeoutMillis, // 取连接超时(不可用时快速失败)
  maxUses, // 单连接最大使用次数(防长连接内存泄漏)
});
// db: Db —— drizzle node-postgres + 全 schema 绑定(relational queries 可用)

await ping(db); // select 1 健康探测;失败源头分类为 InfrastructureError('db.unavailable'),
// cause 链保留 pg 原始事实(pg-error 全链探测可达)
await closeDb(db); // 池优雅收口(db.$client.end();进程 shutdown 用)

// 事务执行壳:瞬态错误(40P01 死锁 / 40001 串行化失败)指数退避重试
await runTx(
  db, // 或注入 tx 句柄 → drizzle 退化为 SAVEPOINT
  async (tx) => {
    /* ... */
  },
  { maxAttempts, baseDelayMs, maxJitterMs }, // 必填(行为等价 v1 的值 = {5, 15, 20})
  { onRetry?(info) {} }, // 可选观测钩子;钩子异常吞掉(观测不参与资金决策)
);

// 事务级 advisory lock:pg_advisory_xact_lock(hashtext(key)),随事务终结自动释放
await advisoryLock(db, 'namespace.key');

// PG 错误分类(沿 cause 链全链探测,统一 v1 三种深度行为)
pgSqlState(err); // '23505' | null —— 任意 5 位 SQLSTATE
isUniqueViolation(err); // 23505 判定
uniqueViolationConstraint(err); // 23505 → 冲突约束名 | null
transientTxFailureCode(err); // '40P01' | '40001' | null
```

类型面:`Db`(池句柄)、`DbTx`(事务句柄,与 v1 同推导式)、`DbLike = Db | DbTx`(写路径注入 tx / 只读路径池句柄的统一参数型)。

schema 子入口(`@tillgate/db/schema`):39 张物理表 + `ACCOUNT_STATUS` 词表 + 19 组 drizzle relations,与 v1 同构(微修改清单见 IMPLEMENTATION.md §3 裁决表)。

### 契约细则

- **参数平铺、必填**:`createDb` 收单一配置对象,字段全必填;`runTx` 策略必填。退避公式固定为 `baseDelayMs * 2^attempt + floor(random() * maxJitterMs)`(attempt 为刚失败的第 0 基尝试序号),语义与 v1 三份拷贝逐字一致。
- **重试边界**:仅 40P01/40001 触发重试;其他错误一次抛出;总尝试数达 `maxAttempts` 后抛最后一次错误。重试前提是动词幂等(调用方责任,v1 注释语义保留)。
- **SAVEPOINT 语义**:`runTx` 收到 tx 句柄时,drizzle `transaction()` 自动退化为事务内 SAVEPOINT——提交/回滚权归外层调用方;并发同键撞唯一索引只回滚到 savepoint,由动词的重放路径接管(与 v1 wallet 语义一致)。
- **facade 不泄漏 pg 类型**:池对象不导出;生命周期仅经 `ping`/`closeDb`。
- **词表**:仅迁移列 CHECK 约束对应的词表随表定义走(`ACCOUNT_STATUS`);业务状态词表(channels 0-4、generation status、billing_requests status 等)不新增导出——待消费方落地(IMPLEMENTATION.md C3)。

## 2. 问题域

### 处理

- 连接池创建、健康探测(`select 1`)、优雅收口;
- 事务执行壳(瞬态重试 + 退避)与事务级 advisory lock;
- PG 错误分类:SQLSTATE 探测(全 cause 链)、唯一冲突(布尔/约束名)、瞬态事务错误;
- 39 张表定义 + 账号状态词表 + relations(物理 schema 唯一登记点);
- drizzle-kit 迁移链持有与执行入口(`db:generate` / `db:migrate` / `db:studio`)。

### 不处理(归属写明)

| 不处理                                                     | 归属                                                                                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| PG SQLSTATE → HTTP 语义翻译(6 码表)                        | 未来 `http` 包(v1 `http/src/errors.ts` PG_CODE_MAP)                                                                            |
| Actor / RepoContext / RunContext / inTx                    | 能力包 application 与 adapters 层(v1 repository/service context)                                                               |
| 业务锁键(credentialSetLockKey / challengeLockKey)          | 未来 `identity` 包                                                                                                             |
| runEffect(提交后 best-effort 副作用)                       | 能力包(billing / identity)——与事务无关,不进 db                                                                                 |
| 业务 SQL / Repository CRUD                                 | 能力包 `adapters/postgres`                                                                                                     |
| seeds(dev 数据装配,cipher 加密渠道 Key)                    | 已移植 `scripts/seed-dev.ts`(dev 装配面,非包运行时能力——不进 exports/依赖;cipher 经 runtime 相对路径注入,IMPLEMENTATION.md C5) |
| identity-core / ledger-core / wallet 三条 provision 链收口 | P4 能力波次,按总纲 §9 P3 纪律逐步做,禁止一次改完(C4)                                                                           |
| worker readyz 不 ping DB 的事实差异                        | apps/worker 迁移时修正(v1 已知事实,记录在案)                                                                                   |

## 3. 并发与性能预算

- **池上限由装配层显式给定**;并行测试约束 `worker 数 × poolMax < PG max_connections`(v1 注释语义保留,写入 createDb 文档注释)。
- **重试预算显式**:`maxAttempts × 退避序列` 由策略注入;无隐藏定时器、无跨请求状态。
- **事务内零外呼**:fn 内不等待网络/IO 外部资源是调用方纪律;runTx 自身仅 sleep 重试。
- **零跨请求状态**:包内不持有任何请求间可变状态;池是进程级资源,由装配方持有并收口。
- **探测成本常数**:SQLSTATE 探测沿 cause 链走,链长 = 错误包装层数(个位数),无正则回溯风险(单次 5 字符锚定匹配)。

## 4. 结构与依赖

```text
packages/db/
├── src/
│   ├── client.ts        # createDb / Db / DbTx / ping / closeDb(池配置必填)
│   ├── context.ts       # DbLike(会话统一参数型)
│   ├── transaction.ts   # runTx(策略注入)/ advisoryLock
│   ├── pg-error.ts      # pgSqlState / isUniqueViolation / uniqueViolationConstraint / transientTxFailureCode
│   ├── schema/          # 32 文件 39 表 + 词表 + relations(布局与 v1 平面一致,按能力分组待 P4)
│   └── index.ts         # 出口:基础设施四件 + schema 全量(含 ./schema 子入口)
├── migrations/          # 0000-0075 + meta/(原样接管,journal 缺口 0036/idx37 保留)
├── drizzle.config.ts    # schema 入口 / out / dialect;URL 必填(无默认)
└── __test__/            # 平铺(铁律 14):*.test.ts 默认门禁;pg.real.test.ts 真实 PG
                         # (缺 DATABASE_URL 自动 skip,单独脚本显式运行;覆盖率阈值 90/85)
```

- 依赖白名单:**零内部依赖**;运行时依赖仅 `drizzle-orm` + `pg`。
- schema 文件布局**保持 v1 平面结构**(32 文件名不变):按能力分组(identity/accounts/billing/…)是 P4 能力波次随真实归属知识落地的动作,不预先猜测(总纲 §3 树中 `schema/` 注释为目标态)。
- `db:generate` 纪律:`request_logs` 自迁移 0040 起是分区母表,**禁止对它跑 generate**(v1 注释警示原样保留);涉及该表的变更必须手写迁移。
