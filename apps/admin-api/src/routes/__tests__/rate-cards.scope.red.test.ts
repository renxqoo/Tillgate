import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { modelMappings, rateCards, rateCardCoefficients } from '@ai-gateway/db/schema';
import { loadRootEnvFile } from '@ai-gateway/http';
import { rateCardAdminRoutes } from '../rate-cards.js';
import { makeAdminTestApp, makeServices } from '../../test/helpers.js';

/**
 * M1 回归锁定：更新全局系数只允许碰 scope=global 兜底行。
 * schema（rate_card_coefficients_uq (rateCardId, scope, modelMappingId)）支持
 * model/group 级覆盖系数行——一旦存在，改全局系数若无 scope 过滤会把所有
 * 模型级系数一并拍平（定价静默漂移）。
 * 数据纪律：全部 p1api- 前缀，finally 只删自己创建的行。
 */

loadRootEnvFile();

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);

let connected = false;
beforeAll(async () => {
  try {
    await db.query.rateCards.findFirst({ columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

describe('费率卡全局系数更新不得拍平模型级系数（M1）', () => {
  it('PATCH coefficient：global 行被更新，scope=model 行保持原系数', async () => {
    if (!connected) return it.skip('no DB');
    const suffix = `p1api-${Date.now()}`;
    const cardName = `${suffix}-card`.slice(0, 32);
    const [mapping] = await db
      .insert(modelMappings)
      .values({
        externalName: `${suffix}-model`.slice(0, 64),
        realModel: `${suffix}-real`,
        status: 0,
        inputPrice: '1',
        outputPrice: '1',
        cacheInputPrice: '1',
      })
      .returning({ id: modelMappings.id });
    const app = makeAdminTestApp({ '/rate-cards': rateCardAdminRoutes(makeServices(db)) });
    try {
      // 建卡（路由自动落 global 系数行）
      const createRes = await app.request('/api/admin/rate-cards', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: cardName, coefficient: 1.5 }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { id: number };
      // 追加一行模型级覆盖系数（唯一索引 (rateCardId, scope, modelMappingId) 允许共存）
      await db.insert(rateCardCoefficients).values({
        rateCardId: created.id,
        scope: 'model',
        modelMappingId: mapping!.id,
        coefficient: '2.500',
      });

      // 改全局系数
      const updRes = await app.request(`/api/admin/rate-cards/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ coefficient: 0.8 }),
      });
      expect(updRes.status).toBe(200);

      const coeffs = await db
        .select()
        .from(rateCardCoefficients)
        .where(eq(rateCardCoefficients.rateCardId, created.id));
      expect(coeffs).toHaveLength(2);
      const globalRow = coeffs.find((r) => r.scope === 'global');
      const modelRow = coeffs.find((r) => r.scope === 'model');
      // global 行按本次改动更新
      expect(globalRow?.coefficient).toBe('0.800');
      // 模型级覆盖系数必须原样保留——本用例回归点
      expect(modelRow?.coefficient).toBe('2.500');
    } finally {
      const cards = await db.select().from(rateCards).where(eq(rateCards.name, cardName));
      for (const card of cards) {
        await db.delete(rateCardCoefficients).where(eq(rateCardCoefficients.rateCardId, card.id));
        await db.delete(rateCards).where(eq(rateCards.id, card.id));
      }
      await db.delete(modelMappings).where(eq(modelMappings.id, mapping!.id));
    }
  });
});
