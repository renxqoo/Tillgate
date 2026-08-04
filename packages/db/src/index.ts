export * from './schema/index.js'

import { drizzle } from 'drizzle-orm/node-postgres'
import pg from 'pg'

/** 建立 Drizzle 实例（宿主注入 DATABASE_URL，或默认本地开发地址） */
export function createDb(url = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway') {
  const pool = new pg.Pool({ connectionString: url })
  return drizzle(pool)
}

export type Db = ReturnType<typeof createDb>
