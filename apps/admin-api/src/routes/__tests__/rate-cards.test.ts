import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { rateCards, rateCardCoefficients, users } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { rateCardAdminRoutes } from '../rate-cards.js';
import { makeAdminTestApp, makeServices } from '../../test/helpers.js';

/**
 * 费率卡管理路由（集成）。
 * 不变量：创建必须带 global 系数；删除仅当无用户绑定；系数保留 3 位小数。
 */

loadRootEnvFile();

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });

let connected = false;
beforeAll(async () => {
  try {
    await db.query.users.findFirst({ where: eq(users.id, 1), columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => {
  await db.$client.end().catch(() => {});
});

async function cleanupCard(name: string): Promise<void> {
  const cards = await db.select().from(rateCards).where(eq(rateCards.name, name));
  for (const c of cards) {
    await db.delete(rateCardCoefficients).where(eq(rateCardCoefficients.rateCardId, c.id));
    await db.delete(rateCards).where(eq(rateCards.id, c.id));
  }
}

describe('费率卡管理路由（集成）', () => {
  it('创建 → 列表 → 更新 → 删除 全流程', async () => {
    if (!connected) return it.skip('no DB');
    const name = 'test-card-' + Date.now();
    const app = makeAdminTestApp({ '/rate-cards': rateCardAdminRoutes(makeServices(db)) });
    try {
      // 创建（必须带 coefficient）
      const createRes = await app.request('/api/admin/rate-cards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, coefficient: 1.5, description: 'test' }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: number; name: string; coefficient: string };
      expect(created.name).toBe(name);
      expect(created.coefficient).toBe('1.500');
      const cardId = created.id;

      // 列表含新建卡
      const listRes = await app.request('/api/admin/rate-cards');
      const list = (await listRes.json()) as { list: Array<{ id: number; coefficient: string }> };
      const found = list.list.find((r) => r.id === cardId);
      expect(found).toBeDefined();
      expect(found!.coefficient).toBe('1.500');

      // health：全局系数存在
      const healthRes = await app.request(`/api/admin/rate-cards/${cardId}/health`);
      const health = (await healthRes.json()) as { hasGlobalCoefficient: boolean };
      expect(health.hasGlobalCoefficient).toBe(true);

      // 更新系数
      const updRes = await app.request(`/api/admin/rate-cards/${cardId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ coefficient: 0.8, description: 'updated' }),
      });
      expect(updRes.status).toBe(200);
      const list2 = (await (await app.request('/api/admin/rate-cards')).json()) as { list: Array<{ id: number; coefficient: string }> };
      const found2 = list2.list.find((r) => r.id === cardId);
      expect(found2!.coefficient).toBe('0.800');

      // 删除（无用户绑定）
      const delRes = await app.request(`/api/admin/rate-cards/${cardId}`, { method: 'DELETE' });
      expect(delRes.status).toBe(200);
      const list3 = (await (await app.request('/api/admin/rate-cards')).json()) as { list: Array<{ id: number }> };
      expect(list3.list.find((r) => r.id === cardId)).toBeUndefined();
    } finally {
      await cleanupCard(name);
    }
  });

  it('有用户绑定的卡 → 删除被拒（409）', async () => {
    if (!connected) return it.skip('no DB');
    const name = 'bound-card-' + Date.now();
    const s = `${Date.now()}`;
    const app = makeAdminTestApp({ '/rate-cards': rateCardAdminRoutes(makeServices(db)) });
    const [user] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__rc_user_${s}`, identityProvider: 'local' })
      .returning({ id: users.id });
    try {
      const createRes = await app.request('/api/admin/rate-cards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, coefficient: 1 }),
      });
      const created = (await createRes.json()) as { id: number };
      // 绑定用户到该卡
      await db.update(users).set({ rateCardId: created.id }).where(eq(users.id, user!.id));

      const delRes = await app.request(`/api/admin/rate-cards/${created.id}`, { method: 'DELETE' });
      expect(delRes.status).toBe(409);
      const body = (await delRes.json()) as { error: { code: string } };
      expect(body.error.code).toBe('RATE_CARD_IN_USE');
    } finally {
      await db.update(users).set({ rateCardId: null }).where(eq(users.id, user!.id)).catch(() => {});
      await db.delete(users).where(eq(users.id, user!.id)).catch(() => {});
      await cleanupCard(name);
    }
  });
});
