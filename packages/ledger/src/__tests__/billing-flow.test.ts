import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  admins,
  apiKeys,
  auditLogs,
  billingRequests,
  channels,
  fundOperations,
  plans,
  providers,
  transactions,
  usageLogs,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { createBilling } from '../billing/index.js';
import {
  BillingBacklogError,
  BillingConfigurationError,
  DailySpendLimitExceededError,
  SubscriptionQuotaExhaustedError,
} from '../billing/errors.js';
import { createBillingProcessor } from '../billing/processor/index.js';
import { createBillingOperations } from '../billing/operations.js';
import type { BillingQuote, UsageReceipt } from '../billing/types.js';

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

async function createUser(initialBalance: string, quota = '10000'): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: `billing-${randomUUID()}`,
      identityProvider: 'local',
      displayName: 'Billing Test',
      balance: initialBalance,
    })
    .returning({ id: users.id });
  const userId = user!.id;
  // 测试用户默认带一个额度充足的订阅；套餐分流用例用 subscription Key 走额度分支，
  // 普通 Key/无 Key 则走余额（payg）分支。
  const [plan] = await db
    .insert(plans)
    .values({
      name: `plan-${randomUUID().slice(0, 6)}`,
      kind: 'subscription',
      sortOrder: 1,
      price: '0',
      periodDays: 30,
      quotaAmount: quota,
      allowSeats: false,
      status: 0,
    })
    .returning({ id: plans.id });
  await db
    .insert(userSubscriptions)
    .values({
      userId,
      planId: plan!.id,
      startAt: new Date(),
      endAt: new Date(Date.now() + 86_400_000),
      quotaAmount: quota,
      usedAmount: '0',
      reservedAmount: '0',
      quantity: 1,
      price: '0',
      status: 0,
    });
  return userId;
}

async function cleanup(userId: number): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

async function createKey(userId: number, dailySpendLimit: string | null): Promise<number> {
  const [key] = await db
    .insert(apiKeys)
    .values({
      keyHash: `hash-${randomUUID()}`,
      keyPreview: 'ag_****test',
      userId,
      name: 'team-member',
      dailySpendLimit,
    })
    .returning({ id: apiKeys.id });
  return key!.id;
}

/** 订阅 Key：绑定到该用户 active 订阅（owner），authorize 走套餐额度分支。 */
async function createSubscriptionKey(userId: number): Promise<number> {
  const sub = await db.query.userSubscriptions.findFirst({
    where: and(eq(userSubscriptions.userId, userId), eq(userSubscriptions.status, 0)),
    columns: { id: true },
  });
  const [key] = await db
    .insert(apiKeys)
    .values({
      keyHash: `hash-sub-${randomUUID()}`,
      keyPreview: 'ag_****sub',
      userId,
      name: 'subscription-key',
      subscriptionId: sub!.id,
    })
    .returning({ id: apiKeys.id });
  return key!.id;
}

/** 建一个上游供应商 + 渠道（用于渠道进货额度测试），返回 { providerId, channelId } */
async function createChannel(upstreamBudget: string): Promise<{ providerId: number; channelId: number }> {
  const suffix = randomUUID().slice(0, 8);
  const [provider] = await db
    .insert(providers)
    .values({ name: `p-${suffix}`, baseUrl: 'https://upstream.test' })
    .returning({ id: providers.id });
  const [channel] = await db
    .insert(channels)
    .values({
      providerId: provider!.id,
      name: `ch-${suffix}`,
      apiKeyEnc: 'test-enc',
      upstreamBudget,
    })
    .returning({ id: channels.id });
  return { providerId: provider!.id, channelId: channel!.id };
}

async function balance(userId: number): Promise<Decimal> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { balance: true },
  });
  return new Decimal(user?.balance ?? 0);
}

async function balances(userId: number): Promise<{
  settled: Decimal;
  reserved: Decimal;
  available: Decimal;
}> {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { balance: true, reservedBalance: true, creditLimit: true },
  });
  const settled = new Decimal(user?.balance ?? 0);
  const reserved = new Decimal(user?.reservedBalance ?? 0);
  const credit = new Decimal(user?.creditLimit ?? 0);
  return { settled, reserved, available: settled.plus(credit).minus(reserved) };
}

