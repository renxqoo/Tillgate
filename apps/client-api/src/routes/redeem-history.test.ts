import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createDb, type Db } from '@ai-gateway/db';
import { redeemCodes, redeemBatches, users } from '@ai-gateway/db/schema';
import type { ClientEnv } from '@ai-gateway/identity';
import { panelRoutes } from './panel.js';

/**
 * GET /api/redeem/history：我的充值码兑换记录。
 * 只返回当前用户已兑换的（status=1），含面值/批次名，不含明文码/哈希。
 */

const cwd = dirname(fileURLToPath(import.meta.url));
function loadEnvFile(): void {
  let dir = cwd;
  for (let i = 0; i < 6; i++) {
    const f = resolve(dir, '.env');
    if (existsSync(f)) {
      for (const line of readFileSync(f, 'utf-8').split('\n')) {
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
        if (m && m[1] && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}
loadEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway');

let connected = false;
beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

function makeApp(userId: number): Hono<ClientEnv> {
  const app = new Hono<ClientEnv>();
  app.use('/api/*', async (c, next) => {
    c.set('session', { userId });
    await next();
  });
  app.route('/', panelRoutes(db));
  return app;
}

describe('GET /api/redeem/history', () => {
  it('只返回当前用户已兑换的记录，含面值/批次名（用户隔离）', async () => {
    if (!connected) return it.skip('no DB');
    const s = `${Date.now()}`;
    const [me] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__rh_me_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const [other] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__rh_ot_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    const [batch] = await db
      .insert(redeemBatches)
      .values({ name: `测试批次_${s}`, amount: '50.00', total: 10, createdBy: me.id })
      .returning({ id: redeemBatches.id });

    const codeIds: number[] = [];
    try {
      const [c1] = await db
        .insert(redeemCodes)
        .values({ batchId: batch.id, codeHash: randomUUID(), status: 1, usedBy: me.id, usedAt: new Date() })
        .returning({ id: redeemCodes.id });
      codeIds.push(c1.id);
      // 别人的兑换记录，不应返回
      const [c2] = await db
        .insert(redeemCodes)
        .values({ batchId: batch.id, codeHash: randomUUID(), status: 1, usedBy: other.id, usedAt: new Date() })
        .returning({ id: redeemCodes.id });
      codeIds.push(c2.id);

      const res = await makeApp(me.id).request('/api/redeem/history?page=1&page_size=10');
      const json = (await res.json()) as {
        list: Array<{ id: number; amount: string; batchName: string; usedAt: string | null }>;
      };
      // eslint-disable-next-line no-console
      console.log('[redeem/history] list =', JSON.stringify(json.list));

      // 当前用户的记录在
      const mine = json.list.find((r) => r.id === c1.id);
      expect(mine).toBeDefined();
      expect(Number(mine!.amount)).toBe(50); // 面值 50 元
      expect(mine!.batchName).toContain('测试批次');
      expect(mine!.usedAt).not.toBeNull();
      // 别人的不返回（用户隔离）
      expect(json.list.find((r) => r.id === c2.id)).toBeUndefined();
    } finally {
      for (const id of codeIds) await db.delete(redeemCodes).where(eq(redeemCodes.id, id)).catch(() => {});
      await db.delete(redeemBatches).where(eq(redeemBatches.id, batch.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, me.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, other.id)).catch(() => {});
    }
  });
});
