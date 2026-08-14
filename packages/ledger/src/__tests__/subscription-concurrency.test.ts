import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { plans, transactions, users, userSubscriptions } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { createLedger } from '../index.js';

/**
 * 订阅并发不变量：单有效订阅（user_subscriptions_one_active_uq 部分唯一索引兜底）。
 * 购买/变更必须在并发下保持「每用户至多一条 status=0 订阅」，且失败方拿到
 * 业务错误（already_subscribed），而不是裸 SQL 唯一约束违规（500）。
 */

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

async function createUser(balance: string, isEnterprise = false): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({ issuer: 'test', subject: `conc-${randomUUID()}`, identityProvider: 'local', balance, isEnterprise })
    .returning({ id: users.id });
  return user!.id;
}

async function createPlan(input: {
  price: string;
  quota: string;
  sortOrder: number | null;
  allowSeats?: boolean;
}): Promise<number> {
  const [plan] = await db
    .insert(plans)
    .values({
      name: `conc-${randomUUID().slice(0, 6)}`,
      price: input.price,
      periodDays: 30,
      quotaAmount: input.quota,
      status: 0,
      kind: 'subscription',
      sortOrder: input.sortOrder,
      allowSeats: input.allowSeats ?? false,
    })
    .returning({ id: plans.id });
  return plan!.id;
}

async function activeSubCount(userId: number): Promise<number> {
  const rows = await db
    .select({ id: userSubscriptions.id })
    .from(userSubscriptions)
    .where(and(eq(userSubscriptions.userId, userId), eq(userSubscriptions.status, 0)));
  return rows.length;
}

async function balanceOf(userId: number): Promise<Decimal> {
  const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
  return new Decimal(u?.balance ?? 0);
}

async function cleanup(userId: number): Promise<void> {
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe('订阅并发不变量（单有效订阅）', () => {
  it('并发购买 ×6 → 恰好 1 单成功，5 单 already_subscribed，余额只扣一次', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('5000');
    const planId = await createPlan({ price: '100', quota: '50', sortOrder: 1 });
    const ledger = createLedger({ db });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          ledger.subscribePlan({ operationId: randomUUID(), userId, planId }),
        ),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(5);
      for (const r of rejected) {
        expect((r.reason as { code?: string }).code).toBe('already_subscribed');
      }
      expect(await activeSubCount(userId)).toBe(1);
      expect(await balanceOf(userId)).toEqual(new Decimal(4900)); // 5000 - 100 只扣一次
    } finally {
      await cleanup(userId);
    }
  });

  it('并发购买带席位 ×5（企业）→ 恰好 1 单成功，且成功单内部数量自洽', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('50000', true);
    const planId = await createPlan({ price: '100', quota: '50', sortOrder: 1, allowSeats: true });
    const ledger = createLedger({ db });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          ledger.subscribePlan({ operationId: randomUUID(), userId, planId, quantity: 3 }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(4);
      expect(await activeSubCount(userId)).toBe(1);
      expect(await balanceOf(userId)).toEqual(new Decimal(49700)); // 50000 - 300 只扣一次
    } finally {
      await cleanup(userId);
    }
  });
});
