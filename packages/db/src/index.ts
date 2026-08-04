export * from './schema/index.js';

import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

/**
 * 建立 Drizzle 实例（宿主注入 DATABASE_URL，或默认本地开发地址）。
 * 传 schema 让 db.query.* 有完整类型 + 支持 relational queries（with: { ... }）。
 *
 * H3 连接池配置：
 *   - max: 连接池上限（默认 20；按实例数 × 并发预估，防打爆 PG max_connections）
 *   - idleTimeoutMillis: 空闲连接回收（30s，防泄漏）
 *   - connectionTimeoutMillis: 连接获取超时（5s，DB 不可用时快速失败而非无限等待）
 *   - maxUses: 单连接最大使用次数（防长连接内存泄漏，1000 次后回收重建）
 */
export function createDb(
  url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 20, // 连接池上限
    idleTimeoutMillis: 30_000, // 空闲连接 30s 后回收
    connectionTimeoutMillis: 5_000, // 连接获取超时 5s
    maxUses: 1_000, // 单连接最大使用次数（防长连接内存泄漏）
  });
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;
