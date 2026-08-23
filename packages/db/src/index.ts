/**
 * @tokenlens/db 公共出口:连接、事务、schema、迁移、PG 错误分类(DESIGN.md §1)。
 * 业务 SQL / Repository CRUD / PG→HTTP 翻译不在此(总纲 §3.4;零内部依赖)。
 */

// ---- 连接与生命周期 ----
export { createDb, ping, closeDb } from './client.js';
export type { DbPoolConfig, Db, DbTx } from './client.js';

// ---- 会话上下文 ----
export type { DbLike } from './context.js';

// ---- 事务 ----
export { runTx, advisoryLock } from './transaction.js';
export type { TxRetryPolicy, TxRetryHooks } from './transaction.js';

// ---- PG 错误分类 ----
export {
  pgSqlState,
  isUniqueViolation,
  uniqueViolationConstraint,
  transientTxFailureCode,
} from './pg-error.js';

// ---- schema(46 表(v1 基线 39 + identity 七表,迁移 0076) + 词表 + relations;另有 ./schema 子入口)----
export * from './schema/index.js';