/** 订阅额度状态（用量/在途）：subscription Key 分流下 authorization 只动这里、不动余额。 */
async function quotaState(userId: number): Promise<{ used: Decimal; reserved: Decimal }> {
  const sub = await db.query.userSubscriptions.findFirst({
    where: eq(userSubscriptions.userId, userId),
  });
  return {
    used: new Decimal(sub?.usedAmount ?? 0),
    reserved: new Decimal(sub?.reservedAmount ?? 0),
  };
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

describe('Billing authorize/signal + durable processor boundary', () => {
  it('足额原子预扣：额度不足不留 billing request', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('0', '1.9732838'); // 额度 1.97 < 预估 2
    const keyId = await createSubscriptionKey(userId);
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      await expect(
        billing.authorize({
          requestId,
          userId,
          apiKeyId: keyId,
          stream: false,
          quote: quote(), // required = 2
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(SubscriptionQuotaExhaustedError);
      expect(await quotaState(userId)).toEqual({
        used: new Decimal(0),
        reserved: new Decimal(0),
      });
      expect(
        await db.query.billingRequests.findFirst({
          where: eq(billingRequests.requestId, requestId),
        }),
      ).toBeUndefined();
    } finally {
      await cleanup(userId);
    }
  });

  it('显式免费模型 → 0 元授权：不校验余额、不预留额度', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('0', '10'); // 余额 0、套餐额度 10
    const keyId = await createSubscriptionKey(userId); // 订阅 Key（走套餐分支）
    const requestId = randomUUID();
    const billing = createBilling({ db });
    const freeQuote: BillingQuote = {
      maxOutputTokens: 500,
      explicitlyFree: true,
      candidates: [
        {
          mappingId: 1,
          externalModel: 'gpt-oss-20b',
          realModel: 'openai/gpt-oss-20b:free',
          inputPrice: '0',
          outputPrice: '0',
          cacheInputPrice: '0',
          coefficient: '1',
          inputTokenUpperBound: 1_000,
          billingPolicyFingerprint: null,
        },
      ],
    };
    try {
      const auth = await billing.authorize({
        requestId,
        userId,
        apiKeyId: keyId,
        stream: false,
        quote: freeQuote,
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      expect(auth.reservedAmount).toBe('0');
      // 套餐额度不动（0 元不走额度预占），余额也为 0 但无需校验
      expect(await quotaState(userId)).toEqual({
        used: new Decimal(0),
        reserved: new Decimal(0),
      });
      const row = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
      });
      expect(new Decimal(row?.reservedAmount ?? '0').isZero()).toBe(true);
    } finally {
      await cleanup(userId);
    }
  });

  it('全零价但未标记 explicitlyFree → invalid_quote（防漏填价格被静默免费）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10', '10');
    const keyId = await createSubscriptionKey(userId);
    const billing = createBilling({ db });
    const misconfigured: BillingQuote = {
      maxOutputTokens: 500,
      candidates: [
        {
          mappingId: 1,
          externalModel: 'misconfigured',
          realModel: 'misconfigured-real',
          inputPrice: '0',
          outputPrice: '0',
          cacheInputPrice: '0',
          coefficient: '1',
          inputTokenUpperBound: 1_000,
          billingPolicyFingerprint: null,
        },
      ],
    };
    try {
      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId,
          apiKeyId: keyId,
          stream: false,
          quote: misconfigured,
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(BillingConfigurationError);
    } finally {
      await cleanup(userId);
    }
  });

  it('超过风险上限直接拒绝，不截断预扣', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100');
    try {
      await expect(
        createBilling({ db }).authorize({
          requestId: randomUUID(),
          userId,
          stream: false,
          quote: quote(),
          reservationLimit: '1',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toMatchObject({ code: 'reservation_limit_exceeded' });
      expect(await balance(userId)).toEqual(new Decimal(100));
    } finally {
      await cleanup(userId);
    }
  });

  it('并发严格授权只占用可用额度，余额不跳动', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('4', '4'); // 额度 4 = 2×2
    const keyId = await createSubscriptionKey(userId);
    const billing = createBilling({ db });
    const commands = Array.from({ length: 3 }, () => ({
      requestId: randomUUID(),
      userId,
      apiKeyId: keyId,
      stream: false,
      quote: quote(),
      reservationLimit: '50',
      authorizationTtlMs: 60_000,
    }));
    try {
      const results = await Promise.allSettled(
        commands.map((command) => billing.authorize(command)),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
      expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
      expect(await quotaState(userId)).toEqual({
        used: new Decimal(0),
        reserved: new Decimal(4),
      });
      expect(await balances(userId)).toEqual({
        settled: new Decimal(4),
        reserved: new Decimal(0),
        available: new Decimal(4),
      });
      expect(
        await db.query.billingRequests.findMany({ where: eq(billingRequests.userId, userId) }),
      ).toHaveLength(2);
    } finally {
      await cleanup(userId);
    }
  });

  it('fallback 尝试失败不释放；成功收据持久化后 processor 只结算一次', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    const keyId = await createSubscriptionKey(userId);
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      const authorization = await billing.authorize({
        requestId,
        userId,
        apiKeyId: keyId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      expect(new Decimal(authorization.reservedAmount).eq(2)).toBe(true);
      expect(await quotaState(userId)).toEqual({
        used: new Decimal(0),
        reserved: new Decimal(2),
      });

      await billing.signal({
        type: 'upstream.started',
        requestId,
        leaseOwner: 'gateway-1',
        leaseMs: 60_000,
      });
      // 单渠道失败没有 release 事件；fallback 继续使用同一 reservation。
      expect(await quotaState(userId)).toEqual({
        used: new Decimal(0),
        reserved: new Decimal(2),
      });

      await billing.signal({
        type: 'request.succeeded',
        requestId,
        receipt: receipt(userId, requestId),
      });
      const processor = createBillingProcessor({ db, options: processorOptions });
      const [first, second] = await Promise.all([
        processor.runOnce([requestId]),
        processor.runOnce([requestId]),
      ]);
      expect(first.settled + second.settled).toBe(1);
      expect(await quotaState(userId)).toEqual({
        used: new Decimal(2),
        reserved: new Decimal(0),
      });
      const row = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
      });
      expect(row?.status).toBe('settled');
      expect(
        await db.select().from(usageLogs).where(eq(usageLogs.requestId, requestId)),
      ).toHaveLength(1);
      // 纯额度模型：不写余额 consume 流水
      expect(
        await db.select().from(transactions).where(eq(transactions.refId, requestId)),
      ).toHaveLength(0);
    } finally {
      await cleanup(userId);
    }
  });

  it('Worker 积压超过阈值时在预扣前关闭准入', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('20');
    const keyId = await createSubscriptionKey(userId);
    const pendingId = randomUUID();
    const rejectedId = randomUUID();
    const billing = createBilling({ db });
    try {
      await billing.authorize({
        requestId: pendingId,
        userId,
        apiKeyId: keyId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({
        type: 'request.succeeded',
        requestId: pendingId,
        receipt: receipt(userId, pendingId),
      });

      const guarded = createBilling({
        db,
        admission: { maxPending: 1, maxOldestAgeMs: 60_000, cacheMs: 100 },
      });
      await expect(
        guarded.authorize({
          requestId: rejectedId,
          userId,
          apiKeyId: keyId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(BillingBacklogError);
      expect(await quotaState(userId)).toEqual({
        used: new Decimal(0),
        reserved: new Decimal(2),
      });
      expect(
        await db.query.billingRequests.findFirst({
          where: eq(billingRequests.requestId, rejectedId),
        }),
      ).toBeUndefined();
    } finally {
      await cleanup(userId);
    }
  });

  it('未知上游结果统一释放不扣（2026-08-17 政策：upstreamCharge 不再分流资金语义）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    const keyId = await createSubscriptionKey(userId);
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      const authorization = await billing.authorize({
        requestId,
        userId,
        apiKeyId: keyId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({
        type: 'upstream.started',
        requestId,
        leaseOwner: 'gateway-1',
        leaseMs: 60_000,
      });
      const result = await billing.signal({
        type: 'request.failed',
        requestId,
        reason: 'network',
        delivery: 'none',
        upstreamCharge: 'unknown',
      });
      expect(result.status).toBe('released');
      // 释放金额（= 预扣额）随结果返回——网关收尾 span 的「未扣费」证据
      //（DB 存 18 位小数、authorize 返回归一化串，按数值比较）
      expect(new Decimal(result.amountReleased!).eq(authorization.reservedAmount)).toBe(true);
      // 未交付失败统一释放（宁可漏收不误收——用户未获完整服务）
      expect(await quotaState(userId)).toEqual({
        used: new Decimal(0),
        reserved: new Decimal(0),
      });
    } finally {
      await cleanup(userId);
    }
  });

  it('过期 authorized 可退款；过期 in_flight（网关崩溃）统一 released（2026-08-17 政策）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    const billing = createBilling({ db, clock: () => new Date('2026-01-01T00:00:00Z') });
    const safeId = randomUUID();
    const crashedId = randomUUID();
    try {
      for (const requestId of [safeId, crashedId]) {
        await billing.authorize({
          requestId,
          userId,
          stream: true,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 1,
        });
      }
      await billing.signal({
        type: 'upstream.started',
        requestId: crashedId,
        leaseOwner: 'gateway-1',
        leaseMs: 1,
      });
      const recovery = createBillingProcessor({
        db,
        options: processorOptions,
        clock: () => new Date('2026-01-01T00:01:00Z'),
      });
      const result = await recovery.recoverOnce();
      expect(result.released).toBeGreaterThanOrEqual(2); // authorized 过期 + in_flight 崩溃都计入 released
      const crashed = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, crashedId),
      });
      expect(crashed?.status).toBe('released');
      expect(crashed?.failureCode).toBe('gateway_crash_released');
    } finally {
      await cleanup(userId);
    }
  });

  it('授权已退款后拒绝迟到的 upstream.started，避免免费触达上游', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    const requestId = randomUUID();
    const billing = createBilling({ db, clock: () => new Date('2026-01-01T00:00:00Z') });
    try {
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 1,
      });
      await createBillingProcessor({ db, options: processorOptions }).recoverOnce();
      await db
        .update(billingRequests)
        .set({
          status: 'released',
          releasedAt: new Date(),
          leaseExpiresAt: null,
        })
        .where(eq(billingRequests.requestId, requestId));
      await expect(
        billing.signal({
          type: 'upstream.started',
          requestId,
          leaseOwner: 'late-gateway',
          leaseMs: 60_000,
        }),
      ).rejects.toThrow('upstream start rejected');
    } finally {
      await cleanup(userId);
    }
  });

  it('毒收据直接进入 dead，不形成无限热重试', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    const keyId = await createSubscriptionKey(userId);
    const requestId = randomUUID();
    try {
      await createBilling({ db }).authorize({
        requestId,
        userId,
        apiKeyId: keyId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await db
        .update(billingRequests)
        .set({ status: 'settlement_pending', receipt: { requestId }, nextSettlementAt: new Date() })
        .where(eq(billingRequests.requestId, requestId));
      const result = await createBillingProcessor({ db, options: processorOptions }).runOnce([
        requestId,
      ]);
      expect(result.dead).toBe(1);
      const row = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
      });
      expect(row?.status).toBe('dead');
      expect(row?.failureClass).toBe('poison_receipt');
      expect(await quotaState(userId)).toEqual({
        used: new Decimal(0),
        reserved: new Decimal(2),
      });
    } finally {
      await cleanup(userId);
    }
  });

  it('估算 usage 不能进入资金结算', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    const keyId = await createSubscriptionKey(userId);
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      await billing.authorize({
        requestId,
        userId,
        apiKeyId: keyId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      const estimated = receipt(userId, requestId);
      estimated.usage.estimated = true;
      await expect(
        billing.signal({ type: 'request.succeeded', requestId, receipt: estimated }),
      ).rejects.toThrow('billing_receipt_estimated_usage');
      expect(await quotaState(userId)).toEqual({
        used: new Decimal(0),
        reserved: new Decimal(2),
      });
      expect(
        await db.query.billingRequests.findFirst({
          where: eq(billingRequests.requestId, requestId),
        }),
      ).toMatchObject({ status: 'authorized', receipt: null });
    } finally {
      await cleanup(userId);
    }
  });

  it('多模态策略指纹不一致时拒绝收据且不扣款', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    const keyId = await createSubscriptionKey(userId);
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      await billing.authorize({
        requestId,
        userId,
        apiKeyId: keyId,
        stream: false,
        quote: quote({
          candidates: [
            {
              ...quote().candidates[0]!,
              billingPolicyFingerprint: 'a'.repeat(64),
            },
          ],
        }),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      const mismatched = receipt(userId, requestId);
      mismatched.billingPolicyFingerprint = 'b'.repeat(64);
      await expect(
        billing.signal({ type: 'request.succeeded', requestId, receipt: mismatched }),
      ).rejects.toThrow('billing_receipt_not_authorized');
      expect(await quotaState(userId)).toEqual({
        used: new Decimal(0),
        reserved: new Decimal(2),
      });
      expect(
        await db.query.billingRequests.findFirst({
          where: eq(billingRequests.requestId, requestId),
        }),
      ).toMatchObject({ status: 'authorized', receipt: null });
      expect(
        await db.select().from(transactions).where(eq(transactions.refId, requestId)),
      ).toHaveLength(0);
    } finally {
      await cleanup(userId);
    }
  });

  it('实际金额超预估但在额度内：按实际全额扣额度（无死账、不动余额）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10', '10');
    const keyId = await createSubscriptionKey(userId);
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      await billing.authorize({
        requestId,
        userId,
        apiKeyId: keyId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      const over = receipt(userId, requestId);
      over.usage.outputTokens = 501; // 实际 2.002 > 预估 2，额度 10 足够
      const signalResult = await billing.signal({
        type: 'request.succeeded',
        requestId,
        receipt: over,
      });
      expect(signalResult.status).toBe('settlement_pending');

      const run = await createBillingProcessor({ db, options: processorOptions }).runOnce([
        requestId,
      ]);
      expect(run.settled).toBe(1);
      expect(await quotaState(userId)).toEqual({
        used: new Decimal('2.002'),
        reserved: new Decimal(0),
      });
      expect(await balances(userId)).toEqual({
        settled: new Decimal('10'),
        reserved: new Decimal(0),
        available: new Decimal('10'),
      });
      expect(
        await db.query.usageLogs.findFirst({ where: eq(usageLogs.requestId, requestId) }),
      ).toBeDefined();
      // 纯额度：不写余额 consume 流水
      expect(
        await db.query.transactions.findFirst({ where: eq(transactions.refId, requestId) }),
      ).toBeUndefined();
    } finally {
      await cleanup(userId);
    }
  });

  it('06 回归：inputTokens 超过敞口上界但金额未超预估 → 正常结算（不再误判 dead）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    const keyId = await createSubscriptionKey(userId);
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      // 敞口上界只有 100，但真实 inputTokens=200（全部缓存命中，实际金额 0.02 远低于预估 1.1）
      await billing.authorize({
        requestId,
        userId,
        apiKeyId: keyId,
        stream: false,
        quote: quote({
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
              inputTokenUpperBound: 100,
              billingPolicyFingerprint: null,
            },
          ],
        }),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({
        type: 'upstream.started',
        requestId,
        leaseOwner: 'gateway-1',
        leaseMs: 60_000,
      });
      const overBound = receipt(userId, requestId);
      overBound.usage.inputTokens = 200; // > inputTokenUpperBound(100)
      overBound.usage.cachedInputTokens = 200; // 全缓存 → 金额 0.02 <= 预估 1.1
      overBound.usage.outputTokens = 0;
      const signalResult = await billing.signal({
        type: 'request.succeeded',
        requestId,
        receipt: overBound,
      });
      expect(signalResult.status).toBe('settlement_pending');

      const run = await createBillingProcessor({ db, options: processorOptions }).runOnce([
        requestId,
      ]);
      expect(run.settled).toBe(1);
      expect(await quotaState(userId)).toEqual({
        used: new Decimal('0.02'),
        reserved: new Decimal(0),
      });
      const usage = await db.query.usageLogs.findFirst({
        where: eq(usageLogs.requestId, requestId),
      });
      expect(new Decimal(usage?.amount ?? 0).eq(0.02)).toBe(true);
    } finally {
      await cleanup(userId);
    }
  });

  it('unknown 失败已即时释放（2026-08-17）；迟到 resolveUncertain 幂等重放不重复退款', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    const requestId = randomUUID();
    const operationId = `review:${requestId}`;
    const [admin] = await db
      .insert(admins)
      .values({ email: `billing-review-${randomUUID()}@test.local`, passwordHash: 'test' })
      .returning({ id: admins.id });
    try {
      const billing = createBilling({ db });
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({
        type: 'upstream.started',
        requestId,
        leaseOwner: 'gateway',
        leaseMs: 60_000,
      });
      await billing.signal({
        type: 'request.failed',
        requestId,
        reason: 'network',
        delivery: 'none',
        upstreamCharge: 'unknown',
      });
      // 政策：unknown 已即时 released
      const released = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
      });
      expect(released?.status).toBe('released');
      expect(await balances(userId)).toEqual({
        settled: new Decimal(10),
        reserved: new Decimal(0),
        available: new Decimal(10),
      });
      // 迟到的废弃命令按状态机拒绝（幂等防护仍在：不允许对已终结单重复操作资金）
      const operations = createBillingOperations({ db });
      await expect(
        operations.abandonDead({
          operationId,
          requestId,
          expectedRevision: released!.revision,
          adminId: admin!.id,
          reason: 'late review after policy release',
        }),
      ).rejects.toMatchObject({ code: 'state_conflict' });
    } finally {
      await db.delete(auditLogs).where(eq(auditLogs.targetId, requestId));
      await db.delete(fundOperations).where(eq(fundOperations.operationId, operationId));
      await cleanup(userId);
      await db.delete(admins).where(eq(admins.id, admin!.id));
    }
  });

  it('每日花费上限：当日累计消费+在途敞口+本次预估 超限即拒绝', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100');
    await db.update(users).set({ dailySpendLimit: '2' }).where(eq(users.id, userId));
    const billing = createBilling({ db });
    try {
      // 第 1 个请求（预估 2 元）→ 放行
      await billing.authorize({
        requestId: randomUUID(),
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      // 第 2 个请求（再预估 2 元）→ 2(在途) + 2(本次) = 4 > 2 → 拒绝
      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(DailySpendLimitExceededError);
      // 未设置上限（NULL）→ 不受限
      const unlimited = await createUser('100');
      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId: unlimited,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).resolves.toBeDefined();
      await cleanup(unlimited);
    } finally {
      await cleanup(userId);
    }
  });

  it('每日花费上限：已结算消费（consume 为负，取 abs）正确计入并拦截', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    await db.update(users).set({ dailySpendLimit: '3' }).where(eq(users.id, userId));
    const billing = createBilling({ db });
    try {
      // 先结算一笔 2 元消费（consume 流水 amount 为 -2）
      const rid = randomUUID();
      await billing.authorize({
        requestId: rid,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({ type: 'upstream.started', requestId: rid, leaseOwner: 'g', leaseMs: 60_000 });
      await billing.signal({ type: 'request.succeeded', requestId: rid, receipt: receipt(userId, rid) });
      await createBillingProcessor({ db, options: processorOptions }).runOnce([rid]);
      // 已结算 2 元 > 上限 1 → 下一个 authorize 被拦（即使无在途敞口）
      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(DailySpendLimitExceededError);
    } finally {
      await cleanup(userId);
    }
  });

  it('Key 级每日花费上限：团队团员单 Key 封顶（在途敞口拦截 + scope=key）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100');
    // 用户级不设上限，只给 Key 设每日 2 元
    const keyId = await createKey(userId, '2');
    const billing = createBilling({ db });
    try {
      const first = await billing.authorize({
        requestId: randomUUID(),
        userId,
        apiKeyId: keyId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      expect(new Decimal(first.reservedAmount).eq(2)).toBe(true);
      // billing_requests 已记录 apiKeyId
      const row = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, first.requestId),
      });
      expect(row?.apiKeyId).toBe(keyId);
      // 第二个请求：在途 2 + 本次 2 = 4 > 2 → 拦截，scope=key
      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId,
          apiKeyId: keyId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toMatchObject({ name: 'DailySpendLimitExceededError', scope: 'key', apiKeyId: keyId });
    } finally {
      await cleanup(userId);
    }
  });

  it('Key 级每日花费上限：已结算消费按 Key 统计拦截（usage_logs 关联）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100');
    const keyId = await createKey(userId, '3');
    const billing = createBilling({ db });
    try {
      // 用该 Key 结算一笔 2 元消费
      const rid = randomUUID();
      await billing.authorize({
        requestId: rid,
        userId,
        apiKeyId: keyId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({ type: 'upstream.started', requestId: rid, leaseOwner: 'g', leaseMs: 60_000 });
      const r = receipt(userId, rid);
      r.apiKeyId = keyId;
      await billing.signal({ type: 'request.succeeded', requestId: rid, receipt: r });
      await createBillingProcessor({ db, options: processorOptions }).runOnce([rid]);
      // 已结算 2 元；下一个请求再预估 2 → 4 > 3 → 拦截
      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId,
          apiKeyId: keyId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(DailySpendLimitExceededError);
      // 不携带 apiKeyId 的请求（JWT 场景）不受 Key 上限影响
      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).resolves.toBeDefined();
    } finally {
      await cleanup(userId);
    }
  });

  it('Key 级每日花费上限：NULL=不限，用户级与 Key 级双闸门独立', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100');
    const keyId = await createKey(userId, null);
    const billing = createBilling({ db });
    try {
      // Key 未设上限 → 放行
      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId,
          apiKeyId: keyId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).resolves.toBeDefined();
      // 用户级设 1 元 → 用户级闸门拦截（scope=user）
      await db.update(users).set({ dailySpendLimit: '1' }).where(eq(users.id, userId));
      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId,
          apiKeyId: keyId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toMatchObject({ name: 'DailySpendLimitExceededError', scope: 'user' });
    } finally {
      await cleanup(userId);
    }
  });

  it('渠道进货额度：结算耗尽后自动熔断（status=3，channelCircuitBroken=true）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    const { providerId, channelId } = await createChannel('1'); // 进货 1 元
    const billing = createBilling({ db });
    try {
      const requestId = randomUUID();
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({
        type: 'upstream.started',
        requestId,
        leaseOwner: 'gateway-1',
        leaseMs: 60_000,
      });
      // 该单上游成本 = (1000×1000 + 2000×500)/1e6 = 2 元 > 进货 1 元 → 耗尽
      const r = receipt(userId, requestId);
      r.channelId = channelId;
      await billing.signal({ type: 'request.succeeded', requestId, receipt: r });

      const run = await createBillingProcessor({ db, options: processorOptions }).runOnce([
        requestId,
      ]);
      expect(run.settled).toBe(1);
      const ch = await db.query.channels.findFirst({
        where: eq(channels.id, channelId),
        columns: { status: true },
      });
      expect(ch?.status).toBe(3); // 熔断
    } finally {
      await cleanup(userId);
      await db.delete(channels).where(eq(channels.id, channelId));
      await db.delete(providers).where(eq(providers.id, providerId));
    }
  });

  it('渠道进货额度：未耗尽不熔断；threshold 提前熔断', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    // 进货 10 元，threshold=9（剩余 ≤ 9 熔断）；单笔上游成本 2 元 → 剩余 8 ≤ 9 → 提前熔断
    const { providerId, channelId } = await createChannel('10');
    await db.update(channels).set({ upstreamThreshold: '9' }).where(eq(channels.id, channelId));
    const billing = createBilling({ db });
    try {
      const requestId = randomUUID();
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({
        type: 'upstream.started',
        requestId,
        leaseOwner: 'g',
        leaseMs: 60_000,
      });
      const r = receipt(userId, requestId);
      r.channelId = channelId;
      await billing.signal({ type: 'request.succeeded', requestId, receipt: r });
      await createBillingProcessor({ db, options: processorOptions }).runOnce([requestId]);
      const ch = await db.query.channels.findFirst({
        where: eq(channels.id, channelId),
        columns: { status: true },
      });
      expect(ch?.status).toBe(3);
    } finally {
      await cleanup(userId);
      await db.delete(channels).where(eq(channels.id, channelId));
      await db.delete(providers).where(eq(providers.id, providerId));
    }
  });

  it('渠道进货额度：没钱（budget=0）结算后熔断', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    const { providerId, channelId } = await createChannel('0'); // 没钱（未进货）
    const billing = createBilling({ db });
    try {
      const requestId = randomUUID();
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({
        type: 'upstream.started',
        requestId,
        leaseOwner: 'g',
        leaseMs: 60_000,
      });
      const r = receipt(userId, requestId);
      r.channelId = channelId;
      await billing.signal({ type: 'request.succeeded', requestId, receipt: r });
      await createBillingProcessor({ db, options: processorOptions }).runOnce([requestId]);
      const ch = await db.query.channels.findFirst({
        where: eq(channels.id, channelId),
        columns: { status: true },
      });
      expect(ch?.status).toBe(3); // 余额=0-已消耗 <0 → 熔断（没钱）
    } finally {
      await cleanup(userId);
      await db.delete(channels).where(eq(channels.id, channelId));
      await db.delete(providers).where(eq(providers.id, providerId));
    }
  });

  it('渠道精确硬闸：reserveChannel 预留在途敞口，耗尽拒绝，结算释放', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100');
    const { providerId, channelId } = await createChannel('5'); // 进货 5 元
    const billing = createBilling({ db });
    try {
      const requestId = randomUUID();
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      // 预留 2 元上游敞口 → allowed，渠道 upstream_reserved=2
      const r1 = await billing.reserveChannel({ requestId, channelId, amount: '2' });
      expect(r1.allowed).toBe(true);
      expect(
        await db.query.channels.findFirst({ where: eq(channels.id, channelId) }),
      ).toMatchObject({ upstreamReserved: '2.000000000000000000' });
      // 同一请求同渠道重复预留（幂等）→ 仍放行，不重复累加
      const r3 = await billing.reserveChannel({ requestId, channelId, amount: '2' });
      expect(r3.allowed).toBe(true);
      expect(
        await db.query.channels.findFirst({ where: eq(channels.id, channelId) }),
      ).toMatchObject({ upstreamReserved: '2.000000000000000000' });

      // 另一个请求再预留 4 元 → 2(在途) + 4(本次) = 6 > 5 → 拒绝
      const requestId2 = randomUUID();
      await billing.authorize({
        requestId: requestId2,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      const r2 = await billing.reserveChannel({ requestId: requestId2, channelId, amount: '4' });
      expect(r2.allowed).toBe(false);

      // 结算 → 释放渠道在途敞口（归 0）+ 按实际上游成本扣减余额（5 → 3）
      await billing.signal({ type: 'upstream.started', requestId, leaseOwner: 'g', leaseMs: 60_000 });
      const r = receipt(userId, requestId);
      r.channelId = channelId;
      await billing.signal({ type: 'request.succeeded', requestId, receipt: r });
      await createBillingProcessor({ db, options: processorOptions }).runOnce([requestId]);
      expect(
        await db.query.channels.findFirst({ where: eq(channels.id, channelId) }),
      ).toMatchObject({
        upstreamReserved: '0.000000000000000000',
        upstreamBudget: '3.000000000000000000', // 5 - 上游成本 2
      });
    } finally {
      await cleanup(userId);
      await db.delete(channels).where(eq(channels.id, channelId));
      await db.delete(providers).where(eq(providers.id, providerId));
    }
  });

  it('渠道精确硬闸：没钱（budget=0）reserve 直接拒绝', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100');
    const { providerId, channelId } = await createChannel('0'); // 没钱（未进货）
    const billing = createBilling({ db });
    try {
      const requestId = randomUUID();
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      // 余额 = 0 - 0 - 0 = 0 < 预估 → 拒绝
      const r = await billing.reserveChannel({ requestId, channelId, amount: '2' });
      expect(r.allowed).toBe(false);
      expect(r.remaining).toBe('0');
    } finally {
      await cleanup(userId);
      await db.delete(channels).where(eq(channels.id, channelId));
      await db.delete(providers).where(eq(providers.id, providerId));
    }
  });

  it('渠道精确硬闸：fallback 换渠道原子释放旧敞口', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100');
    const a = await createChannel('10');
    const b = await createChannel('10');
    const billing = createBilling({ db });
    try {
      const requestId = randomUUID();
      await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      // 先预留渠道 A 2 元
      const rA = await billing.reserveChannel({ requestId, channelId: a.channelId, amount: '2' });
      expect(rA.allowed).toBe(true);
      // 换渠道 B 预留 3 元 → 原子释放 A 的 2 元，再在 B 预留 3 元
      const rB = await billing.reserveChannel({ requestId, channelId: b.channelId, amount: '3' });
      expect(rB.allowed).toBe(true);
      expect(rB.switched).toBe(true);
      const ca = await db.query.channels.findFirst({ where: eq(channels.id, a.channelId) });
      const cb = await db.query.channels.findFirst({ where: eq(channels.id, b.channelId) });
      expect(ca?.upstreamReserved).toBe('0.000000000000000000');
      expect(cb?.upstreamReserved).toBe('3.000000000000000000');
      // 请求级渠道敞口指向 B
      expect(
        await db.query.billingRequests.findFirst({ where: eq(billingRequests.requestId, requestId) }),
      ).toMatchObject({ channelId: b.channelId, channelReservedAmount: '3.000000000000000000' });
    } finally {
      await cleanup(userId);
      for (const c of [a, b]) {
        await db.delete(channels).where(eq(channels.id, c.channelId));
        await db.delete(providers).where(eq(providers.id, c.providerId));
      }
    }
  });

  it('渠道精确硬闸：失败释放渠道敞口；uncertain 保守保留，确认无收费后释放', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100');
    const { providerId, channelId } = await createChannel('10');
    const billing = createBilling({ db });
    try {
      // 场景 1：失败（upstreamCharge=none）→ 释放渠道敞口
      const failId = randomUUID();
      await billing.authorize({
        requestId: failId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.reserveChannel({ requestId: failId, channelId, amount: '2' });
      await billing.signal({
        type: 'request.failed',
        requestId: failId,
        reason: 'rate_limited',
        delivery: 'none',
        upstreamCharge: 'none',
      });
      expect(
        await db.query.channels.findFirst({ where: eq(channels.id, channelId) }),
      ).toMatchObject({ upstreamReserved: '0.000000000000000000' });

      // 场景 2：上游收费未知（2026-08-17 政策）→ 渠道敞口随释放归还
      const unId = randomUUID();
      await billing.authorize({
        requestId: unId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.reserveChannel({ requestId: unId, channelId, amount: '2' });
      await billing.signal({ type: 'upstream.started', requestId: unId, leaseOwner: 'g', leaseMs: 60_000 });
      await billing.signal({
        type: 'request.failed',
        requestId: unId,
        reason: 'network',
        delivery: 'none',
        upstreamCharge: 'unknown',
      });
      expect(
        await db.query.channels.findFirst({ where: eq(channels.id, channelId) }),
      ).toMatchObject({ upstreamReserved: '0.000000000000000000' }); // 随释放归还

      // （政策后 unknown 即时释放，无需人工确认步骤；留痕校验已覆盖）
    } finally {
      await cleanup(userId);
      await db.delete(channels).where(eq(channels.id, channelId));
      await db.delete(providers).where(eq(providers.id, providerId));
    }
  });
});
