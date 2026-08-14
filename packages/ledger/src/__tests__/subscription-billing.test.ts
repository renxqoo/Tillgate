import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  billingRequests,
  plans,
  transactions,
  usageLogs,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import {
  SubscriptionQuotaExhaustedError,
  SubscriptionRequiredError,
  createBilling,
  createBillingProcessor,
  createLedger,
} from '../index.js';
import type { BillingQuote, UsageReceipt } from '../types.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
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

async function createUser(balance: string, creditLimit = '0'): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: `sub-${randomUUID()}`,
      identityProvider: 'local',
      balance,
      creditLimit,
    })
    .returning({ id: users.id });
  return user!.id;
}

async function createPlan(
  quotaAmount: string,
  fallback = true,
  price = '100',
): Promise<number> {
  const [plan] = await db
    .insert(plans)
    .values({
      name: `plan-${randomUUID().slice(0, 6)}`,
      price,
      periodDays: 30,
      quotaAmount,
      fallbackToBalance: fallback,
      status: 0,
    })
    .returning({ id: plans.id });
  return plan!.id;
}

async function createSubscription(
  userId: number,
  planId: number,
  quotaAmount: string,
  usedAmount = '0',
): Promise<number> {
  const [sub] = await db
    .insert(userSubscriptions)
    .values({
      userId,
      planId,
      startAt: new Date(Date.now() - 1000),
      endAt: new Date(Date.now() + 86_400_000),
      quotaAmount,
      usedAmount,
      status: 0,
    })
    .returning({ id: userSubscriptions.id });
  return sub!.id;
}

async function cleanup(userId: number): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

function quote(overrides: Partial<BillingQuote> = {}): BillingQuote {
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
    ...overrides,
  };
}

function receipt(
  userId: number,
  requestId: string,
  inputTokens = 1_000,
  outputTokens = 500,
): UsageReceipt {
  return {
    requestId,
    userId,
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: 'test-model',
    realModel: 'test-real',
    channelId: null,
    usage: { inputTokens, cachedInputTokens: 0, outputTokens, estimated: false },
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

describe('套餐分流（authorize/settle）', () => {
  it('套餐全包：authorize 只预占套餐额度，不动余额', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('0', '0');
    const planId = await createPlan('10', true);
    const subId = await createSubscription(userId, planId, '10', '0');
    const requestId = randomUUID();
    try {
      const auth = await createBilling({ db }).authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      expect(new Decimal(auth.reservedAmount).eq(2)).toBe(true);
      const sub = await db.query.userSubscriptions.findFirst({
        where: eq(userSubscriptions.id, subId),
      });
      expect(new Decimal(sub!.reservedAmount).eq(2)).toBe(true);
      const br = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
      });
      expect(new Decimal(br!.planReservedAmount ?? '0').eq(2)).toBe(true);
      expect(br!.subscriptionId).toBe(subId);
      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      expect(new Decimal(user!.reservedBalance).eq(0)).toBe(true);
    } finally {
      await cleanup(userId);
    }
  });

  it('无订阅 → authorize 拒绝（subscription_required）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10', '0');
    try {
      await expect(
        createBilling({ db }).authorize({
          requestId: randomUUID(),
          userId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(SubscriptionRequiredError);
    } finally {
      await cleanup(userId);
    }
  });

  it('额度不足：预估超剩余额度 → authorize 拒绝（无余额兜底）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10', '0');
    const planId = await createPlan('1', false);
    await createSubscription(userId, planId, '1', '0');
    try {
      await expect(
        createBilling({ db }).authorize({
          requestId: randomUUID(),
          userId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(SubscriptionQuotaExhaustedError);
    } finally {
      await cleanup(userId);
    }
  });

  it('settle 全包：billedBy=plan、余额不动、不写 consume 流水', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('0', '0');
    const planId = await createPlan('10', true);
    const subId = await createSubscription(userId, planId, '10', '0');
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({
        type: 'request.succeeded',
        requestId,
        receipt: receipt(userId, requestId),
      });
      const processor = createBillingProcessor({ db, options: processorOptions });
      await processor.runOnce([requestId]);

      const usage = await db.query.usageLogs.findFirst({
        where: eq(usageLogs.requestId, requestId),
      });
      expect(usage!.billedBy).toBe('plan');
      expect(new Decimal(usage!.planAmount).eq(2)).toBe(true);
      expect(new Decimal(usage!.paygAmount).eq(0)).toBe(true);
      expect(usage!.subscriptionId).toBe(subId);

      const sub = await db.query.userSubscriptions.findFirst({
        where: eq(userSubscriptions.id, subId),
      });
      expect(new Decimal(sub!.usedAmount).eq(2)).toBe(true);
      expect(new Decimal(sub!.reservedAmount).eq(0)).toBe(true);

      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      expect(new Decimal(user!.balance).eq(0)).toBe(true);
      const consume = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.refId, requestId)));
      expect(consume).toHaveLength(0);
    } finally {
      await cleanup(userId);
    }
  });

  it('settle 实际金额略超预估但仍在额度内：全额扣额度，billedBy=plan、不写余额', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10', '0');
    const planId = await createPlan('10', true);
    const subId = await createSubscription(userId, planId, '10', '0');
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(), // estimate 2
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({
        type: 'request.succeeded',
        requestId,
        // 实际 3（input 2000 + output 500 → calculated 3）> estimate 2，额度 10 足够
        receipt: receipt(userId, requestId, 2_000, 500),
      });
      const processor = createBillingProcessor({ db, options: processorOptions });
      await processor.runOnce([requestId]);

      const usage = await db.query.usageLogs.findFirst({
        where: eq(usageLogs.requestId, requestId),
      });
      expect(usage!.billedBy).toBe('plan');
      expect(new Decimal(usage!.planAmount).eq(3)).toBe(true);
      expect(new Decimal(usage!.paygAmount).eq(0)).toBe(true);

      const sub = await db.query.userSubscriptions.findFirst({
        where: eq(userSubscriptions.id, subId),
      });
      expect(new Decimal(sub!.usedAmount).eq(3)).toBe(true);
      expect(new Decimal(sub!.reservedAmount).eq(0)).toBe(true);

      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      expect(new Decimal(user!.balance).eq(10)).toBe(true);
      expect(new Decimal(user!.reservedBalance).eq(0)).toBe(true);
      const consume = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.refId, requestId)));
      expect(consume).toHaveLength(0);
    } finally {
      await cleanup(userId);
    }
  });
});

