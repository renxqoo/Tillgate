import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, lt } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import { plans, users, userSubscriptions, transactions } from '@ai-gateway/db/schema';
import { createLedger } from '../index.js';

/**
 * C4 红测：个人订阅自然到期（status=0 且 end_at<=now）后必须还能再次购买。
 * 现状死锁链：无任务翻转过期行 → 唯一部分索引（status=0）仍占用 →
 * 新购买 insert 撞 23505 → already_subscribed 409；而 /me/subscription 又
 * 因 endAt>now 条件返回 null（拿不到 id 去 renew）→ 用户永久无法再购。
 * 根因修复：购买事务内把「已过期的 status=0 个人订阅」懒翻转为 status=1
 * （与 renew 的「旧订阅转到期」同语义），不变量「一个在期个人订阅」成立。
 */

const db: Db = createDb(process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway', { poolMax: 5 });
let connected = false;
beforeAll(async () => {
  try {
    await db.select({ id: users.id }).from(users).limit(1);
    connected = true;
  } catch {
    connected = false;
  }
});
afterAll(async () => db.$client.end().catch(() => {}));

describe('RED C4: 过期个人订阅不得死锁后续购买', () => {
  it('status=0 且 end_at 已过的订阅 → 再次购买应成功且旧行翻转为到期', async (context) => {
    if (!connected) return context.skip();
    const s = Date.now();
    const [u] = await db
      .insert(users)
      .values({ issuer: 'local', subject: `__c4u_${s}`, identityProvider: 'local', balance: '100' })
      .returning({ id: users.id });
    const [p] = await db
      .insert(plans)
      .values({
        name: `__c4plan_${s}`.slice(0, 32),
        kind: 'subscription',
        price: '10',
        periodDays: 30,
        quotaAmount: '10',
        sortOrder: 1,
        status: 0,
      })
      .returning({ id: plans.id });
    const ledger = createLedger({ db });
    try {
      const buy1 = await ledger.subscribePlan({
        operationId: `c4-buy1:${randomUUID()}`,
        userId: u!.id,
        planId: p!.id,
        quantity: 1,
      });
      // 人工把订阅置为「自然到期但 status 仍为 0」（生产惰性判定即此状态）
      await db
        .update(userSubscriptions)
        .set({ endAt: new Date(Date.now() - 60_000) })
        .where(eq(userSubscriptions.id, buy1.subscriptionId));

      // 【红】现状：already_subscribed（唯一索引撞过期行）
      const buy2 = await ledger.subscribePlan({
        operationId: `c4-buy2:${randomUUID()}`,
        userId: u!.id,
        planId: p!.id,
        quantity: 1,
      });
      expect(buy2.subscriptionId).toBeGreaterThan(0);
      // 旧行必须翻转为到期态，不得残留 status=0 的过期行
      const stale = await db
        .select({ id: userSubscriptions.id })
        .from(userSubscriptions)
        .where(
          and(
            eq(userSubscriptions.userId, u!.id),
            eq(userSubscriptions.status, 0),
            lt(userSubscriptions.endAt, new Date()),
          ),
        );
      expect(stale.length).toBe(0);
    } finally {
      await db.delete(transactions).where(eq(transactions.userId, u!.id));
      await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, u!.id));
      await db.delete(plans).where(eq(plans.id, p!.id));
      await db.delete(users).where(eq(users.id, u!.id));
    }
  });
});
