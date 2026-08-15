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
import { createLedger } from '../index.js';

/**
 * 【R2 · 红测】零价套餐不得被自助购买/续费（自造干净数据，不依赖库内任何存量套餐）
 *
 * 缺陷：applySubscription 闸门缺 price>0 校验，余额闸门对 price=0 恒真——
 * 任何登录用户可白得任意额度（e2e 实测：loadtest-plan ¥10 亿）。
 * 预期（正确行为）：price<=0 的套餐 purchase/renew 均 rejects plan_not_purchasable。
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

async function createUser(balance: string): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: `redfp-${randomUUID()}`,
      identityProvider: 'local',
      balance,
    })
    .returning({ id: users.id });
  return user!.id;
}

/** 自造零价上架套餐（status=0、kind=subscription、price=0） */
async function createZeroPricePlan(): Promise<number> {
  const [plan] = await db
    .insert(plans)
    .values({
      name: `redfp-${randomUUID().slice(0, 8)}`,
      price: '0',
      periodDays: 30,
      quotaAmount: '10000',
      status: 0,
      kind: 'subscription',
      sortOrder: 1,
    })
    .returning({ id: plans.id });
  return plan!.id;
}

async function cleanup(userId: number, planId: number): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(plans).where(and(eq(plans.id, planId), eq(plans.price, '0')));
}

describe('R2: 零价套餐自助购买闸门（自造数据）', () => {
  it('¥0 上架套餐：余额 0 用户自助购买必须被拒绝', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('0');
    const planId = await createZeroPricePlan();
    const ledger = createLedger({ db });
    try {
      // 【红】当前实现：201 白得 ¥10000 额度；正确行为：rejects plan_not_purchasable
      await expect(
        ledger.subscribePlan({
          operationId: `redfp-buy:${randomUUID()}`,
          userId,
          planId,
        }),
      ).rejects.toMatchObject({ code: 'plan_not_purchasable' });

      const active = await db.query.userSubscriptions.findFirst({
        where: and(eq(userSubscriptions.userId, userId), eq(userSubscriptions.status, 0)),
      });
      expect(active).toBeUndefined(); // 不得留下白得的订阅
    } finally {
      await cleanup(userId, planId);
    }
  });

  it('¥0 套餐续费同样拒绝（历史脏订阅不得续命）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100');
    const planId = await createZeroPricePlan();
    const ledger = createLedger({ db });
    try {
      // 模拟一条历史遗留的零价订阅（绕过购买闸门直接落库，等价于修复前的存量）
      const [sub] = await db
        .insert(userSubscriptions)
        .values({
          userId,
          planId,
          startAt: new Date(),
          endAt: new Date(Date.now() + 86_400_000),
          quotaAmount: '10000',
          usedAmount: '0',
          reservedAmount: '0',
          quantity: 1,
          price: '0',
          status: 0,
        })
        .returning({ id: userSubscriptions.id });
      await expect(
        ledger.renewSubscription({
          operationId: `redfp-renew:${randomUUID()}`,
          subscriptionId: sub!.id,
          userId,
        }),
      ).rejects.toMatchObject({ code: 'plan_not_purchasable' });
    } finally {
      await cleanup(userId, planId);
    }
  });
});
