/** vitest globalSetup：login-challenge 适配层测试需要 identity-core 七表——
 *  进程启动时建独立 schema（与业务库物理隔离），结束时删。 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { provision } from '@ai-gateway/identity-core';

export default async function setup(): Promise<() => Promise<void>> {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
  const schema = `identity_pkg_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`create schema ${schema}`);
  process.env.IDENTITY_PKG_TEST_SCHEMA = schema;
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const db = drizzle(pool);
  await provision(db);
  return async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
    delete process.env.IDENTITY_PKG_TEST_SCHEMA;
  };
}
