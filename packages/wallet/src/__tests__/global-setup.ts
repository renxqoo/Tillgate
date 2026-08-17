/** vitest globalSetup：全部测试文件共享一套 wallet 表——进程启动时建、结束时删。
 *  取代单文件时代的 beforeAll/afterAll（多文件并行下各自建删表会互相拆台）。 */
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { deprovision, provision } from '../schema';

export default async function setup(): Promise<() => Promise<void>> {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  });
  const db = drizzle(pool);
  await deprovision(db);
  await provision(db);
  return async () => {
    await deprovision(db);
    await pool.end();
  };
}
