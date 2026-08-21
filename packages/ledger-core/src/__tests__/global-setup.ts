/** vitest globalSetup：全部测试文件共享 ledger_operations——独立 schema 建删，与业务库物理隔离。 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { provision } from '../schema';

export default async function setup(): Promise<() => Promise<void>> {
  const connectionString =
    process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';
  const schema = `ledger_test_${process.pid}_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString });
  await admin.query(`create schema ${schema}`);
  process.env.LEDGER_TEST_SCHEMA = schema;
  const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
  const db = drizzle(pool);
  await provision(db);
  return async () => {
    await pool.end();
    await admin.query(`drop schema ${schema} cascade`);
    await admin.end();
    delete process.env.LEDGER_TEST_SCHEMA;
  };
}
