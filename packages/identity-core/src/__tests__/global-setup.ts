/** vitest globalSetup：全部测试文件共享一套 identity 表——进程启动时建独立 schema、结束时删。
 *  与业务库物理隔离（同一 PG 实例、独立 schema），互不拆台。 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { provision } from '../schema';

export default async function setup(): Promise<() => Promise<void>> {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
  const schema = `identity_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`create schema ${schema}`);
  process.env.IDENTITY_TEST_SCHEMA = schema;
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const db = drizzle(pool);
  await provision(db);
  return async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
    delete process.env.IDENTITY_TEST_SCHEMA;
  };
}
