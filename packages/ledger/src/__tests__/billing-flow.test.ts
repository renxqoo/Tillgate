import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  admins,
  auditLogs,
  billingRequests,
  fundOperations,
  transactions,
  usageLogs,
  users,
} from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { BillingBacklogError, InsufficientBalanceError, createBilling } from '../billing-flow.js';
import { createBillingProcessor } from '../billing-processor.js';
import { createBillingOperations } from '../billing-operations.js';
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

async function createUser(initialBalance: string): Promise<number> {
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
  return user!.id;
}

async function cleanup(userId: number): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
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
    columns: { balance: true, reservedBalance: true },
  });
  const settled = new Decimal(user?.balance ?? 0);
  const reserved = new Decimal(user?.reservedBalance ?? 0);
  return { settled, reserved, available: settled.minus(reserved) };
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
  it('足额原子预扣：余额不足不留 billing request', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('1.9732838');
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      await expect(
        billing.authorize({
          requestId,
          userId,
          stream: false,
          quote: quote(), // required = 2
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(InsufficientBalanceError);
      expect(await balance(userId)).toEqual(new Decimal('1.9732838'));
      expect(
        await db.query.billingRequests.findFirst({
          where: eq(billingRequests.requestId, requestId),
        }),
      ).toBeUndefined();
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

  it('并发严格授权只占用可用额度，已结算余额不跳动', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('4');
    const billing = createBilling({ db });
    const commands = Array.from({ length: 3 }, () => ({
      requestId: randomUUID(),
      userId,
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
      expect(await balances(userId)).toEqual({
        settled: new Decimal(4),
        reserved: new Decimal(4),
        available: new Decimal(0),
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
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      const authorization = await billing.authorize({
        requestId,
        userId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      expect(new Decimal(authorization.reservedAmount).eq(2)).toBe(true);
      expect(await balances(userId)).toEqual({
        settled: new Decimal(10),
        reserved: new Decimal(2),
        available: new Decimal(8),
      });

      await billing.signal({
        type: 'upstream.started',
        requestId,
        leaseOwner: 'gateway-1',
        leaseMs: 60_000,
      });
      // 单渠道失败没有 release 事件；fallback 继续使用同一 reservation。
      expect(await balances(userId)).toEqual({
        settled: new Decimal(10),
        reserved: new Decimal(2),
        available: new Decimal(8),
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
      expect(await balances(userId)).toEqual({
        settled: new Decimal(8),
        reserved: new Decimal(0),
        available: new Decimal(8),
      });
      const row = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
      });
      expect(row?.status).toBe('settled');
      expect(
        await db.select().from(usageLogs).where(eq(usageLogs.requestId, requestId)),
      ).toHaveLength(1);
      expect(
        await db.select().from(transactions).where(eq(transactions.refId, requestId)),
      ).toHaveLength(1);
    } finally {
      await cleanup(userId);
    }
  });

  it('Worker 积压超过阈值时在预扣前关闭准入', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('20');
    const pendingId = randomUUID();
    const rejectedId = randomUUID();
    const billing = createBilling({ db });
    try {
      await billing.authorize({
        requestId: pendingId,
        userId,
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
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(BillingBacklogError);
      expect(await balances(userId)).toEqual({
        settled: new Decimal(20),
        reserved: new Decimal(2),
        available: new Decimal(18),
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

  it('未知上游结果不退款，转 uncertain', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
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
      expect(result.status).toBe('uncertain');
      expect(await balances(userId)).toEqual({
        settled: new Decimal(10),
        reserved: new Decimal(2),
        available: new Decimal(8),
      });
    } finally {
      await cleanup(userId);
    }
  });

  it('中断流缺少可信 usage 时可显式转 uncertain，且不产生结算收据', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      await billing.authorize({
        requestId,
        userId,
        stream: true,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({
        type: 'upstream.started',
        requestId,
        leaseOwner: requestId,
        leaseMs: 60_000,
      });
      const result = await billing.signal({
        type: 'request.uncertain',
        requestId,
        reason: 'stream_upstream_truncated_without_usage',
      });
      expect(result.status).toBe('uncertain');
      const row = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
        columns: { status: true, receipt: true, failureCode: true },
      });
      expect(row).toMatchObject({
        status: 'uncertain',
        receipt: null,
        failureCode: 'stream_upstream_truncated_without_usage',
      });
    } finally {
      await cleanup(userId);
    }
  });

  it('过期 authorized 可退款；过期 in_flight 只转 uncertain', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
    const billing = createBilling({ db, clock: () => new Date('2026-01-01T00:00:00Z') });
    const safeId = randomUUID();
    const uncertainId = randomUUID();
    try {
      for (const requestId of [safeId, uncertainId]) {
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
        requestId: uncertainId,
        leaseOwner: 'gateway-1',
        leaseMs: 1,
      });
      const recovery = createBillingProcessor({
        db,
        options: processorOptions,
        clock: () => new Date('2026-01-01T00:01:00Z'),
      });
      const result = await recovery.recoverOnce();
      expect(result.released).toBeGreaterThanOrEqual(1);
      expect(result.uncertain).toBeGreaterThanOrEqual(1);
      const uncertain = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, uncertainId),
      });
      expect(uncertain?.status).toBe('uncertain');
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
    const requestId = randomUUID();
    try {
      await createBilling({ db }).authorize({
        requestId,
        userId,
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
      expect(await balances(userId)).toEqual({
        settled: new Decimal(10),
        reserved: new Decimal(2),
        available: new Decimal(8),
      });
    } finally {
      await cleanup(userId);
    }
  });

  it('估算 usage 不能进入资金结算', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
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
      const estimated = receipt(userId, requestId);
      estimated.usage.estimated = true;
      await expect(
        billing.signal({ type: 'request.succeeded', requestId, receipt: estimated }),
      ).rejects.toThrow('billing_receipt_estimated_usage');
      expect(await balances(userId)).toEqual({
        settled: new Decimal(10),
        reserved: new Decimal(2),
        available: new Decimal(8),
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
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      await billing.authorize({
        requestId,
        userId,
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
      expect(await balances(userId)).toEqual({
        settled: new Decimal(10),
        reserved: new Decimal(2),
        available: new Decimal(8),
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

  it('实际金额超过足额预扣时进入 dead，绝不静默少扣或产生错误流水', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10');
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
      const impossible = receipt(userId, requestId);
      impossible.usage.outputTokens = 501;
      const result = await billing.signal({
        type: 'request.succeeded',
        requestId,
        receipt: impossible,
      });
      expect(result.status).toBe('dead');
      expect(await balances(userId)).toEqual({
        settled: new Decimal(10),
        reserved: new Decimal(2),
        available: new Decimal(8),
      });
      expect(
        await db.query.billingRequests.findFirst({
          where: eq(billingRequests.requestId, requestId),
        }),
      ).toMatchObject({ status: 'dead', failureClass: 'invariant_violation' });
      expect(
        await db.query.usageLogs.findFirst({ where: eq(usageLogs.requestId, requestId) }),
      ).toBeUndefined();
      expect(
        await db.query.transactions.findFirst({
          where: eq(transactions.refId, requestId),
        }),
      ).toBeUndefined();
    } finally {
      await cleanup(userId);
    }
  });

  it('uncertain 只有带版本和审计的明确无收费决定才能退款，重放不重复退款', async (context) => {
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
      const uncertain = await db.query.billingRequests.findFirst({
        where: eq(billingRequests.requestId, requestId),
      });
      const operations = createBillingOperations({ db });
      const command = {
        operationId,
        requestId,
        expectedRevision: uncertain!.revision,
        adminId: admin!.id,
        reason: 'provider invoice confirms no request was accepted',
        evidenceRefs: ['provider-case:123'],
        decision: 'confirmed_no_charge' as const,
      };
      const first = await operations.resolveUncertain(command);
      const replay = await operations.resolveUncertain(command);
      expect(first.status).toBe('released');
      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(await balances(userId)).toEqual({
        settled: new Decimal(10),
        reserved: new Decimal(0),
        available: new Decimal(10),
      });
      const audits = await db.select().from(auditLogs).where(eq(auditLogs.targetId, requestId));
      expect(audits).toHaveLength(1);
    } finally {
      await db.delete(auditLogs).where(eq(auditLogs.targetId, requestId));
      await db.delete(fundOperations).where(eq(fundOperations.operationId, operationId));
      await cleanup(userId);
      await db.delete(admins).where(eq(admins.id, admin!.id));
    }
  });
});
