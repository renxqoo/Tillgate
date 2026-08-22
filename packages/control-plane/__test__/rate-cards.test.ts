/**
 * 费率卡用例（v1 rate-cards.test.ts 等价迁移，含 M1 回归）：
 * 建卡同拍全局系数 / PATCH 只碰 global 行 / 删除绑定守卫 / 健康自检 / 列表兜底回显。
 */
import { describe, expect, it } from 'vitest';
import { createRateCard } from '../src/application/rates/create-rate-card';
import { updateRateCard } from '../src/application/rates/update-rate-card';
import { deleteRateCard } from '../src/application/rates/delete-rate-card';
import { listRateCards } from '../src/application/rates/list-rate-cards';
import { listRateCardUsers } from '../src/application/rates/list-rate-card-users';
import { checkRateCardHealth } from '../src/application/rates/check-rate-card-health';
import { adminCtx, createMemoryRateCardStore, createMemoryAudit, createMemoryDb } from './memory';

function setup() {
  const db = createMemoryDb();
  const rateCards = createMemoryRateCardStore();
  const audit = createMemoryAudit();
  const deps = { db, stores: { rateCard: rateCards.store }, audit: audit.sink };
  return { deps, rateCards, audit };
}

describe('费率卡全流程', () => {
  it('创建 → 列表 → 健康 → 更新 → 删除；系数恒 3 位小数回显', async () => {
    const { deps, rateCards } = setup();
    const card = await createRateCard(deps, {
      ctx: adminCtx(),
      name: 'card-a',
      coefficient: '1.5',
    });
    expect(card).toMatchObject({ coefficient: '1.500' });
    expect(rateCards.coefficients[0]).toMatchObject({
      rateCardId: card.id,
      scope: 'global',
      coefficient: '1.500',
    });

    const list = await listRateCards(deps, {
      q: 'card-a',
      sortBy: 'createdAt',
      order: 'desc',
      limit: 10,
      offset: 0,
    });
    expect(list.rows[0]!.coefficient).toBe('1.500');

    const health = await checkRateCardHealth(deps, card.id);
    expect(health).toEqual({ hasGlobalCoefficient: true, coefficient: '1.500' });

    const patched = await updateRateCard(deps, {
      ctx: adminCtx(),
      rateCardId: card.id,
      patch: { coefficient: '0.8' },
    });
    expect(patched.coefficient).toBe('0.800');

    const removed = await deleteRateCard(deps, { ctx: adminCtx(), rateCardId: card.id });
    expect(removed.ok).toBe(true);
    expect(rateCards.cards.has(card.id)).toBe(false);
    expect(rateCards.coefficients).toHaveLength(0);
  });

  it('有用户绑定的卡 → 删除 rate_card_in_use；卡内用户列表回显', async () => {
    const { deps, rateCards } = setup();
    const card = await createRateCard(deps, { ctx: adminCtx(), name: 'bound', coefficient: '1' });
    rateCards.boundUsers.set(card.id, 3);
    await expect(
      deleteRateCard(deps, { ctx: adminCtx(), rateCardId: card.id }),
    ).rejects.toMatchObject({
      code: 'control_plane.rate_card_in_use',
    });
    const users = await listRateCardUsers(deps, {
      rateCardId: card.id,
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(users.total).toBe(3);
  });

  it('更新/删除/健康 miss → rate_card_not_found', async () => {
    const { deps } = setup();
    await expect(
      updateRateCard(deps, { ctx: adminCtx(), rateCardId: 999, patch: { name: 'x' } }),
    ).rejects.toMatchObject({ code: 'control_plane.rate_card_not_found' });
    await expect(deleteRateCard(deps, { ctx: adminCtx(), rateCardId: 999 })).rejects.toMatchObject({
      code: 'control_plane.rate_card_not_found',
    });
    await expect(checkRateCardHealth(deps, 999)).rejects.toMatchObject({
      code: 'control_plane.rate_card_not_found',
    });
  });

  it('列表全局系数缺行按 1.000 兜底回显', async () => {
    const { deps, rateCards } = setup();
    await createRateCard(deps, { ctx: adminCtx(), name: 'stripped', coefficient: '2' });
    // 模拟历史数据：全局行丢失
    rateCards.coefficients.length = 0;
    const list = await listRateCards(deps, {
      q: 'stripped',
      sortBy: 'id',
      order: 'asc',
      limit: 10,
      offset: 0,
    });
    expect(list.rows[0]!.coefficient).toBe('1.000');
  });
});

describe('M1 red：全局系数更新不得抹平 model 覆写行', () => {
  it('PATCH coefficient：global 行更新，scope=model 行保持原系数', async () => {
    const { deps, rateCards } = setup();
    const card = await createRateCard(deps, { ctx: adminCtx(), name: 'm1', coefficient: '1.5' });
    // 手工插一行 model 覆写系数（schema 允许：scope='model' + modelMappingId）
    rateCards.coefficients.push({
      rateCardId: card.id,
      scope: 'model',
      modelMappingId: 42,
      groupKey: null,
      coefficient: '2.500',
    });
    await updateRateCard(deps, {
      ctx: adminCtx(),
      rateCardId: card.id,
      patch: { coefficient: '0.8' },
    });
    const globalRow = rateCards.coefficients.find((c) => c.scope === 'global')!;
    const modelRow = rateCards.coefficients.find((c) => c.scope === 'model')!;
    expect(globalRow.coefficient).toBe('0.800');
    expect(modelRow.coefficient).toBe('2.500'); // 回归点：未被抹平
  });
});
