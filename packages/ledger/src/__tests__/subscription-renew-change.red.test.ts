import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  apiKeys,
  apps,
  billingRequests,
  orgMembers,
  organizations,
  plans,
  transactions,
  usageLogs,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { createLedger } from '../index.js';

/**
 * 【红测 · R3】订阅生命周期三处缺陷（renew/change 破坏组织订阅 + change 不重绑凭证 + 取消可复活）
 *
 * R3-1 续费丢 orgId：renewSubscription 调 applySubscription 时 orgId: null
 *   （ledger.ts:821-832），且 renew 分支读旧订阅不取 orgId 列（ledger.ts:401-403），
 *   新订阅 org_id=NULL。后果：组织订阅续费后变成「个人订阅」——
 *   成员鉴权（billing-flow.ts:427-437 要求 sub.orgId 非空才认成员）全部 402，
 *   且新订阅占掉 user_subscriptions_one_personal_uq 唯一槽位，个人购套餐被误拒。
 *
 * R3-2 变更（升档）不重绑凭证：renew 有改绑 apiKeys/apps 的逻辑（ledger.ts:509-517），
 *   changeSubscription 的插入段（ledger.ts:977-989）没有等价逻辑，也没有 orgId。
 *   后果：用户付了升档差价，所有绑定旧订阅的 Key/App 全部 402 subscription_required，
 *   直到手工改绑。同时 org 订阅升档同样丢 orgId（成员全断）。
 *
 * R3-3 已取消订阅可被「续费」复活：renew 分支按 id 读订阅，无 status 过滤
 *   （ledger.ts:401-403 `where: eq(id)`，对比 change 的 status=0 AND endAt>now）。
 *   后果：管理员取消（status=2）的订阅（风控/退款场景）用户自助 renew 即复活。
 *
 * 预期（正确行为，当前实现红灯）：
 *   renew/change 后新订阅 org_id 必须继承；change 必须重绑凭证；
 *   对 status=2 的订阅 renew 必须抛 no_subscription。
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
    .values({
      issuer: 'test',
      subject: `redsub-${randomUUID()}`,
      identityProvider: 'local',
      balance,
      isEnterprise,
    })
    .returning({ id: users.id });
  return user!.id;
}

async function createPlan(input: {
  price: string;
  quota: string;
  sortOrder: number;
  allowSeats?: boolean;
}): Promise<number> {
  const [plan] = await db
    .insert(plans)
    .values({
      name: `red-${randomUUID().slice(0, 6)}`,
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

async function createOrg(ownerId: number): Promise<number> {
  const [org] = await db
    .insert(organizations)
    .values({ name: `red-org-${randomUUID().slice(0, 6)}`, ownerUserId: ownerId })
    .returning({ id: organizations.id });
  return org!.id;
}

async function activeSubOf(userId: number): Promise<{
  id: number;
  orgId: number | null;
} | null> {
  const sub = await db.query.userSubscriptions.findFirst({
    where: and(eq(userSubscriptions.userId, userId), eq(userSubscriptions.status, 0)),
    columns: { id: true, orgId: true },
  });
  return sub ?? null;
}

async function cleanup(userId: number): Promise<void> {
  await db.delete(billingRequests).where(eq(billingRequests.userId, userId));
  await db.delete(usageLogs).where(eq(usageLogs.userId, userId));
  await db.delete(transactions).where(eq(transactions.userId, userId));
  await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
  await db.delete(apps).where(eq(apps.userId, userId));
  const subs = await db
    .select({ id: userSubscriptions.id })
    .from(userSubscriptions)
    .where(eq(userSubscriptions.userId, userId));
  for (const s of subs) {
    await db.delete(orgMembers).where(eq(orgMembers.orgId, s.id)); // 防御：误绑也不会卡外键
  }
  await db.delete(userSubscriptions).where(eq(userSubscriptions.userId, userId));
  await db.delete(organizations).where(eq(organizations.ownerUserId, userId));
  await db.delete(users).where(eq(users.id, userId));
}

describe('RED R3: 订阅 renew/change 必须保持组织归属并重绑凭证', () => {
  it('R3-1 组织订阅续费后 org_id 必须保留（成员不断供）', async (context) => {
    if (!connected) return context.skip();
    const ownerId = await createUser('1000', true);
    const ledger = createLedger({ db });
    try {
      const planId = await createPlan({ price: '100', quota: '80', sortOrder: 1, allowSeats: true });
      const orgId = await createOrg(ownerId);
      const buy = await ledger.subscribePlan({
        operationId: `red-r31-buy:${randomUUID()}`,
        userId: ownerId,
        planId,
        quantity: 3,
        orgId,
      });
      const subBefore = await activeSubOf(ownerId);
      expect(subBefore?.orgId).toBe(orgId); // 购买正确带 orgId

      await ledger.renewSubscription({
        operationId: `red-r31-renew:${randomUUID()}`,
        subscriptionId: buy.subscriptionId,
        userId: ownerId,
      });

      const subAfter = await activeSubOf(ownerId);
      expect(subAfter).not.toBeNull();
      expect(subAfter!.id).not.toBe(subBefore!.id); // 新订阅周期
      // 【红】当前实现 org_id=NULL → 组织订阅静默变个人订阅，成员全部 402
      expect(subAfter!.orgId).toBe(orgId);
    } finally {
      await cleanup(ownerId);
    }
  });

  it('R3-2 升档必须重绑旧订阅的 Key/App（用户付了差价不应全员断供）', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('1000');
    const ledger = createLedger({ db });
    try {
      const liteId = await createPlan({ price: '50', quota: '50', sortOrder: 1 });
      const proId = await createPlan({ price: '150', quota: '150', sortOrder: 2 });
      const buy = await ledger.subscribePlan({
        operationId: `red-r32-buy:${randomUUID()}`,
        userId,
        planId: liteId,
      });
      const [key] = await db
        .insert(apiKeys)
        .values({
          keyHash: `red-hash-${randomUUID()}`,
          keyPreview: 'ag_****red32',
          userId,
          name: 'bound-key',
          subscriptionId: buy.subscriptionId,
        })
        .returning({ id: apiKeys.id });
      const [app] = await db
        .insert(apps)
        .values({
          userId,
          appId: `red${randomUUID().replace(/-/g, '').slice(0, 24)}`,
          name: 'bound-app',
          clientId: `red_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          clientSecretHash: `red-secret-${randomUUID()}`,
          subscriptionId: buy.subscriptionId,
        })
        .returning({ id: apps.id });

      await ledger.changeSubscription({
        operationId: `red-r32-change:${randomUUID()}`,
        subscriptionId: buy.subscriptionId,
        targetPlanId: proId,
        quantity: 1,
        userId,
      });

      const subAfter = await activeSubOf(userId);
      expect(subAfter).not.toBeNull();
      const keyRow = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, key!.id),
        columns: { subscriptionId: true },
      });
      const appRow = await db.query.apps.findFirst({
        where: eq(apps.id, app!.id),
        columns: { subscriptionId: true },
      });
      // 【红】当前实现 Key/App 仍指向已到期旧订阅 → 网关 402 subscription_required
      expect(keyRow?.subscriptionId).toBe(subAfter!.id);
      expect(appRow?.subscriptionId).toBe(subAfter!.id);
    } finally {
      await cleanup(userId);
    }
  });

  it('R3-2b 组织订阅升档后 org_id 必须保留', async (context) => {
    if (!connected) return context.skip();
    const ownerId = await createUser('1000', true);
    const ledger = createLedger({ db });
    try {
      const liteId = await createPlan({ price: '100', quota: '80', sortOrder: 1, allowSeats: true });
      const proId = await createPlan({ price: '300', quota: '300', sortOrder: 2, allowSeats: true });
      const orgId = await createOrg(ownerId);
      const buy = await ledger.subscribePlan({
        operationId: `red-r32b-buy:${randomUUID()}`,
        userId: ownerId,
        planId: liteId,
        quantity: 2,
        orgId,
      });

      await ledger.changeSubscription({
        operationId: `red-r32b-change:${randomUUID()}`,
        subscriptionId: buy.subscriptionId,
        targetPlanId: proId,
        quantity: 2,
        userId: ownerId,
      });

      const subAfter = await activeSubOf(ownerId);
      expect(subAfter).not.toBeNull();
      // 【红】当前实现 change 的 insert 没有 orgId 字段 → NULL
      expect(subAfter!.orgId).toBe(orgId);
    } finally {
      await cleanup(ownerId);
    }
  });

  it('R3-3 已取消（status=2）的订阅不允许续费复活', async (context) => {
    if (!connected) return context.skip();
    const userId = await createUser('1000');
    const ledger = createLedger({ db });
    try {
      const planId = await createPlan({ price: '50', quota: '50', sortOrder: 1 });
      const buy = await ledger.subscribePlan({
        operationId: `red-r33-buy:${randomUUID()}`,
        userId,
        planId,
      });
      await ledger.cancelSubscription({
        operationId: `red-r33-cancel:${randomUUID()}`,
        subscriptionId: buy.subscriptionId,
      });
      const cancelled = await db.query.userSubscriptions.findFirst({
        where: eq(userSubscriptions.id, buy.subscriptionId),
        columns: { status: true },
      });
      expect(cancelled?.status).toBe(2);

      // 【红】当前实现 renew 无 status 过滤 → 复活成功；正确行为应拒绝
      await expect(
        ledger.renewSubscription({
          operationId: `red-r33-renew:${randomUUID()}`,
          subscriptionId: buy.subscriptionId,
          userId,
        }),
      ).rejects.toMatchObject({ code: 'no_subscription' });

      const active = await activeSubOf(userId);
      expect(active).toBeNull(); // 不得存在被复活的订阅
    } finally {
      await cleanup(userId);
    }
  });
});
