/**
 * 费率卡语义（v1 rate-cards + rate-cards.scope.red 的 v2 对位）：
 *   - 建卡事务内落全局兜底系数（3 位小数回显）
 *   - PATCH coefficient 只触碰 scope='global' 行——model 覆写行隔离（M1 red）
 *   - 删除守卫：有用户绑定 → 409 rate_card_in_use
 *   - 健康自检：hasGlobalCoefficient
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { rateCardCoefficients, rateCards } from '@ai-gateway/db';
import { buildTestApp, db, newAdmin, newMappingRow, newUserBoundToCard, trackCard, uid } from './helpers.js';

async function createCard(request: ReturnType<typeof buildTestApp>['request'], token: string, coefficient = '1.5') {
  const name = uid('card');
  const res = await request('/v1/rate-cards', { token, body: { name, coefficient } });
  const body = (await res.json()) as { id: number; coefficient: string };
  trackCard(body.id);
  return { res, body, name };
}

describe('费率卡全流程', () => {
  it('资金系数只接受精确十进制字符串，拒绝 number、零值和超精度', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    for (const coefficient of [1.5, '0', '1.0001']) {
      const res = await request('/v1/rate-cards', {
        token,
        body: { name: uid('invalid-card'), coefficient },
      });
      expect(res.status).toBe(400);
    }
  });

  it('创建 → 列表 → 健康 → 更新 → 删除', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();

    const { res, body, name } = await createCard(request, token, '1.5');
    expect(res.status).toBe(201);
    expect(body.coefficient).toBe('1.500');

    const list = (await (
      await request(`/v1/rate-cards?q=${name}`, { token })
    ).json()) as { rows: Array<{ id: number; coefficient: string }>; total: number };
    const mine = list.rows.find((r) => r.id === body.id);
    expect(mine!.coefficient).toBe('1.500');

    const health = (await (
      await request(`/v1/rate-cards/${body.id}/health`, { token })
    ).json()) as { hasGlobalCoefficient: boolean; coefficient: string | null };
    expect(health).toEqual({ hasGlobalCoefficient: true, coefficient: '1.500' });

    const patched = await request(`/v1/rate-cards/${body.id}`, {
      method: 'PATCH',
      token,
      body: { coefficient: '0.8' },
    });
    expect(patched.status).toBe(200);
    expect(((await patched.json()) as { coefficient: string }).coefficient).toBe('0.800');

    const removed = await request(`/v1/rate-cards/${body.id}`, { method: 'DELETE', token });
    expect(removed.status).toBe(200);
    const [row] = await db.select().from(rateCards).where(eq(rateCards.id, body.id));
    expect(row).toBeUndefined();
  });

  it('有用户绑定的卡 → 删除 409 rate_card_in_use', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const { body } = await createCard(request, token);
    await newUserBoundToCard(body.id);
    const res = await request(`/v1/rate-cards/${body.id}`, { method: 'DELETE', token });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('rate_card_in_use');
  });

  it('卡内用户列表回显绑定用户', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const { body } = await createCard(request, token);
    await newUserBoundToCard(body.id);
    const res = await request(`/v1/rate-cards/${body.id}/users`, { token });
    expect(res.status).toBe(200);
    const list = (await res.json()) as { rows: unknown[]; total: number };
    expect(list.total).toBe(1);
  });
});

describe('M1 red：全局系数更新不得抹平 model 覆写行', () => {
  it('PATCH coefficient：global 行更新，scope=model 行保持原系数', async () => {
    const { request } = buildTestApp();
    const { token } = await newAdmin();
    const { body } = await createCard(request, token, '1.5');

    // 手工插一行 model 覆写系数（schema 允许：scope='model' + modelMappingId）
    const mappingId = await newMappingRow();
    await db.insert(rateCardCoefficients).values({
      rateCardId: body.id,
      scope: 'model',
      modelMappingId: mappingId,
      coefficient: '2.500',
    });

    const res = await request(`/v1/rate-cards/${body.id}`, {
      method: 'PATCH',
      token,
      body: { coefficient: '0.8' },
    });
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(rateCardCoefficients)
      .where(eq(rateCardCoefficients.rateCardId, body.id));
    expect(rows).toHaveLength(2);
    const globalRow = rows.find((r) => r.scope === 'global');
    const modelRow = rows.find((r) => r.scope === 'model');
    expect(globalRow!.coefficient).toBe('0.800');
    expect(modelRow!.coefficient).toBe('2.500'); // 回归点：未被抹平
  });
});
