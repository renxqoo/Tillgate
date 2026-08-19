/**
 * 报价构建集成测试（真实 PG）：候选链序/系数分档/免费判定/停用卡/模型缺失/fallback 跳过。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createDb } from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import { createRepositories } from '@ai-gateway/repository';
import { systemContext, type RunContext } from '@ai-gateway/service';
import { normalizeAmount } from '@ai-gateway/domain';
import { AppError } from '../http/error-map.js';
import { createBuildQuote } from '../quote/build-quote.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx: RunContext = systemContext('v2gq-suite');
const repos = createRepositories();
const buildQuote = createBuildQuote({ db, repos });

const cleanup = { users: [] as number[], cards: [] as number[], mappings: [] as number[] };
const tag = () => `v2gq-${randomUUID().slice(0, 8)}`;

async function newMapping(values: Record<string, unknown>): Promise<number> {
  const { modelMappings } = await import('@ai-gateway/db');
  const [row] = await db
    .insert(modelMappings)
    .values({
      externalName: tag(), realModel: 'real-x', status: 0,
      inputPrice: '2', outputPrice: '6', cacheInputPrice: '1', ...values,
    })
    .returning({ id: modelMappings.id });
  cleanup.mappings.push(row!.id);
  return row!.id;
}

async function newQuoteUser(rateCardId: number | null): Promise<number> {
  const { users } = await import('@ai-gateway/db');
  const [row] = await db
    .insert(users)
    .values({ issuer: 'v2gq', subject: `v2gq-${randomUUID()}`, identityProvider: 'local', rateCardId })
    .returning({ id: users.id });
  cleanup.users.push(row!.id);
  return row!.id;
}

async function newRateCard(status = 0): Promise<number> {
  const { rateCards } = await import('@ai-gateway/db');
  const [row] = await db
    .insert(rateCards)
    .values({ name: tag(), status })
    .returning({ id: rateCards.id });
  cleanup.cards.push(row!.id);
  return row!.id;
}

const base = { inputTokenUpperBound: 100_000, maxOutputTokens: 10_000 };

afterAll(async () => {
  if (cleanup.users.length) await db.$client.query('delete from users where id = any($1)', [cleanup.users]);
  if (cleanup.cards.length) {
    await db.$client.query('delete from rate_card_coefficients where rate_card_id = any($1)', [cleanup.cards]);
    await db.$client.query('delete from rate_cards where id = any($1)', [cleanup.cards]);
  }
  if (cleanup.mappings.length) await db.$client.query('delete from model_mappings where id = any($1)', [cleanup.mappings]);
  await db.$client.end().catch(() => {});
});

describe('createBuildQuote', () => {
  it('候选链：主模型在前，fallback 按配置序；下架 fallback 跳过', async () => {
    const fbName = tag();
    const offName = tag();
    await newMapping({ externalName: fbName, inputPrice: '4', outputPrice: '10' });
    await newMapping({ externalName: offName, status: 1 });
    const mainName = tag();
    await newMapping({ externalName: mainName, fallbackModels: [offName, fbName] });
    const user = await newQuoteUser(null);

    const quote = await buildQuote(ctx, { model: mainName, userId: user, ...base });
    expect(quote.candidates.map((c) => normalizeAmount(c.inputPrice))).toEqual(['2', '4']); // 主 + 在架 fb；下架的 off 缺席
    expect(quote.maxOutputTokens).toBe(10_000);
    expect(quote.candidates[0]!.inputTokenUpperBound).toBe(100_000);
  });

  it('系数分档：主模型 model 档、fallback 走 global 兜底；无卡恒 1', async () => {
    const cardId = await newRateCard();
    const { rateCardCoefficients } = await import('@ai-gateway/db');
    const fbName = tag();
    const fbId = await newMapping({ externalName: fbName, pricingGroup: 'v2gq-none' });
    const mainId = await newMapping({ externalName: tag(), fallbackModels: [fbName] });
    await db.insert(rateCardCoefficients).values([
      { rateCardId: cardId, scope: 'global', modelMappingId: null, groupKey: null, coefficient: '2' },
      { rateCardId: cardId, scope: 'model', modelMappingId: mainId, groupKey: null, coefficient: '0.5' },
    ]);
    const user = await newQuoteUser(cardId);

    const quote = await buildQuote(ctx, { model: (await mappingName(mainId)), userId: user, ...base });
    expect(quote.candidates[0]!.coefficient).toBe('0.5');
    expect(quote.candidates[1]!.coefficient).toBe('2');

    const noCardUser = await newQuoteUser(null);
    const plain = await buildQuote(ctx, { model: await mappingName(fbId), userId: noCardUser, ...base });
    expect(plain.candidates[0]!.coefficient).toBe('1');
  });

  it('explicitlyFree：全链免费才免费；混链不免费（按最贵候选预扣）', async () => {
    const freeFb = tag();
    await newMapping({ externalName: freeFb, isFree: true, inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' });
    const freeMainName = tag();
    await newMapping({ externalName: freeMainName, isFree: true, inputPrice: '0', outputPrice: '0', cacheInputPrice: '0', fallbackModels: [freeFb] });
    const user = await newQuoteUser(null);

    const free = await buildQuote(ctx, { model: freeMainName, userId: user, ...base });
    expect(free.explicitlyFree).toBe(true);

    const chargedFb = tag();
    await newMapping({ externalName: chargedFb });
    const mixedMain = tag();
    await newMapping({ externalName: mixedMain, isFree: true, inputPrice: '0', outputPrice: '0', cacheInputPrice: '0', fallbackModels: [chargedFb] });
    const mixed = await buildQuote(ctx, { model: mixedMain, userId: user, ...base });
    expect(mixed.explicitlyFree).toBeUndefined();
  });

  it('费率卡停用 → 403 rate_card_disabled；模型缺失 → 404 model_not_found', async () => {
    const disabledCard = await newRateCard(1);
    const user = await newQuoteUser(disabledCard);
    const modelName = tag();
    await newMapping({ externalName: modelName });
    await expect(buildQuote(ctx, { model: modelName, userId: user, ...base })).rejects.toMatchObject({
      status: 403, code: 'rate_card_disabled',
    });
    await expect(buildQuote(ctx, { model: 'v2gq-nonexistent', userId: user, ...base })).rejects.toBeInstanceOf(AppError);
  });

  it('多模态策略指纹：billingPolicy 存在则 sha256，纯文本 null', async () => {
    const user = await newQuoteUser(null);
    const policyName = tag();
    await newMapping({ externalName: policyName, billingPolicy: { v: 1 } });
    const quote = await buildQuote(ctx, { model: policyName, userId: user, ...base });
    expect(quote.candidates[0]!.billingPolicyFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const plainName = tag();
    await newMapping({ externalName: plainName });
    const plain = await buildQuote(ctx, { model: plainName, userId: user, ...base });
    expect(plain.candidates[0]!.billingPolicyFingerprint).toBeNull();
  });
});

async function mappingName(id: number): Promise<string> {
  const result = await db.$client.query<{ external_name: string }>(
    'select external_name from model_mappings where id = $1', [id],
  );
  return result.rows[0]!.external_name;
}
