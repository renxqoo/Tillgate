import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  billingRequests,
  channels,
  providers,
  transactions,
  usageLogs,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { createBilling } from '../billing/index.js';
import { createBillingProcessor } from '../billing/processor/index.js';
import type { BillingQuote, UsageReceipt } from '../billing/types.js';

/**
 * 【红测 · settle 防线刚性】两个收尾守卫：
 *
 * 1. 渠道维度单一事实：收据归属渠道（receipt.channelId，进货扣减维度）必须与
 *    账单预留渠道（billing.channelId，敞口释放维度）一致。网关侧两者同源构造，
 *    但 settle 不设防——一旦网关回归拆开两者，进货成本静默扣错渠道、熔断错
 *    渠道。预期：不一致 → BillingInvariantError → dead 人工，敞口守恒（回滚）。
 *
 * 2. 估算标记合取方向：validateReceipt 只挡了 estimated=true ⇒ 必须有归属；
 *    反向（estimatedFor 挂在 estimated=false 的收据上）未挡——estimate_reason
 *    会错挂到非估算账单，管理端「估算」标失真。预期：非估算行 estimate_reason
 *    必须为 NULL。
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

const PREFIX = 'settle-guard';

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

function receipt(userId: number, requestId: string): UsageReceipt {
  return {
    requestId,
    userId,
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: 'test-model',
    realModel: 'test-real',
    channelId: null,
    channelKey: 'test-channel',
    usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 500, estimated: false },
    inputPrice: '1000',
    outputPrice: '2000',
    cacheInputPrice: '100',
    coefficient: '1',
    durationMs: 10,
    stream: false,
    streamAborted: false,
    mappingId: 1,
    billingPolicyFingerprint: null,
  };
}

const processorOptions = {
  ownerId: 'test-worker',
  batchSize: 10,
  claimLeaseMs: 60_000,
  retryBaseMs: 10,
  retryMaxMs: 100,
  maxAttempts: 3,
};

async function createUser(suffix: string): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: `${PREFIX}-${suffix}`,
      identityProvider: 'local',
      balance: '100',
    })
    .returning({ id: users.id });
  return user!.id;
}

async function createChannels(suffix: string, count: number): Promise<{ providerId: number; ids: number[] }> {
  const [provider] = await db
    .insert(providers)
    .values({ name: `${PREFIX}-p-${suffix}`, baseUrl: 'https://upstream.test' })
    .returning({ id: providers.id });
  const ids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const [channel] = await db
      .insert(channels)
      .values({
        providerId: provider!.id,
        name: `${PREFIX}-c${i}-${suffix}`,
        apiKeyEnc: 'test-enc',
        upstreamBudget: '10',
      })
      .returning({ id: channels.id });
    ids.push(channel!.id);
  }
  return { providerId: provider!.id, ids };
}

async function cleanup(
  userId: number,
  providerId: number | null,
  channelIds: number[],
): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  for (const id of channelIds) await db.delete(channels).where(eq(channels.id, id));
  if (providerId != null) await db.delete(providers).where(eq(providers.id, providerId));
}

describe('RED: settle 收尾守卫', () => {
  it('收据渠道 ≠ 账单预留渠道 → dead + invariant_violation，敞口守恒', async (context) => {
    if (!connected) return context.skip();
    const suffix = randomUUID().slice(0, 8);
    const userId = await createUser(suffix);
    const { providerId, ids } = await createChannels(suffix, 2);
    const [channelA, channelB] = ids as [number, number];
    const billing = createBilling({ db });
    const requestId = randomUUID();
    try {
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      const reserved = await billing.reserveChannel({
        requestId,
        channelId: channelA,
        amount: '5',
      });
      expect(reserved.allowed).toBe(true);

      // 网关 bug 模拟：收据声称成功渠道是 B，而账单预留/敞口在 A
      const forged = receipt(userId, requestId);
      forged.channelId = channelB;
      await billing.signal({ type: 'request.succeeded', requestId, receipt: forged });

      const run = await createBillingProcessor({ db, options: processorOptions }).runOnce([
        requestId,
      ]);
      expect(run.dead).toBe(1);
      const row = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
        columns: { status: true, failureClass: true },
      });
      // 【红】当前实现：照常 settled——A 敞口释放、B 进货额度被扣（静默漂移）
      // 【正确】红灯 dead 人工，事务回滚：A 敞口原封不动
      expect(row?.status).toBe('dead');
      expect(row?.failureClass).toBe('invariant_violation');

      const chA = await db.query.channels.findFirst({
        where: eq(channels.id, channelA),
        columns: { upstreamReserved: true },
      });
      expect(new Decimal(chA?.upstreamReserved ?? 0).toString()).toBe('5');
      const usageRow = await db.query.usageLogs.findFirst({
        where: eq(usageLogs.requestId, requestId),
        columns: { id: true },
      });
      expect(usageRow).toBeUndefined();
    } finally {
      await cleanup(userId, providerId, ids);
    }
  });

  it('非估算收据携带 estimatedFor → estimate_reason 必须为 NULL（标记不失真）', async (context) => {
    if (!connected) return context.skip();
    const suffix = randomUUID().slice(0, 8);
    const userId = await createUser(suffix);
    const billing = createBilling({ db });
    const requestId = randomUUID();
    try {
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      // 网关 bug 模拟：estimated=false 却带 estimatedFor（validateReceipt 单向不挡）
      const poisoned = receipt(userId, requestId);
      poisoned.estimatedFor = 'client_disconnect';
      await billing.signal({ type: 'request.succeeded', requestId, receipt: poisoned });

      const run = await createBillingProcessor({ db, options: processorOptions }).runOnce([
        requestId,
      ]);
      expect(run.settled).toBe(1);

      const row = await db.query.usageLogs.findFirst({
        where: eq(usageLogs.requestId, requestId),
        columns: { estimated: true, estimateReason: true },
      });
      expect(row?.estimated).toBe(false);
      // 【红】当前实现：estimate_reason = 'client_disconnect'（估算标错挂）
      // 【正确】非估算行不带估算标记
      expect(row?.estimateReason).toBeNull();
    } finally {
      await cleanup(userId, null, []);
    }
  });
});
