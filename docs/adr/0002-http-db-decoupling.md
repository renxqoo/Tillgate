# ADR-0002：http ↔ db 解耦——SQLSTATE 探测注入、翻译表留 http、drizzle 列表件不迁移

> 状态：Accepted（2026-08-23）
> 关联：[project-structure-refactoring.md](../project-structure-refactoring.md) §3.5 必需 ADR 清单第 3 项（存量违规解耦路径：`http → db`）、§5.1（http 不依赖 db）、
> [ADR-0001](./0001-errors-registry-ownership.md)；[packages/db/DESIGN.md](../../packages/db/DESIGN.md) §2（PG 翻译表归属 http 的裁决）、
> [packages/http/DESIGN.md](../../packages/http/DESIGN.md)、[packages/http/IMPLEMENTATION.md](../../packages/http/IMPLEMENTATION.md)

## 背景

v1 `packages/http` 依赖 `@ai-gateway/core` + `@ai-gateway/db` + drizzle-orm + ioredis，四处越界：

1. `errors.ts` 的 PG SQLSTATE→4xx 翻译直接调用 core 的 `pgSqlState`（cause 链探测实现）——
   http → core → pg 实现耦合；
2. `list-query.ts`（searchCondition/resolveOrderBy/buildList/countAll）import drizzle-orm 与
   `@ai-gateway/db` 的 `Db` 类型——DB 查询组装住进 http；
3. `audit.ts` 直接写 `audit_logs` 表——审计持久化住进 http；
4. `redis.ts`/`testing.ts` 持有 Redis 连接工厂与测试装置。

v2 依赖白名单（结构方案 §5.1）：`http` 只依赖 `errors`；`db` 的 SQLSTATE 探测
（`pgSqlState`，全 cause 链）已按 db DESIGN 落在 `@tillgate/db`。本 ADR 裁决两者的接缝。

## 决策

1. **翻译表留 http，探测实现留 db，装配期注入**：v1 `PG_CODE_MAP` 六码
   （23505/23503/23514/22001/22P02/22003 → 4xx）是 HTTP 边界语义（可预期拒绝不得伪装 500），
   归 http；`errorHandler` 收 `sqlState?: (err) => string | null` 探测函数参数，app 装配时注入
   `@tillgate/db` 的 `pgSqlState`。未注入时该分支不激活（纯 http 消费面无 PG 翻译）。
   翻译产物是 `http.pg_*` 目录业务错误（category 语义化：23505→conflict，其余→invalid_input）。
2. **drizzle 列表组装件不随 http 迁移**：`searchCondition` / `resolveOrderBy` / `buildList` /
   `countAll` 是 DB 查询组装（依赖 drizzle Column/SQL/PgTable 与 Db 句柄），进 http 违反
   「禁止 DB 查询」；进 db 违反其 DESIGN（连接/事务/schema/迁移之外不收）。裁决：**不移植**，
   留在旧仓只读；归宿由首个列表端点消费者迁移单元（能力包 adapters 或 app routes，P4/P5）
   裁决——若多包重复压力成立，届时以新 ADR 升格为共享件并选定归宿。
   纯 query-string 半边（sort/search schema、`escapeLike`、`listQuerySchema`）随 http 迁移。
3. **audit / redis / load-env 不迁**：`audit.ts` 归 `observability`（审计持久化）+ 能力包
   （action 语义）；`redis.ts`/`testing.ts` 已由 `runtime` 的 createRedisClient 与 `./testing`
   子入口以更完整形态接管；`load-env.ts` 归根目录 vitest 共享配置/runtime（P1 纪律）。

## 备选方案与取舍

| 备选 | 否决理由 |
| --- | --- |
| http 依赖 db 直接调 pgSqlState | 违反 §5.1 白名单；http 的纯消费面（无 DB 的 app）被迫拖入 pg/drizzle |
| 翻译表也搬进 db | 翻译是「可预期拒绝不得伪装 500」的 HTTP 边界语义；db 零协议依赖（其 DESIGN §0.2），搬入即破坏 |
| 翻译表搬进能力包 | 六码是全局面兜底（v1 注释：路由层业务语义的漏网兜底），逐包复制必然漂移 |
| drizzle 列表件进 db 包 | db DESIGN §1.2 已定稿排除（业务 SQL/CRUD 归能力包；组装件非连接/事务/schema/迁移职责） |
| drizzle 列表件以 `http/drizzle` 子入口保留 | 「DB 查询禁止进入 http」的结构红线不因入口拆分豁免；且当前无消费者（铁律 4） |

## 影响

- v2 http 依赖面收敛为 `@tillgate/errors` + hono + @hono/node-server + zod；
  `sqlState` 是唯一与 db 的接缝（函数注入，编译期无依赖）。
- db 侧无需改动；`pgSqlState` 的消费者契约由本 ADR 固定（`(err: unknown) => string | null`）。
- v1 `list-query` 的 INVALID_SORT_FIELD 白名单拒绝语义（含原型链穿透防护）暂离场，
  随 drizzle 半边在其归宿迁移单元复活并由其测试锁定；http 侧只保留 schema 容错解析。
- 旧仓对应文件保持只读，不删除（旧 app 仍在消费）；切换发生在 app 迁移单元（P5）。