describe('套餐购买/续费/取消（ledger）', () => {
  it('购买：扣余额、开订阅、写 subscribe 流水；已有有效订阅拒绝', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100', '0');
    const planId = await createPlan('50', true, '100');
    const ledger = createLedger({ db });
    try {
      const result = await ledger.subscribePlan({
        operationId: randomUUID(),
        userId,
        planId,
      });
      expect(result.subscriptionId).toBeGreaterThan(0);
      expect(new Decimal(result.price).eq(100)).toBe(true);
      expect(new Decimal(result.balanceAfter).eq(0)).toBe(true);

      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      expect(new Decimal(user!.balance).eq(0)).toBe(true);

      const subs = await db.query.userSubscriptions.findMany({
        where: eq(userSubscriptions.userId, userId),
      });
      expect(subs).toHaveLength(1);
      expect(subs[0]!.status).toBe(0);

      const tx = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.type, 'subscribe')));
      expect(tx).toHaveLength(1);

      // 已有有效订阅 → 拒绝
      await expect(
        ledger.subscribePlan({ operationId: randomUUID(), userId, planId }),
      ).rejects.toMatchObject({ code: 'already_subscribed' });
    } finally {
      await cleanup(userId);
    }
  });

  it('续费：旧订阅转到期、新订阅顺延；余额不足拒绝', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('200', '0');
    const planId = await createPlan('50', true, '100');
    const ledger = createLedger({ db });
    try {
      const first = await ledger.subscribePlan({
        operationId: randomUUID(),
        userId,
        planId,
      });
      const renewed = await ledger.renewSubscription({
        operationId: randomUUID(),
        subscriptionId: first.subscriptionId,
      });
      expect(renewed.subscriptionId).not.toBe(first.subscriptionId);
      const subs = await db.query.userSubscriptions.findMany({
        where: eq(userSubscriptions.userId, userId),
        orderBy: (s, { asc }) => [asc(s.id)],
      });
      expect(subs).toHaveLength(2);
      expect(subs[0]!.status).toBe(1); // 旧到期
      expect(subs[1]!.status).toBe(0); // 新有效

      // 余额已扣两次（100→0），第三次续费应余额不足
      await expect(
        ledger.renewSubscription({
          operationId: randomUUID(),
          subscriptionId: renewed.subscriptionId,
        }),
      ).rejects.toMatchObject({ code: 'insufficient_balance' });
    } finally {
      await cleanup(userId);
    }
  });

  it('续费归属校验：传入 userId 时只能续自己的订阅，跨用户拒绝', async (context) => {
    if (!connected) return context.skip();
    const userA = await createUser('200', '0');
    const userB = await createUser('200', '0');
    const planId = await createPlan('100', true, '100');
    const ledger = createLedger({ db });
    try {
      const sub = await ledger.subscribePlan({
        operationId: randomUUID(),
        userId: userA,
        planId,
      });
      // B 带 userId 尝试续 A 的订阅 → 视为不存在（no_subscription）
      await expect(
        ledger.renewSubscription({
          operationId: randomUUID(),
          subscriptionId: sub.subscriptionId,
          userId: userB,
        }),
      ).rejects.toMatchObject({ code: 'no_subscription' });
      // A 带 userId 续自己的订阅 → 成功
      const renewed = await ledger.renewSubscription({
        operationId: randomUUID(),
        subscriptionId: sub.subscriptionId,
        userId: userA,
      });
      expect(renewed.subscriptionId).not.toBe(sub.subscriptionId);
    } finally {
      await cleanup(userA);
      await cleanup(userB);
    }
  });

  it('取消：状态=2、不退款', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100', '0');
    const planId = await createPlan('50', true, '100');
    const ledger = createLedger({ db });
    try {
      const result = await ledger.subscribePlan({
        operationId: randomUUID(),
        userId,
        planId,
      });
      await ledger.cancelSubscription({
        operationId: randomUUID(),
        subscriptionId: result.subscriptionId,
      });
      const sub = await db.query.userSubscriptions.findFirst({
        where: eq(userSubscriptions.id, result.subscriptionId),
      });
      expect(sub!.status).toBe(2);
      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      expect(new Decimal(user!.balance).eq(0)).toBe(true); // 不退款
    } finally {
      await cleanup(userId);
    }
  });
});
