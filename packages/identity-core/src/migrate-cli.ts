import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { provision } from './schema';

const connectionString =
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway';

const pool = new Pool({ connectionString, max: 1 });
try {
  await provision(drizzle(pool));
} finally {
  await pool.end();
}
