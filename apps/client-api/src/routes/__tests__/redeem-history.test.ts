import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { redeemCodes, redeemBatches, users, admins } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { redeemRoutes } from '../redeem.js';
import { makeClientTestApp, makeServices } from '../../test/helpers.js';

/**
 * GET /api/redeem/history：我的充值码兑换记录。
 * 只返回当前用户已兑换的（status=1），含面值/批次名，不含明文码/哈希。
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
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

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
    // redeem_batches.created_by 有 FK 指向 admins 表：需先建一个管理员行
    const [admin] = await db
      .insert(admins)
      .values({ email: `rh-admin-${s}@test.local`, displayName: `rh-admin-${s}`, passwordHash: randomUUID(), status: 0 })
      .returning({ id: admins.id });
    const [batch] = await db
      .insert(redeemBatches)
      .values({ name: `测试批次_${s}`, amount: '50.00', total: 10, createdBy: admin!.id })
      .returning({ id: redeemBatches.id });

    const codeIds: number[] = [];
    try {
      const [c1] = await db
        .insert(redeemCodes)
        .values({ batchId: batch!.id, codeHash: randomUUID(), status: 1, usedBy: me!.id, usedAt: new Date() })
        .returning({ id: redeemCodes.id });
      codeIds.push(c1!.id);
      // 别人的兑换记录，不应返回
      const [c2] = await db
        .insert(redeemCodes)
        .values({ batchId: batch!.id, codeHash: randomUUID(), status: 1, usedBy: other!.id, usedAt: new Date() })
        .returning({ id: redeemCodes.id });
      codeIds.push(c2!.id);

      const app = makeClientTestApp(me!.id, { '/redeem': redeemRoutes(makeServices(db)) });
      const res = await app.request('/api/redeem/history?page=1&page_size=10');
      const json = (await res.json()) as {
        list: Array<{ id: number; amount: string; batchName: string; usedAt: string | null }>;
      };

      // 当前用户的记录在
      const mine = json.list.find((r) => r.id === c1!.id);
      expect(mine).toBeDefined();
      expect(Number(mine!.amount)).toBe(50); // 面值 50 元
      expect(mine!.batchName).toContain('测试批次');
      expect(mine!.usedAt).not.toBeNull();
      // 别人的不返回（用户隔离）
      expect(json.list.find((r) => r.id === c2!.id)).toBeUndefined();
    } finally {
      for (const id of codeIds) await db.delete(redeemCodes).where(eq(redeemCodes.id, id)).catch(() => {});
      await db.delete(redeemBatches).where(eq(redeemBatches.id, batch!.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, me!.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, other!.id)).catch(() => {});
      await db.delete(admins).where(eq(admins.id, admin!.id)).catch(() => {});
    }
  });
});
