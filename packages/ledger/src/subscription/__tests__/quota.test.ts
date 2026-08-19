/** quota 原语规格（S3）：预留/结算/释放的守卫 UPDATE 与不变量（used+reserved ≤ quota）。 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { plans, users, userSubscriptions } from '@ai-gateway/db/schema';
import { toDecimal } from '@ai-gateway/wallet/metering';
import {
  BillingInvariantError,
  SubscriptionQuotaExhaustedError,
  SubscriptionRequiredError,
} from '../../platform/errors.js';
import { releaseQuota, reserveQuota, settleQuota } from '../quota.js';
import type { DomainTx } from '../../platform/operations.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const PREFIX = 'subrwq';
const createdUsers: number[] = [];
const createdPlans: number[] = [];
const createdSubs: number[] = [];

beforeAll(async () => {
  await db.query.users.findFirst({ columns: { id: true } });
});
afterAll(async () => {
  if (createdSubs.length > 0) {
    await db.delete(userSubscriptions).where(inArray(userSubscriptions.id, createdSubs));
  }
  if (createdPlans.length > 0) {
    await db.delete(plans).where(inArray(plans.id, createdPlans));
  }
  if (createdUsers.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUsers));
  }
  await db.$client.end().catch(() => {});
});

async function seedSub(quotaAmount = '100', used = '0', reserved = '0'): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({ issuer: PREFIX, subject: `${PREFIX}-${randomUUID()}`, identityProvider: 'local' })
    .returning({ id: users.id });
  createdUsers.push(user!.id);
  const [plan] = await db
    .insert(plans)
    .values({
      name: `${PREFIX}-${randomUUID().slice(0, 8)}`,
      price: '1',
      periodDays: 30,
      quotaAmount: '1',
    })
    .returning({ id: plans.id });
  createdPlans.push(plan!.id);
  const [sub] = await db
    .insert(userSubscriptions)
    .values({
      userId: user!.id,
      planId: plan!.id,
      startAt: new Date(),
      endAt: new Date(Date.now() + 30 * 86_400_000),
      quotaAmount,
      usedAmount: used,
      reservedAmount: reserved,
      price: '1',
    })
    .returning({ id: userSubscriptions.id });
  createdSubs.push(sub!.id);
  return sub!.id;
}

async function rowOf(subId: number) {
  const [row] = await db
    .select({ usedAmount: userSubscriptions.usedAmount, reservedAmount: userSubscriptions.reservedAmount })
    .from(userSubscriptions)
    .where(eq(userSubscriptions.id, subId));
  return row!;
}

async function inTx<T>(fn: (tx: DomainTx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

describe('reserveQuota', () => {
  it('守卫 UPDATE：剩余额度足够则预留，不足/失效分别拒绝', async () => {
    const subId = await seedSub('100', '30', '20'); // 剩余 50
    await inTx((tx) => reserveQuota(tx, { subscriptionId: subId, userId: 0, amount: '50' }));
    expect(toDecimal((await rowOf(subId)).reservedAmount).toNumber()).toBe(70);

    const exhausted = await inTx((tx) =>
      reserveQuota(tx, { subscriptionId: subId, userId: 0, amount: '31' }),
    ).catch((error) => error);
    expect(exhausted).toBeInstanceOf(SubscriptionQuotaExhaustedError);
    expect(toDecimal((await rowOf(subId)).reservedAmount).toNumber()).toBe(70);

    const inactive = await seedSub('100');
    await db.update(userSubscriptions).set({ status: 2 }).where(eq(userSubscriptions.id, inactive));
    const required = await inTx((tx) =>
      reserveQuota(tx, { subscriptionId: inactive, userId: 0, amount: '1' }),
    ).catch((error) => error);
    expect(required).toBeInstanceOf(SubscriptionRequiredError);
  });
});

describe('settleQuota', () => {
  it('释放预占 + 核销消费，单语句守卫', async () => {
    const subId = await seedSub('100', '10', '40');
    await inTx((tx) => settleQuota(tx, { subscriptionId: subId, reserved: '40', consumed: '35' }));
    const row = await rowOf(subId);
    expect(toDecimal(row.usedAmount).toNumber()).toBe(45);
    expect(toDecimal(row.reservedAmount).toNumber()).toBe(0);
  });

  it('预占不足/超额核销 → invariant 红灯', async () => {
    const subId = await seedSub('100', '0', '10');
    // used(0) + 101 + (10−10) = 101 > 100 → 拒绝
    const overflow = await inTx((tx) =>
      settleQuota(tx, { subscriptionId: subId, reserved: '10', consumed: '101' }),
    ).catch((error) => error);
    expect(overflow).toBeInstanceOf(BillingInvariantError);
    const short = await inTx((tx) =>
      settleQuota(tx, { subscriptionId: subId, reserved: '11', consumed: '0' }),
    ).catch((error) => error);
    expect(short).toBeInstanceOf(BillingInvariantError);
  });
});

describe('releaseQuota', () => {
  it('归还预占；预占不足 → invariant', async () => {
    const subId = await seedSub('100', '0', '25');
    await inTx((tx) => releaseQuota(tx, { subscriptionId: subId, reserved: '25' }));
    expect(toDecimal((await rowOf(subId)).reservedAmount).toNumber()).toBe(0);
    const drift = await inTx((tx) =>
      releaseQuota(tx, { subscriptionId: subId, reserved: '1' }),
    ).catch((error) => error);
    expect(drift).toBeInstanceOf(BillingInvariantError);
  });
});
