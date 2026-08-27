/**
 * 费率卡用例：
 * 建卡同拍全局系数 / PATCH 只碰 global 行 / 删除绑定守卫 / 健康自检 / 列表兜底回显。
 * 审计与变更同事务：before/after 都进审计、写失败回滚变更。
 */
import { describe, expect, it } from 'vitest';
import { defined } from './defined';
import { createRateCard } from '../src/application/rates/create-rate-card';
import { updateRateCard } from '../src/application/rates/update-rate-card';
import { deleteRateCard } from '../src/application/rates/delete-rate-card';
import { listRateCards } from '../src/application/rates/list-rate-cards';
import { listRateCardUsers } from '../src/application/rates/list-rate-card-users';
import { checkRateCardHealth } from '../src/application/rates/check-rate-card-health';
import {
  adminCtx,
  createMemoryRateCardStore,
  createMemoryAudit,
  createMemoryDb,
  rollbackDb,
} from './memory';

function setup() {
  const db = createMemoryDb();
  const rateCards = createMemoryRateCardStore();
  const audit = createMemoryAudit();
  const deps = {
    db,
    stores: { rateCard: rateCards.store },
    audit: audit.sink,
    auditTx: audit.txSink,
  };
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
    const initialUpdatedAt = defined(rateCards.cards.get(card.id)).updatedAt.getTime();

    const list = await listRateCards(deps, {
      q: 'card-a',
      sortBy: 'createdAt',
      order: 'desc',
      limit: 10,
      offset: 0,
    });
    expect(defined(list.rows[0]).coefficient).toBe('1.500');

    const health = await checkRateCardHealth(deps, card.id);
    expect(health).toEqual({ hasGlobalCoefficient: true, coefficient: '1.500' });

    const patched = await updateRateCard(deps, {
      ctx: adminCtx(),
      rateCardId: card.id,
      patch: { coefficient: '0.8' },
    });
    expect(patched.coefficient).toBe('0.800');
    expect(defined(rateCards.cards.get(card.id)).updatedAt.getTime()).toBeGreaterThan(
      initialUpdatedAt,
    );

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
    expect(defined(list.rows[0]).coefficient).toBe('1.000');
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
    const globalRow = defined(rateCards.coefficients.find((c) => c.scope === 'global'));
    const modelRow = defined(rateCards.coefficients.find((c) => c.scope === 'model'));
    expect(globalRow.coefficient).toBe('0.800');
    expect(modelRow.coefficient).toBe('2.500'); // 回归点：未被抹平
  });
});

describe('费率审计事务参与（§5.4/G3：费率变更必须产生可审计版本）', () => {
  it('审计 detail 含变更前值（before/after 同事务快照）', async () => {
    const { deps, audit } = setup();
    const card = await createRateCard(deps, {
      ctx: adminCtx(),
      name: 'audit-me',
      coefficient: '1.5',
    });
    await updateRateCard(deps, {
      ctx: adminCtx(),
      rateCardId: card.id,
      patch: { name: 'audit-me-2', coefficient: '0.8', status: 1 },
    });
    const entry = audit.entries.find((e) => e.action === 'rate_card.update');
    expect(entry?.detail).toMatchObject({
      before: { name: 'audit-me', description: null, status: 0, coefficient: '1.500' },
      after: { name: 'audit-me-2', coefficient: '0.8', status: 1 },
    });
  });

  it('G3 回归：审计写失败 → 变更回滚（卡面与系数均无变更落库）', async () => {
    const world = setup();
    const card = await createRateCard(world.deps, {
      ctx: adminCtx(),
      name: 'rollback',
      coefficient: '1.5',
    });
    // 换回滚语义 db（内存替身的 PG ROLLBACK 等价）
    const snapshot = () => {
      const cards = new Map([...world.rateCards.cards].map(([k, v]) => [k, { ...v }]));
      const coefficients = world.rateCards.coefficients.map((c) => ({ ...c }));
      const entries = [...world.audit.entries];
      return () => {
        world.rateCards.cards.clear();
        for (const [k, v] of cards) world.rateCards.cards.set(k, v);
        world.rateCards.coefficients.length = 0;
        world.rateCards.coefficients.push(...coefficients);
        world.audit.entries.length = 0;
        world.audit.entries.push(...entries);
      };
    };
    const deps = { ...world.deps, db: rollbackDb(snapshot) };
    world.audit.fail.on = true;
    await expect(
      updateRateCard(deps, {
        ctx: adminCtx(),
        rateCardId: card.id,
        patch: { name: 'changed', coefficient: '0.1' },
      }),
    ).rejects.toThrow('audit sink down');
    expect(defined(world.rateCards.cards.get(card.id)).name).toBe('rollback'); // 卡面未变
    expect(
      defined(world.rateCards.coefficients.find((c) => c.scope === 'global')).coefficient,
    ).toBe('1.500'); // 系数未变
    expect(world.audit.entries.filter((e) => e.action === 'rate_card.update')).toHaveLength(0);
  });
});
