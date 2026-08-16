import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  billingRequests,
  channels,
  providers,
  transactions,
  users,
} from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { createBilling } from '../billing-flow.js';
import type { BillingQuote } from '../types.js';

/**
 * 红测（F3）：reserveChannel 幂等捷径不比对金额——同渠道二次预留更大金额时
 * 敞口停在旧值，渠道进货预算闸门被弱化。
 *
 * 场景：主模型预估 ¥5 全渠道失败 → fallback 模型预估 ¥8 路由回同一渠道。
 * 捷径直接放行 → channels.upstream_reserved 停在 5。正确语义：同渠道重预留
 * 需按差额补足（5 → 8 补 3），预算不足则拒绝（调用方换渠道）。
 */

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
let connected = false;

beforeAll(async () => {
  try {
    await db.query.users.findFirst({ columns: { id: true } });
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

const PREFIX = 'ch-topup';

function quote(): BillingQuote {
  return {
    maxOutputTokens: 500,
    candidates: [
      {
        mappingId: 1,
        externalModel: 'test-model',
        realModel: 'test-real',
        inputPrice: '1000',
        outputPrice: '2000',
        cacheInputPrice: '100',
        coefficient: '1',
        inputTokenUpperBound: 1_000,
        billingPolicyFingerprint: null,
      },
    ],
  };
}

async function createChannel(budget: string): Promise<{ providerId: number; channelId: number }> {
  const suffix = randomUUID().slice(0, 8);
  const [provider] = await db
    .insert(providers)
    .values({ name: `${PREFIX}-p-${suffix}`, baseUrl: 'https://upstream.test' })
    .returning({ id: providers.id });
  const [channel] = await db
    .insert(channels)
    .values({
      providerId: provider!.id,
      name: `${PREFIX}-c-${suffix}`,
      apiKeyEnc: 'test-enc',
      upstreamBudget: budget,
    })
    .returning({ id: channels.id });
  return { providerId: provider!.id, channelId: channel!.id };
}

async function channelReserved(channelId: number): Promise<Decimal> {
  const ch = await db.query.channels.findFirst({
    where: eq(channels.id, channelId),
    columns: { upstreamReserved: true },
  });
  return new Decimal(ch?.upstreamReserved ?? 0);
}

async function cleanup(userId: number, channelId: number, providerId: number): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(channels).where(eq(channels.id, channelId));
  await db.delete(providers).where(eq(providers.id, providerId));
}

describe('reserveChannel 同渠道金额补差（F3 红测）', () => {
  it('同渠道更大金额二次预留 → 敞口补到新金额，账单同步', async (context) => {
    if (!connected) return context.skip();
    const [user] = await db
      .insert(users)
      .values({
        issuer: 'test',
        subject: `${PREFIX}-${randomUUID()}`,
        identityProvider: 'local',
        balance: '1000',
      })
      .returning({ id: users.id });
    const userId = user!.id;
    const { providerId, channelId } = await createChannel('10');
    const billing = createBilling({ db });
    const requestId = randomUUID();
    try {
      await billing.authorize({
        requestId,
        userId,
        apiKeyId: null,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });

      const first = await billing.reserveChannel({ requestId, channelId, amount: '5' });
      expect(first.allowed).toBe(true);
      expect(await channelReserved(channelId)).toEqual(new Decimal('5'));

      // fallback 路由回同一渠道，预估从 5 涨到 8
      const second = await billing.reserveChannel({ requestId, channelId, amount: '8' });
      expect(second.allowed).toBe(true);
      expect(await channelReserved(channelId)).toEqual(new Decimal('8'));
      const br = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
        columns: { channelReservedAmount: true },
      });
      expect(new Decimal(br?.channelReservedAmount ?? 0)).toEqual(new Decimal('8'));
    } finally {
      await cleanup(userId, channelId, providerId);
    }
  });

  it('同渠道补差超出预算余额 → 拒绝且敞口不变', async (context) => {
    if (!connected) return context.skip();
    const [user] = await db
      .insert(users)
      .values({
        issuer: 'test',
        subject: `${PREFIX}-${randomUUID()}`,
        identityProvider: 'local',
        balance: '1000',
      })
      .returning({ id: users.id });
    const userId = user!.id;
    const { providerId, channelId } = await createChannel('6'); // 余额 6：5 已预留，补 3 放不下
    const billing = createBilling({ db });
    const requestId = randomUUID();
    try {
      await billing.authorize({
        requestId,
        userId,
        apiKeyId: null,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.reserveChannel({ requestId, channelId, amount: '5' });
      const second = await billing.reserveChannel({ requestId, channelId, amount: '8' });
      expect(second.allowed).toBe(false);
      expect(await channelReserved(channelId)).toEqual(new Decimal('5'));
    } finally {
      await cleanup(userId, channelId, providerId);
    }
  });
});
