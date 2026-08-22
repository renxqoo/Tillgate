/**
 * @tokenlens/db 公共出口。
 *
 * P1 阶段:schema 面(39 表 + 词表 + relations)。
 * P2 落地 client/context/transaction/pg-error 四件后进入本出口(IMPLEMENTATION.md §5)。
 *
 * 职责边界(DESIGN.md §2):连接、事务、schema、迁移、PG 错误分类;
 * 业务 SQL / Repository CRUD / HTTP 翻译一律不在此(总纲 §3.4)。
 */

export * from './schema/index.js';
