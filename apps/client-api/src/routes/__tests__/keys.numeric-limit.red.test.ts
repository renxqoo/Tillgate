import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { users, apiKeys } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { keyRoutes } from '../keys.js';
import { makeClientTestApp, makeServices } from '../../test/helpers.js';

/**
 * C2 红测：dailySpendLimit 传 1e21（zod min(0) 放行）→ numeric(38,18) 溢出
 * → PG 22003 → 500。可预期输入错误必须在 zod 层 400。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });
let connected = false;
beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

describe('RED C2: POST /api/keys dailySpendLimit=1e21 → 400（不得 500）', () => {
  it('超大日限额被 zod 拒绝', async (context) => {
    if (!connected) return context.skip();
    const s = `${Date.now()}`;
    const [u] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__c2u_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    try {
      const app = makeClientTestApp(u!.id, { '/keys': keyRoutes(makeServices(db)) });
      const res = await app.request('/api/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `c2-${s}`, dailySpendLimit: 1e21 }),
      });
      expect(res.status).toBe(400);
      const keys = await db.select({ id: apiKeys.id }).from(apiKeys).where(eq(apiKeys.userId, u!.id));
      expect(keys.length).toBe(0);
    } finally {
      await db.delete(apiKeys).where(eq(apiKeys.userId, u!.id));
      await db.delete(users).where(eq(users.id, u!.id));
    }
  });
});
