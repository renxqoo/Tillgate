import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  apiKeys,
  billingRequests,
  organizations,
  orgMembers,
  plans,
  transactions,
  usageLogs,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import {
  InsufficientBalanceError,
  MemberDailyLimitExceededError,
  MemberQuotaExceededError,
  SubscriptionForbiddenError,
  SubscriptionQuotaExhaustedError,
  SubscriptionRequiredError,
  createBilling,
  createBillingProcessor,
  createLedger,
} from '../index.js';
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

async function createPlan(quotaAmount: string, price = '100'): Promise<number> {
  const [plan] = await db
    .insert(plans)
    .values({
      name: `plan-${randomUUID().slice(0, 6)}`,
      price,
      periodDays: 30,
      quotaAmount,
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

/** 建 key 并显式绑定计费来源：subscriptionId=null=余额；非空=扣该订阅额度。 */
async function createKey(userId: number, subscriptionId: number | null): Promise<number> {
  const [key] = await db
    .insert(apiKeys)
    .values({
      keyHash: `hash-${randomUUID()}`,
      keyPreview: 'ag_****test',
      userId,
      name: `key-${subscriptionId ?? 'payg'}`,
      subscriptionId,
    })
    .returning({ id: apiKeys.id });
  return key!.id;
}

async function cleanup(userId: number): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
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
    channelKey: 'test-channel',
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
    const planId = await createPlan('10');
    const subId = await createSubscription(userId, planId, '10', '0');
    const keyId = await createKey(userId, subId);
    const requestId = randomUUID();
    try {
      const auth = await createBilling({ db }).authorize({
        requestId,
        userId,
        apiKeyId: keyId,
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

  it('key 绑到过期订阅 → authorize 拒绝（subscription_required）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10', '0');
    const planId = await createPlan('10');
    const [expired] = await db
      .insert(userSubscriptions)
      .values({
        userId,
        planId,
        startAt: new Date(Date.now() - 200_000),
        endAt: new Date(Date.now() - 100_000),
        quotaAmount: '10',
        usedAmount: '0',
        status: 0,
      })
      .returning({ id: userSubscriptions.id });
    const keyId = await createKey(userId, expired!.id);
    try {
      await expect(
        createBilling({ db }).authorize({
          requestId: randomUUID(),
          userId,
          apiKeyId: keyId,
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

  it('防御：key 绑到他人订阅（非 owner 非成员）→ SubscriptionForbiddenError', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10', '0');
    const otherUserId = await createUser('10', '0');
    const planId = await createPlan('10');
    const otherSubId = await createSubscription(otherUserId, planId, '10', '0');
    const keyId = await createKey(userId, otherSubId);
    try {
      await expect(
        createBilling({ db }).authorize({
          requestId: randomUUID(),
          userId,
          apiKeyId: keyId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(SubscriptionForbiddenError);
    } finally {
      await cleanup(userId);
      await cleanup(otherUserId);
    }
  });

  it('额度不足：预估超剩余额度 → authorize 拒绝（无余额兜底）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10', '0');
    const planId = await createPlan('1');
    const subId = await createSubscription(userId, planId, '1', '0');
    const keyId = await createKey(userId, subId);
    try {
      await expect(
        createBilling({ db }).authorize({
          requestId: randomUUID(),
          userId,
          apiKeyId: keyId,
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
    const planId = await createPlan('10');
    const subId = await createSubscription(userId, planId, '10', '0');
    const keyId = await createKey(userId, subId);
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
    const planId = await createPlan('10');
    const subId = await createSubscription(userId, planId, '10', '0');
    const keyId = await createKey(userId, subId);
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      await billing.authorize({
        requestId,
        userId,
        apiKeyId: keyId,
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

describe('普通 Key 分流（payg）', () => {
  it('无订阅：authorize 预留 reserved_balance；可用不足抛 InsufficientBalanceError 且不落 billing request', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('3', '0'); // 余额 3：第一次预留 2 后可用 1，再预留 2 必失败
    const keyId = await createKey(userId, null);
    const billing = createBilling({ db });
    try {
      const auth = await billing.authorize({
        requestId: randomUUID(),
        userId,
        apiKeyId: keyId,
        stream: false,
        quote: quote(), // estimate 2
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      expect(new Decimal(auth.reservedAmount).eq(2)).toBe(true);
      expect(new Decimal(auth.availableBalance).eq(1)).toBe(true);
      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      expect(new Decimal(user!.reservedBalance).eq(2)).toBe(true);
      expect(new Decimal(user!.balance).eq(3)).toBe(true); // 只预留，不动已结算余额

      // 可用不足（可用 1 < 预估 2）→ 拒绝且不落 billing request
      const rejectedId = randomUUID();
      await expect(
        billing.authorize({
          requestId: rejectedId,
          userId,
          apiKeyId: keyId,
          stream: false,
          quote: quote(),
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(InsufficientBalanceError);
      expect(
        await db.query.billingRequests.findFirst({
          where: eq(billingRequests.requestId, rejectedId),
        }),
      ).toBeUndefined();
    } finally {
      await cleanup(userId);
    }
  });

  it('settle：扣 balance + consume 流水 + usage_logs(billed_by=payg) + reserved 释放为 0', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10', '0');
    const keyId = await createKey(userId, null);
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
      expect(usage!.billedBy).toBe('payg');
      expect(new Decimal(usage!.planAmount).eq(0)).toBe(true);
      expect(new Decimal(usage!.paygAmount).eq(2)).toBe(true);
      expect(usage!.subscriptionId).toBeNull();

      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      expect(new Decimal(user!.balance).eq(8)).toBe(true);
      expect(new Decimal(user!.reservedBalance).eq(0)).toBe(true);

      const consume = await db
        .select()
        .from(transactions)
        .where(and(eq(transactions.userId, userId), eq(transactions.refId, requestId)));
      expect(consume).toHaveLength(1);
      expect(consume[0]!.type).toBe('consume');
      expect(new Decimal(consume[0]!.amount).eq(-2)).toBe(true);
      expect(new Decimal(consume[0]!.balanceBefore).eq(10)).toBe(true);
      expect(new Decimal(consume[0]!.balanceAfter).eq(8)).toBe(true);
    } finally {
      await cleanup(userId);
    }
  });

  it('域隔离：有活跃订阅用户 + payg Key → 套餐 used/reserved 全程不变，只动余额', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('10', '0');
    const planId = await createPlan('10');
    const subId = await createSubscription(userId, planId, '10', '0');
    const keyId = await createKey(userId, null);
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
      await billing.signal({
        type: 'request.succeeded',
        requestId,
        receipt: receipt(userId, requestId),
      });
      const processor = createBillingProcessor({ db, options: processorOptions });
      await processor.runOnce([requestId]);

      // 套餐额度一分不动
      const sub = await db.query.userSubscriptions.findFirst({
        where: eq(userSubscriptions.id, subId),
      });
      expect(new Decimal(sub!.usedAmount).eq(0)).toBe(true);
      expect(new Decimal(sub!.reservedAmount).eq(0)).toBe(true);

      // 只动余额
      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      expect(new Decimal(user!.balance).eq(8)).toBe(true);
      expect(new Decimal(user!.reservedBalance).eq(0)).toBe(true);
    } finally {
      await cleanup(userId);
    }
  });
});

describe('组织/成员计费（org subscription + member）', () => {
  async function createOrgWithMember(
    ownerId: number,
    memberId: number,
    quota = '10',
    memberLimits: { dailySpendLimit?: string; monthlyQuota?: string } = {},
  ): Promise<{ orgId: number; subId: number }> {
    const [org] = await db
      .insert(organizations)
      .values({ name: `org-${randomUUID().slice(0, 6)}`, ownerUserId: ownerId })
      .returning({ id: organizations.id });
    const planId = await createPlan('10');
    const [sub] = await db
      .insert(userSubscriptions)
      .values({
        userId: ownerId,
        planId,
        orgId: org!.id,
        startAt: new Date(Date.now() - 1000),
        endAt: new Date(Date.now() + 86_400_000),
        quotaAmount: quota,
        usedAmount: '0',
        status: 0,
      })
      .returning({ id: userSubscriptions.id });
    // owner 占 1 席
    await db.insert(orgMembers).values({ orgId: org!.id, userId: ownerId, role: 'owner', status: 0 });
    // 成员
    await db.insert(orgMembers).values({
      orgId: org!.id,
      userId: memberId,
      role: 'member',
      status: 0,
      ...memberLimits,
    });
    return { orgId: org!.id, subId: sub!.id };
  }

  /** 组织/成员测试专用清理：按 FK 依赖顺序删除（key → member → 订阅 → org → user）。 */
  async function cleanupOrgTest(ownerId: number, memberId: number, orgId: number): Promise<void> {
    await db.delete(billingRequests).where(inArray(billingRequests.userId, [ownerId, memberId]));
    await db.delete(usageLogs).where(inArray(usageLogs.userId, [ownerId, memberId]));
    await db.delete(transactions).where(inArray(transactions.userId, [ownerId, memberId]));
    await db.delete(apiKeys).where(inArray(apiKeys.userId, [ownerId, memberId]));
    await db.delete(orgMembers).where(eq(orgMembers.orgId, orgId));
    await db.delete(userSubscriptions).where(eq(userSubscriptions.orgId, orgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(users).where(inArray(users.id, [ownerId, memberId]));
  }

  it('成员用绑到 org 订阅的 key → 扣 org 额度，usage_logs.user_id=成员', async (context) => {
    if (!connected) return context.skip();
    const ownerId = await createUser('0', '0');
    const memberId = await createUser('0', '0');
    const { subId, orgId } = await createOrgWithMember(ownerId, memberId, '10');
    const keyId = await createKey(memberId, subId);
    const requestId = randomUUID();
    const billing = createBilling({ db });
    try {
      await billing.authorize({
        requestId,
        userId: memberId,
        apiKeyId: keyId,
        stream: false,
        quote: quote(),
        reservationLimit: '50',
        authorizationTtlMs: 60_000,
      });
      await billing.signal({ type: 'request.succeeded', requestId, receipt: receipt(memberId, requestId) });
      await createBillingProcessor({ db, options: processorOptions }).runOnce([requestId]);

      const usage = await db.query.usageLogs.findFirst({ where: eq(usageLogs.requestId, requestId) });
      expect(usage!.billedBy).toBe('plan');
      expect(usage!.userId).toBe(memberId);
      expect(usage!.subscriptionId).toBe(subId);
      const sub = await db.query.userSubscriptions.findFirst({ where: eq(userSubscriptions.id, subId) });
      expect(new Decimal(sub!.usedAmount).eq(2)).toBe(true);
    } finally {
      await cleanupOrgTest(ownerId, memberId, orgId);
    }
  });

  it('成员日限 a：当日 org 消耗 + 本次 > daily_spend_limit → MemberDailyLimitExceededError', async (context) => {
    if (!connected) return context.skip();
    const ownerId = await createUser('0', '0');
    const memberId = await createUser('0', '0');
    const { subId, orgId } = await createOrgWithMember(ownerId, memberId, '10', { dailySpendLimit: '1' });
    const keyId = await createKey(memberId, subId);
    const billing = createBilling({ db });
    try {
      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId: memberId,
          apiKeyId: keyId,
          stream: false,
          quote: quote(), // estimate 2 > 日限 1
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(MemberDailyLimitExceededError);
    } finally {
      await cleanupOrgTest(ownerId, memberId, orgId);
    }
  });

  it('成员子配额 b：本月 org 消耗 + 本次 > monthly_quota → MemberQuotaExceededError', async (context) => {
    if (!connected) return context.skip();
    const ownerId = await createUser('0', '0');
    const memberId = await createUser('0', '0');
    const { subId, orgId } = await createOrgWithMember(ownerId, memberId, '10', { monthlyQuota: '1' });
    const keyId = await createKey(memberId, subId);
    const billing = createBilling({ db });
    try {
      await expect(
        billing.authorize({
          requestId: randomUUID(),
          userId: memberId,
          apiKeyId: keyId,
          stream: false,
          quote: quote(), // estimate 2 > 子配额 1
          reservationLimit: '50',
          authorizationTtlMs: 60_000,
        }),
      ).rejects.toBeInstanceOf(MemberQuotaExceededError);
    } finally {
      await cleanupOrgTest(ownerId, memberId, orgId);
    }
  });
});

describe('套餐购买/续费/取消（ledger）', () => {
  it('购买：扣余额、开订阅、写 subscribe 流水；已有有效订阅拒绝', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100', '0');
    const planId = await createPlan('50');
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
    const planId = await createPlan('50');
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
    const planId = await createPlan('100');
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
    const planId = await createPlan('50');
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
