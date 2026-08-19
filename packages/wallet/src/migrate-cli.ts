import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { migrateWallet } from './schema';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';

const pool = new Pool({ connectionString, max: 1 });
try {
  await migrateWallet(drizzle(pool));
} finally {
  await pool.end();
}
