import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { plans, transactions, users, userSubscriptions } from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { createLedger } from '../index.js';

/**
 * 红测（F2）：changeSubscription 用无锁快照算「剩余价值」→ 并发结算窗口内多收差价。
 *
 * 竞态交错：change 读快照（used=10, reserved=20）→ 计算 diff → 翻转 status 的
 * UPDATE 在行锁上排队 → 并发结算提交 used+=15 / reserved-=20 → change 带着旧
 * 快照的 diff 提交。旧快照剩余=70、真值=75 → 多收 5 元。
 * 修法：读订阅行用 SELECT ... FOR UPDATE（与结算/释放的行写互斥），拿到提交后
 * 的新鲜快照再算折算价。
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

const PREFIX = 'proration-race';

async function createPlan(price: string, quota: string, sortOrder: number): Promise<number> {
  const [plan] = await db
    .insert(plans)
    .values({
      name: `${PREFIX}-${randomUUID().slice(0, 6)}`,
      price,
      periodDays: 30,
      quotaAmount: quota,
      status: 0,
      kind: 'subscription',
      sortOrder,
      allowSeats: false,
    })
    .returning({ id: plans.id });
  return plan!.id;
}

async function cleanup(userId: number): Promise<void> {
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe('changeSubscription 折算价快照竞态（F2 红测）', () => {
  it('并发结算提交后，补差价必须按新鲜快照计算（不多收）', async (context) => {
    if (!connected) return context.skip();
    // 快照：quota=100, used=10, reserved=20, price=100；目标档 price=200。
    // 并发结算（used+=15, reserved-=20）提交后的真值：used=25, reserved=0 →
    // 剩余=75 → 剩余价值=75 → diff = 200 - 75 = 125。
    // 旧快照：剩余=70 → 剩余价值=70 → diff = 130（多收 5）。
    const [user] = await db
      .insert(users)
      .values({
        issuer: 'test',
        subject: `${PREFIX}-${randomUUID()}`,
        identityProvider: 'local',
        balance: '1000',
      })
      .returning({ id: users.id });
    const userId = user!.id;
    const planA = await createPlan('100', '100', 1);
    const planB = await createPlan('200', '200', 2);
    const [sub] = await db
      .insert(userSubscriptions)
      .values({
        userId,
        planId: planA,
        startAt: new Date(),
        endAt: new Date(Date.now() + 86_400_000),
        quotaAmount: '100',
        usedAmount: '10',
        reservedAmount: '20',
        quantity: 1,
        price: '100',
        status: 0,
      })
      .returning({ id: userSubscriptions.id });
    const subscriptionId = sub!.id;
    const ledger = createLedger({ db });

    try {
      // tx1：模拟并发结算——行锁持有期间不提交
      let commitTx1!: () => void;
      const holdGate = new Promise<void>((resolve) => {
        commitTx1 = resolve;
      });
      const tx1 = db.transaction(async (tx) => {
        await tx
          .update(userSubscriptions)
          .set({
            usedAmount: sql`${userSubscriptions.usedAmount} + 15`,
            reservedAmount: sql`${userSubscriptions.reservedAmount} - 20`,
          })
          .where(eq(userSubscriptions.id, subscriptionId));
        await holdGate; // 行锁挂起，制造「读旧快照 + 写时才撞锁」窗口
      });
      await new Promise((r) => setTimeout(r, 150)); // 确保 tx1 已持有行锁

      const changePromise = ledger.changeSubscription({
        operationId: randomUUID(),
        userId,
        subscriptionId,
        targetPlanId: planB,
        quantity: 1,
      });
      // 等 change 走完读与计算（红阶段必然读旧快照），在其翻转 UPDATE 上阻塞
      await new Promise((r) => setTimeout(r, 400));

      commitTx1();
      await tx1;
      const result = await changePromise;

      // 补差价按提交后的新快照计算：125，不是旧快照的 130
      expect(new Decimal(result.balanceBefore).minus(new Decimal(result.balanceAfter))).toEqual(
        new Decimal('125'),
      );
      const u = await db.query.users.findFirst({
        where: eq(users.id, userId),
        columns: { balance: true },
      });
      expect(new Decimal(u!.balance)).toEqual(new Decimal('875'));
    } finally {
      await cleanup(userId);
    }
  });
});
