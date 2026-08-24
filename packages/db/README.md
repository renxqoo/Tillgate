# @tokenlens/db

> PostgreSQL 连接、事务、schema 与迁移——物理 schema 登记点,不放业务用例(内部依赖仅 @tokenlens/errors,§5.1 白名单)。
> 设计基线 [DESIGN.md](./DESIGN.md) · 施工图 [IMPLEMENTATION.md](./IMPLEMENTATION.md)

一句话:**物理 schema、迁移顺序和事务基础设施的统一登记点,不是业务事实所有者**——
表定义在此登记,表语义的消费与演进属于各能力包(总纲 §3.4)。

## 核心导出面

- 连接与生命周期:`createDb`(池参数全部必填注入——url / poolMax / idleTimeout 等,
  零隐藏默认,铁律 3;池对象不外泄)、`ping`(健康探测,失败源头分类
  `InfrastructureError('db.unavailable')`)、`closeDb`。
- 事务:`runTx`(重试策略 `TxRetryPolicy` 装配注入)、`advisoryLock`(pg 顾问锁);
  `DbLike`(Db | DbTx)作为 port 方法首参类型,让 adapter 参与调用方事务。
- PG 错误分类:`pgSqlState` / `isUniqueViolation` / `uniqueViolationConstraint` /
  `transientTxFailureCode`——裸 SQLSTATE 事实上浮供消费方判定,→HTTP 翻译归 http 包。
- `./schema` 子入口:46 表(v1 基线 39 + identity 七表)+ 词表 + relations 的**物理 schema
  登记点**(根入口亦 `export *` schema)。
- 迁移链:`migrations/` 0000–0076 共 76 个 SQL(journal 历史缺口 0036;最新
  `0076_identity_tables.sql`)+ `meta/` journal——**不可改写的物理事实**,已应用于
  生产的 SQL 一字不改。

## 常用命令

```bash
cd packages/db
DATABASE_URL=postgres://... bun run db:migrate   # drizzle-kit migrate(连接串必填、无默认)
DATABASE_URL=postgres://... bun run db:studio    # drizzle-kit studio 浏览器查看 schema
DATABASE_URL=... ENCRYPTION_KEY=... bun scripts/seed-dev.ts
# 开发种子:用户+费率卡+管理员+测试虚拟 Key(sk_xxx)+供应商/渠道/模型映射;
# 幂等按唯一键判存;DEEPSEEK_API_KEY / MINIMAX_API_KEY 可选(缺则跳过该供应商段)
```

注意:`request_logs` 自迁移 0040 起是分区母表——禁止对它跑 `db:generate`
(`drizzle.config.ts` 头注释 / IMPLEMENTATION.md B5)。

## 目录结构

```
src/
├── client.ts      # createDb/ping/closeDb:池创建与健康探测
├── transaction.ts # runTx(重试注入) + advisoryLock
├── context.ts     # DbLike 会话上下文类型
├── pg-error.ts    # SQLSTATE 探测与分类
├── schema/        # 46 表定义 + 词表 + relations(./schema 子入口)
└── index.ts       # 公共出口(含 schema 整体转出口)
migrations/        # 迁移链 0000–0076 + meta journal
scripts/seed-dev.ts # 开发环境种子数据
drizzle.config.ts  # drizzle-kit 配置(DATABASE_URL 必填)
```

## 装配

消费方:全部后端 app——`apps/admin-api` / `apps/client-api` / `apps/gateway` /
`apps/trace-receiver` / `apps/worker` 的 `src/assembly.ts` 各自 `createDb` 装配,
并把 `Db` / `TxRetryPolicy` 注入各能力包。

## 开发

```bash
cd packages/db
bun run typecheck && bun run lint && bun run test
DB_TEST_URL=postgres://... bun run test:real   # pg.real.test.ts 真库门(DB_TEST_URL 优先,
                                               # 缺 env 整组 skip)
```
