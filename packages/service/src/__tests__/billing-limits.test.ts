/**
 * 限额与闸门矩阵（真实 PG）：用户/Key 日限双闸与边界、重放排除自身（回归）、
 * org 成员限额、订阅越权、结算积压准入关闸。
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb } from '@ai-gateway/db';
import {
  apiKeys, billingRequests, billingReservations, organizations, orgMembers,
  plans, usageLogs, userSubscriptions, users,
} from '@ai-gateway/db';
import type { Db } from '@ai-gateway/repository';
import {
  BillingBacklogError,
  DailySpendLimitExceededError,
  Decimal,
  MemberDailyLimitExceededError,
  MemberQuotaExceededError,
  SubscriptionForbiddenError,
  type BillingQuote,
} from '@ai-gateway/domain';
import { createBillingDomain } from '../billing/index.js';
import { createWallet } from '../wallet/wallet.js';
import { systemContext, type RunContext } from '../context.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const ctx: RunContext = systemContext('v2bl-suite');
const billing = createBillingDomain({ db, currency: 'CNY' });

const createdUsers: number[] = [];
const createdRequests: string[] = [];
const createdKeys: number[] = [];
const createdSubscriptions: number[] = [];
const createdPlans: number[] = [];
const createdOrgs: number[] = [];

const q: BillingQuote = {
  maxOutputTokens: 0,
  candidates: [{
    mappingId: 1, externalModel: 'gpt-x', realModel: 'gpt-real',
    inputPrice: '2', outputPrice: '0', cacheInputPrice: '2',
    coefficient: '1', inputTokenUpperBound: 1_000_000, billingPolicyFingerprint: null,
  }],
};

async function newUser(dailyLimit?: string): Promise<number> {
  const [row] = await db
    .insert(users)
    .values({
      issuer: 'v2bl', subject: `v2bl-${randomUUID()}`, identityProvider: 'local',
      ...(dailyLimit ? { dailySpendLimit: dailyLimit } : {}),
    })
    .returning({ id: users.id });
  createdUsers.push(row!.id);
  return row!.id;
}

async function newOrgSubscription(ownerId: number, quota: string): Promise<number> {
  const [org] = await db
    .insert(organizations)
    .values({ name: `v2bl-${randomUUID().slice(0, 8)}`, ownerUserId: ownerId })
    .returning({ id: organizations.id });
  createdOrgs.push(org!.id);
  const [plan] = await db
    .insert(plans)
    .values({ name: `v2bl-${randomUUID().slice(0, 8)}`, price: '0', periodDays: 30, quotaAmount: quota })
    .returning({ id: plans.id });
  createdPlans.push(plan!.id);
  const [sub] = await db
    .insert(userSubscriptions)
    .values({
      userId: ownerId, planId: plan!.id, startAt: new Date(), endAt: new Date(Date.now() + 30 * 86_400_000),
      quotaAmount: quota, quantity: 1, price: '0', orgId: org!.id,
    })
    .returning({ id: userSubscriptions.id });
  createdSubscriptions.push(sub!.id);
  return sub!.id;
}

async function newKey(
  userId: number,
  subscriptionId: number | null,
  dailyLimit?: string,
  allowPaygFallback = false,
): Promise<number> {
  const [key] = await db
    .insert(apiKeys)
    .values({
      keyHash: randomUUID(), keyPreview: `ag_****${randomUUID().slice(0, 4)}`,
      userId, subscriptionId, name: 'v2bl-key',
      ...(dailyLimit ? { dailySpendLimit: dailyLimit } : {}),
      ...(allowPaygFallback ? { allowPaygFallback } : {}),
    })
    .returning({ id: apiKeys.id });
  createdKeys.push(key!.id);
  return key!.id;
}

async function fund(userId: number, amount: string): Promise<void> {
  const wallet = createWallet({
    db,
    currency: 'CNY',
    guards: { refTypes: ['billing', 'topup'], currencies: ['CNY'], internalAccounts: ['platform_revenue', 'outside'] },
  });
  await wallet.credit(ctx, { userId, amount, refType: 'topup', refId: `v2bl-fund-${userId}-${randomUUID().slice(0, 6)}` });
}

async function authorize(input: { userId: number; apiKeyId?: number }, expectThrow?: new (...a: never[]) => Error) {
  const requestId = randomUUID();
  const run = billing.authorize(ctx, {
    requestId, userId: input.userId, apiKeyId: input.apiKeyId ?? null, stream: false, quote: q,
    reservationLimit: '100', authorizationTtlMs: 300_000,
  });
  if (expectThrow) {
    await expect(run).rejects.toThrow(expectThrow);
    return requestId;
  }
  await run;
  createdRequests.push(requestId);
  return requestId;
}

afterAll(async () => {
  if (createdRequests.length) {
    const requestIds = createdRequests.map((id) => id as never);
    await db.delete(billingReservations).where(inArray(billingReservations.billingRequestId, requestIds));
    await db.delete(usageLogs).where(inArray(usageLogs.requestId, requestIds));
    await db.delete(billingRequests).where(inArray(billingRequests.requestId, requestIds));
  }
  if (createdKeys.length) await db.delete(apiKeys).where(inArray(apiKeys.id, createdKeys));
  if (createdSubscriptions.length) await db.delete(userSubscriptions).where(inArray(userSubscriptions.id, createdSubscriptions));
  if (createdPlans.length) await db.delete(plans).where(inArray(plans.id, createdPlans));
  if (createdOrgs.length) {
    await db.delete(orgMembers).where(inArray(orgMembers.orgId, createdOrgs));
    await db.delete(organizations).where(inArray(organizations.id, createdOrgs));
  }
  if (createdUsers.length) await db.delete(users).where(inArray(users.id, createdUsers));
  await db.$client.end().catch(() => {});
});

describe('用户级 / Key 级每日限额', () => {
  it('恰好等于限额放行（projected == limit 不是超限）', async () => {
    const user = await newUser('2');
    await fund(user, '10');
    await authorize({ userId: user }); // amount 2 == limit 2
  });

  it('超出拒绝（user 档）——账单未落零残留', async () => {
    const user = await newUser('1.9');
    const requestId = await authorize({ userId: user }, DailySpendLimitExceededError);
    const [row] = await db.select({ id: billingRequests.requestId }).from(billingRequests).where(eq(billingRequests.requestId, requestId));
    expect(row).toBeUndefined();
  });

  it('超出拒绝（key 档，scope 回执正确）', async () => {
    const user = await newUser();
    const keyId = await newKey(user, null, '1');
    try {
      await authorize({ userId: user, apiKeyId: keyId });
      expect.unreachable('应被 Key 级日限拒绝');
    } catch (error) {
      expect(error).toBeInstanceOf(DailySpendLimitExceededError);
      expect((error as DailySpendLimitExceededError).scope).toBe('key');
    }
  });

  it('回归：重放不把自身计入在途两遍（limit==amount 的重放必须通过）', async () => {
    const user = await newUser('2');
    await fund(user, '10');
    const requestId = await authorize({ userId: user });
    const replay = await billing.authorize(ctx, {
      requestId, userId: user, stream: false, quote: q,
      reservationLimit: '100', authorizationTtlMs: 300_000,
    });
    expect(replay.replayed).toBe(true); // 旧缺陷：双计 projected=4>2 会误拒
  });
});

describe('org 成员限额与越权', () => {
  it('成员日限不足 → MemberDailyLimitExceededError', async () => {
    const owner = await newUser();
    const member = await newUser();
    const subId = await newOrgSubscription(owner, '100');
    await db.insert(orgMembers).values({ orgId: createdOrgs.at(-1)!, userId: member, role: 'member', status: 0, dailySpendLimit: '1' });
    const keyId = await newKey(member, subId);
    await authorize({ userId: member, apiKeyId: keyId }, MemberDailyLimitExceededError);
  });

  it('成员月配额不足 → MemberQuotaExceededError（b 档闸在授权管线生效）', async () => {
    const owner = await newUser();
    const member = await newUser();
    const subId = await newOrgSubscription(owner, '100');
    await db.insert(orgMembers).values({ orgId: createdOrgs.at(-1)!, userId: member, role: 'member', status: 0, monthlyQuota: '1' });
    const keyId = await newKey(member, subId);
    await authorize({ userId: member, apiKeyId: keyId }, MemberQuotaExceededError);
  });

  it('PAYG 回退：成员日限只封顶订阅份额，缺口走个人余额（瀑布两源拆分）', async () => {
    const owner = await newUser();
    const member = await newUser();
    const subId = await newOrgSubscription(owner, '100');
    await db.insert(orgMembers).values({ orgId: createdOrgs.at(-1)!, userId: member, role: 'member', status: 0, dailySpendLimit: '1' });
    await fund(member, '10');
    const keyId = await newKey(member, subId, undefined, true); // allow_payg_fallback
    const requestId = await authorize({ userId: member, apiKeyId: keyId });
    const rows = await db
      .select({ sourceType: billingReservations.sourceType, amount: billingReservations.amount })
      .from(billingReservations)
      .where(eq(billingReservations.billingRequestId, requestId));
    const byType = new Map(rows.map((r) => [r.sourceType, new Decimal(r.amount)]));
    expect(byType.get('subscription')!.eq('1')).toBe(true); // 日限封顶的订阅份额
    expect(byType.get('payg')!.eq('1')).toBe(true); // 缺口 1 走个人余额
  });

  it('非成员持有套餐 Key → SubscriptionForbiddenError', async () => {
    const owner = await newUser();
    const outsider = await newUser();
    const subId = await newOrgSubscription(owner, '100');
    const keyId = await newKey(outsider, subId);
    await authorize({ userId: outsider, apiKeyId: keyId }, SubscriptionForbiddenError);
  });
});

describe('结算积压准入', () => {
  it('assertCapacity 抛 BillingBacklogError → authorize 关闸零残留', async () => {
    const gated = createBillingDomain({
      db,
      currency: 'CNY',
      admission: { assertCapacity: async () => { throw new BillingBacklogError(9, 99_000); } },
    });
    const user = await newUser();
    const requestId = randomUUID();
    await expect(
      gated.authorize(ctx, {
        requestId, userId: user, stream: false, quote: q,
        reservationLimit: '100', authorizationTtlMs: 300_000,
      }),
    ).rejects.toThrow(BillingBacklogError);
    const [row] = await db.select({ id: billingRequests.requestId }).from(billingRequests).where(eq(billingRequests.requestId, requestId));
    expect(row).toBeUndefined();
  });
});
