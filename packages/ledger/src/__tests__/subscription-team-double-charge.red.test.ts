import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  apiKeys,
  organizations,
  orgMembers,
  plans,
  transactions,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { Decimal } from '@ai-gateway/money';
import { createLedger } from '../index.js';

/**
 * 红测（F1）：团队套餐并发购买绕过「单有效订阅」不变式 → 双扣费。
 *
 * ensureOrg:true 时每个事务各建一个新组织，personal_uq（org_id IS NULL）与
 * org_uq（按 org_id）都不覆盖「同用户两个不同 org 的活跃订阅」——并发双击
 * 双双提交，用户被扣两次钱。混合场景（个人 + 组织并发）同理绕过。
 * 修法：per-user 全维部分唯一索引 user_subscriptions_one_active_uq 兜底，
 * 冲突翻译为 already_subscribed，失败事务整体回滚（余额与组织一并消失）。
 */

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

const PREFIX = 'team-race';

async function createUser(balance: string): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      issuer: 'test',
      subject: `${PREFIX}-${randomUUID()}`,
      identityProvider: 'local',
      balance,
      isEnterprise: true,
    })
    .returning({ id: users.id });
  return user!.id;
}

async function createPlan(price: string, allowSeats: boolean): Promise<number> {
  const [plan] = await db
    .insert(plans)
    .values({
      name: `${PREFIX}-${randomUUID().slice(0, 6)}`,
      price,
      periodDays: 30,
      quotaAmount: '50',
      status: 0,
      kind: 'subscription',
      sortOrder: 1,
      allowSeats,
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
  const u = await db.query.users.findFirst({
    where: eq(users.id, userId),
    columns: { balance: true },
  });
  return new Decimal(u?.balance ?? 0);
}

/** 测试数据纪律：按 userId 精确清理本测试创建的行（subject 前缀隔离）。 */
async function cleanup(userId: number): Promise<void> {
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  await db.delete(orgMembers).where(eq(orgMembers.userId, userId));
  await db.delete(organizations).where(eq(organizations.ownerUserId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe('团队套餐并发购买（F1 双扣费红测）', () => {
  it('并发购买 ensureOrg ×6 → 恰好 1 单成功，余额只扣一次，只留 1 个组织', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('50000');
    const planId = await createPlan('100', true);
    const ledger = createLedger({ db });
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () =>
          ledger.subscribePlan({ operationId: randomUUID(), userId, planId, quantity: 3, ensureOrg: true }),
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
      expect(await balanceOf(userId)).toEqual(new Decimal('49700')); // 只扣一次 300
      // 失败事务的 org 随事务回滚：只留成功那笔的组织（1 org + 1 owner 成员行）
      const orgs = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.ownerUserId, userId));
      expect(orgs).toHaveLength(1);
    } finally {
      await cleanup(userId);
    }
  });

  it('混合并发：个人 + 团队（ensureOrg）同时购买 → 恰好 1 单成功', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('5000');
    const planId = await createPlan('100', true);
    const ledger = createLedger({ db });
    try {
      const results = await Promise.allSettled([
        ledger.subscribePlan({ operationId: randomUUID(), userId, planId }), // 个人
        ledger.subscribePlan({ operationId: randomUUID(), userId, planId, quantity: 2, ensureOrg: true }), // 组织
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
      expect(await activeSubCount(userId)).toBe(1);
    } finally {
      await cleanup(userId);
    }
  });
});
