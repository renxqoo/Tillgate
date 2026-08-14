import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
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
import { createLedger } from '../index.js';

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
    .values({ issuer: 'test', subject: `chg-${randomUUID()}`, identityProvider: 'local', balance, isEnterprise })
    .returning({ id: users.id });
  return user!.id;
}

async function createPlan(input: {
  price: string;
  quota: string;
  sortOrder: number | null;
  kind?: 'subscription' | 'pack';
  allowSeats?: boolean;
}): Promise<number> {
  const [plan] = await db
    .insert(plans)
    .values({
      name: `p-${randomUUID().slice(0, 6)}`,
      price: input.price,
      periodDays: input.kind === 'pack' ? 0 : 30,
      quotaAmount: input.quota,
      status: 0,
      kind: input.kind ?? 'subscription',
      sortOrder: input.sortOrder,
      allowSeats: input.allowSeats ?? false,
    })
    .returning({ id: plans.id });
  return plan!.id;
}

async function cleanup(userId: number): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

async function balanceOf(userId: number): Promise<Decimal> {
  const u = await db.query.users.findFirst({ where: eq(users.id, userId), columns: { balance: true } });
  return new Decimal(u?.balance ?? 0);
}

describe('席位购买 + 变更（升级/扩容）补差价 + 加油包', () => {
  it('购买带席位：总价/总额度 = 档价/档额度 × 席位', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('500', true);
    const planId = await createPlan({ price: '100', quota: '50', sortOrder: 1, allowSeats: true });
    const ledger = createLedger({ db });
    try {
      const r = await ledger.subscribePlan({ operationId: randomUUID(), userId, planId, quantity: 3 });
      expect(r.quantity).toBe(3);
      expect(new Decimal(r.price).eq(300)).toBe(true);
      expect(new Decimal(r.quotaAmount).eq(150)).toBe(true);
      expect(await balanceOf(userId)).toEqual(new Decimal(200));
      const sub = await db.query.userSubscriptions.findFirst({
        where: eq(userSubscriptions.userId, userId),
      });
      expect(sub!.quantity).toBe(3);
      expect(new Decimal(sub!.price).eq(300)).toBe(true);
    } finally {
      await cleanup(userId);
    }
  });

  it('非企业用户购买团队套餐 → 拒绝', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('500'); // 非企业
    const teamPlan = await createPlan({ price: '100', quota: '50', sortOrder: 1, allowSeats: true });
    const ledger = createLedger({ db });
    try {
      await expect(
        ledger.subscribePlan({ operationId: randomUUID(), userId, planId: teamPlan, quantity: 2 }),
      ).rejects.toMatchObject({ code: 'enterprise_required' });
    } finally {
      await cleanup(userId);
    }
  });

  it('升级补差价 = 新总价 - 剩余价值（按额度）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('500');
    const lite = await createPlan({ price: '50', quota: '100', sortOrder: 1 });
    const pro = await createPlan({ price: '150', quota: '300', sortOrder: 2 });
    const ledger = createLedger({ db });
    try {
      const first = await ledger.subscribePlan({ operationId: randomUUID(), userId, planId: lite });
      expect(await balanceOf(userId)).toEqual(new Decimal(450)); // 500 - 50
      // 已用 20（直接造数据，模拟真实消耗）
      await db
        .update(userSubscriptions)
        .set({ usedAmount: '20' })
        .where(eq(userSubscriptions.id, first.subscriptionId));

      // 剩余额度=100-20=80；剩余价值=50×80/100=40；差价=150-40=110
      const changed = await ledger.changeSubscription({
        operationId: randomUUID(),
        subscriptionId: first.subscriptionId,
        targetPlanId: pro,
        quantity: 1,
      });
      expect(changed.planId).toBe(pro);
      expect(new Decimal(changed.price).eq(150)).toBe(true);
      expect(await balanceOf(userId)).toEqual(new Decimal(340)); // 450 - 110

      const subs = await db.query.userSubscriptions.findMany({
        where: eq(userSubscriptions.userId, userId),
        orderBy: (s, { asc }) => [asc(s.id)],
      });
      expect(subs).toHaveLength(2);
      expect(subs[0]!.status).toBe(1); // 旧到期
      expect(subs[1]!.status).toBe(0);
      expect(new Decimal(subs[1]!.quotaAmount).eq(300)).toBe(true);
    } finally {
      await cleanup(userId);
    }
  });

  it('免费升级（补差价 ≤ 0）：流水记录用户真实余额，而非订阅价格快照', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('500');
    const lite = await createPlan({ price: '50', quota: '100', sortOrder: 1 });
    // 高档但售价极低：剩余价值 50 ≥ 新总价 1 → 补差价 0（免费升级路径）
    const cheapPro = await createPlan({ price: '1', quota: '300', sortOrder: 2 });
    const ledger = createLedger({ db });
    try {
      const first = await ledger.subscribePlan({ operationId: randomUUID(), userId, planId: lite });
      expect(await balanceOf(userId)).toEqual(new Decimal(450)); // 500 - 50

      const changed = await ledger.changeSubscription({
        operationId: randomUUID(),
        subscriptionId: first.subscriptionId,
        targetPlanId: cheapPro,
        quantity: 1,
      });
      // 免费升级不扣款
      expect(await balanceOf(userId)).toEqual(new Decimal(450));
      // 返回值与流水的余额快照必须是用户真实余额（450），而非订阅价格（50/1）
      expect(new Decimal(changed.balanceBefore).eq(450)).toBe(true);
      expect(new Decimal(changed.balanceAfter).eq(450)).toBe(true);
      const changeTx = (
        await db.select().from(transactions).where(eq(transactions.userId, userId))
      ).find((t) => t.refId === String(changed.subscriptionId))!;
      expect(new Decimal(changeTx.amount).eq(0)).toBe(true);
      expect(new Decimal(changeTx.balanceBefore).eq(450)).toBe(true);
      expect(new Decimal(changeTx.balanceAfter).eq(450)).toBe(true);
    } finally {
      await cleanup(userId);
    }
  });

  it('降档 / 缩容拒绝', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('500', true);
    const lite = await createPlan({ price: '50', quota: '100', sortOrder: 1 });
    const pro = await createPlan({ price: '150', quota: '300', sortOrder: 2, allowSeats: true });
    const ledger = createLedger({ db });
    try {
      const first = await ledger.subscribePlan({ operationId: randomUUID(), userId, planId: pro, quantity: 2 });
      // 降档 pro → lite
      await expect(
        ledger.changeSubscription({
          operationId: randomUUID(),
          subscriptionId: first.subscriptionId,
          targetPlanId: lite,
          quantity: 2,
        }),
      ).rejects.toMatchObject({ code: 'downgrade_not_allowed' });
      // 缩容 pro ×2 → pro ×1
      await expect(
        ledger.changeSubscription({
          operationId: randomUUID(),
          subscriptionId: first.subscriptionId,
          targetPlanId: pro,
          quantity: 1,
        }),
      ).rejects.toMatchObject({ code: 'downgrade_not_allowed' });
    } finally {
      await cleanup(userId);
    }
  });

  it('扩容（同档加席位）补差价', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('500', true);
    const lite = await createPlan({ price: '50', quota: '100', sortOrder: 1, allowSeats: true });
    const ledger = createLedger({ db });
    try {
      const first = await ledger.subscribePlan({ operationId: randomUUID(), userId, planId: lite });
      await db
        .update(userSubscriptions)
        .set({ usedAmount: '20' })
        .where(eq(userSubscriptions.id, first.subscriptionId));
      // 剩余价值 40；新总价 50×2=100；差价 60
      const changed = await ledger.changeSubscription({
        operationId: randomUUID(),
        subscriptionId: first.subscriptionId,
        targetPlanId: lite,
        quantity: 2,
      });
      expect(changed.quantity).toBe(2);
      expect(new Decimal(changed.price).eq(100)).toBe(true);
      expect(await balanceOf(userId)).toEqual(new Decimal(390)); // 450 - 60
    } finally {
      await cleanup(userId);
    }
  });

  it('加油包：扣售价、订阅额度 += 到账额度', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100');
    const subPlanId = await createPlan({ price: '50', quota: '50', sortOrder: 1 });
    const packId = await createPlan({ price: '10', quota: '15', sortOrder: null, kind: 'pack' });
    const ledger = createLedger({ db });
    try {
      await ledger.subscribePlan({ operationId: randomUUID(), userId, planId: subPlanId }); // 100 → 50
      const r = await ledger.grantPack({ operationId: randomUUID(), userId, packId }); // 50 → 40
      expect(new Decimal(r.quotaAmount).eq(15)).toBe(true);
      expect(new Decimal(r.price).eq(10)).toBe(true);
      expect(await balanceOf(userId)).toEqual(new Decimal(40)); // 只扣售价，不再净入账
      const sub = await db.query.userSubscriptions.findFirst({
        where: eq(userSubscriptions.userId, userId),
      });
      expect(new Decimal(sub!.quotaAmount).eq(65)).toBe(true); // 50 + 15
      const tx = await db
        .select()
        .from(transactions)
        .where(eq(transactions.userId, userId));
      const packTx = tx.find((t) => t.type === 'pack')!;
      expect(new Decimal(packTx.amount).eq(-10)).toBe(true); // 只记余额扣售价
    } finally {
      await cleanup(userId);
    }
  });

  it('加油包：无有效订阅 → 拒绝', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('100');
    const packId = await createPlan({ price: '10', quota: '15', sortOrder: null, kind: 'pack' });
    const ledger = createLedger({ db });
    try {
      await expect(
        ledger.grantPack({ operationId: randomUUID(), userId, packId }),
      ).rejects.toMatchObject({ code: 'no_subscription' });
    } finally {
      await cleanup(userId);
    }
  });
});
