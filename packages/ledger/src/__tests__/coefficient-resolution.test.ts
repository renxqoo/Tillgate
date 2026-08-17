import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '@ai-gateway/db';
import { modelMappings, rateCardCoefficients, rateCards } from '@ai-gateway/db/schema';
import {
  loadRateCardCoefficients,
  pickCoefficient,
} from '../billing/coefficient.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
beforeAll(async () => {
  await db.query.users.findFirst({ columns: { id: true } });
});
afterAll(async () => db.$client.end().catch(() => {}));

/** 测试数据前缀（清理双重条件） */
const PREFIX = 'coefx';

async function createCardWithRows(
  rows: Array<{
    scope: 'global' | 'model' | 'group';
    coefficient: string;
    modelMappingId?: number;
    groupKey?: string;
  }>,
  status = 0,
): Promise<number> {
  const [card] = await db
    .insert(rateCards)
    .values({ name: `${PREFIX}-${randomUUID().slice(0, 8)}`, status })
    .returning({ id: rateCards.id });
  const cardId = card!.id;
  await db.insert(rateCardCoefficients).values(
    rows.map((r) => ({
      rateCardId: cardId,
      scope: r.scope,
      coefficient: r.coefficient,
      modelMappingId: r.modelMappingId ?? null,
      groupKey: r.groupKey ?? null,
    })),
  );
  return cardId;
}

async function createMapping(pricingGroup: string | null): Promise<number> {
  const [m] = await db
    .insert(modelMappings)
    .values({
      externalName: `${PREFIX}-${randomUUID().slice(0, 8)}`,
      realModel: 'gpt-test',
      pricingGroup,
    })
    .returning({ id: modelMappings.id });
  return m!.id;
}

const createdCards: number[] = [];
const createdMappings: number[] = [];

describe('coefficient resolution (model > group > global, 单一真相)', () => {
  it(
    'model 行优先于 group 与 global；group 行优先于 global；无匹配回退 global；无 global 回退 1',
    async () => {
      const mWithModel = await createMapping('grp-a');
      const mGroupOnly = await createMapping('grp-a');
      const mNoPricingGroup = await createMapping(null);
      createdMappings.push(mWithModel, mGroupOnly, mNoPricingGroup);
      const cardId = await createCardWithRows([
        { scope: 'global', coefficient: '1.500' },
        { scope: 'model', coefficient: '0.800', modelMappingId: mWithModel },
        { scope: 'group', coefficient: '0.900', groupKey: 'grp-a' },
      ]);
      createdCards.push(cardId);

      const snap = await loadRateCardCoefficients(db, cardId);
      expect(snap).not.toBeNull();
      expect(snap!.status).toBe(0);

      // model 覆盖 group 与 global
      expect(pickCoefficient(snap!, { modelMappingId: mWithModel, pricingGroup: 'grp-a' })).toBe(
        '0.800',
      );
      // 无 model 行 → group 行
      expect(pickCoefficient(snap!, { modelMappingId: mGroupOnly, pricingGroup: 'grp-a' })).toBe(
        '0.900',
      );
      // 无 group 键 / 无 group 行 → global
      expect(
        pickCoefficient(snap!, { modelMappingId: mNoPricingGroup, pricingGroup: null }),
      ).toBe('1.500');
      expect(pickCoefficient(snap!, { modelMappingId: mGroupOnly, pricingGroup: 'grp-b' })).toBe(
        '1.500',
      );
    },
  );

  it('卡不存在 → null；快照 pick 恒回退 1（缺 global 行的脏数据也不崩）', async () => {
    const missing = await loadRateCardCoefficients(db, 99_999_999);
    expect(missing).toBeNull();
    expect(pickCoefficient(null, { modelMappingId: 1, pricingGroup: 'g' })).toBe('1');
    // 有卡但 global 行缺失（脏数据）：无匹配回退 1 而非崩溃
    const cardId = await createCardWithRows([
      { scope: 'group', coefficient: '0.500', groupKey: 'grp-x' },
    ]);
    createdCards.push(cardId);
    const snap = await loadRateCardCoefficients(db, cardId);
    expect(pickCoefficient(snap!, { modelMappingId: 42, pricingGroup: null })).toBe('1');
  });

  it('快照携带卡状态（停用卡由消费方决定拒绝语义）', async () => {
    const cardId = await createCardWithRows([{ scope: 'global', coefficient: '1.000' }], 1);
    createdCards.push(cardId);
    const snap = await loadRateCardCoefficients(db, cardId);
    expect(snap!.status).toBe(1);
    expect(pickCoefficient(snap!, { modelMappingId: null, pricingGroup: null })).toBe('1.000');
  });
});
