/** subscription 动词集成规格（S3）：资金全程走 wallet（现金口径），
 *  业务状态机与资金变动同事务同生共死；行为对齐旧实现，资金实现换 wallet。 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { createDb, type Db } from '@ai-gateway/db';
import {
  organizations,
  plans,
  users,
  userSubscriptions,
} from '@ai-gateway/db/schema';
import { createWallet, type Wallet } from '@ai-gateway/wallet';
import { toDecimal } from '@ai-gateway/wallet/metering';
import { InsufficientCashError } from '@ai-gateway/wallet';
import { LedgerError } from '../../platform/errors.js';
import { createSubscriptionDomain, type SubscriptionDomain } from '../index.js';

const db: Db = createDb(
  process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
  { poolMax: 5 },
);
const wallet: Wallet = createWallet(db, {
  accounts: [],
  refTypes: ['topup', 'subscription', 'pack'],
  currencies: ['CNY'],
});
const domain: SubscriptionDomain = createSubscriptionDomain({ db, wallet });

/** 测试数据前缀（清理双重条件） */
const PREFIX = 'subrw';
const createdUsers: number[] = [];
const createdPlans: number[] = [];
const createdSubs: number[] = [];

beforeAll(async () => {
  await db.query.users.findFirst({ columns: { id: true } });
});
afterAll(async () => {
  // 只清自己前缀创建的行（双重条件：前缀 + 本进程 id 清单）
  if (createdSubs.length > 0) {
    await db.delete(userSubscriptions).where(inArray(userSubscriptions.id, createdSubs));
  }
  if (createdPlans.length > 0) {
    await db.delete(plans).where(inArray(plans.id, createdPlans));
  }
  if (createdUsers.length > 0) {
    await db.delete(organizations).where(inArray(organizations.ownerUserId, createdUsers));
    await db.delete(users).where(inArray(users.id, createdUsers));
  }
  await db.$client.end().catch(() => {});
});

async function createUser(overrides: { isEnterprise?: boolean } = {}): Promise<number> {
  const [user] = await db
    .insert(users)
    .values({
      issuer: PREFIX,
      subject: `${PREFIX}-${randomUUID()}`,
      identityProvider: 'local',
      isEnterprise: overrides.isEnterprise ?? false,
    })
    .returning({ id: users.id });
  const userId = user!.id;
  createdUsers.push(userId);
  return userId;
}

/** wallet 入金（新模型下测试资金来源；users.balance 不再是资金事实） */
async function fund(userId: number, amount: string): Promise<void> {
  await wallet.credit({
    userId,
    amount,
    refType: 'topup',
    refId: `${PREFIX}-fund-${userId}-${amount}-${randomUUID().slice(0, 8)}`,
  });
}

async function createPlan(overrides: Partial<typeof plans.$inferInsert> = {}): Promise<number> {
  const [plan] = await db
    .insert(plans)
    .values({
      name: `${PREFIX}-${randomUUID().slice(0, 8)}`,
      kind: 'subscription',
      price: '100',
      periodDays: 30,
      quotaAmount: '200',
      status: 0,
      ...overrides,
    })
    .returning({ id: plans.id });
  const planId = plan!.id;
  createdPlans.push(planId);
  return planId;
}

async function activeSub(userId: number): Promise<{ id: number } | undefined> {
  return db.query.userSubscriptions.findFirst({
    where: and(
      eq(userSubscriptions.userId, userId),
      eq(userSubscriptions.status, 0),
    ),
    columns: { id: true },
  });
}

const op = (key: string): string => `${PREFIX}-${key}-${randomUUID().slice(0, 8)}`;

describe('purchase：现金购买（wallet.transfer cash-only）', () => {
  it('扣款落 wallet、订阅行落库、同键重放不二次扣款', async () => {
    const user = await createUser();
    await fund(user, '1000');
    const planId = await createPlan();
    const operationId = op('buy');

    const result = await domain.purchase({ operationId, userId: user, planId });
    expect(result.replayed).toBe(false);
    expect(result.price).toBe('100');
    expect(result.quotaAmount).toBe('200');
    expect(toDecimal(await wallet.balance(user)).toNumber()).toBe(900);
    expect((await activeSub(user))?.id).toBe(result.subscriptionId);
    createdSubs.push(result.subscriptionId);

    // 同键重放：返回首次回执，余额与订阅不再变化
    const replay = await domain.purchase({ operationId, userId: user, planId });
    expect(replay.replayed).toBe(true);
    expect(replay.subscriptionId).toBe(result.subscriptionId);
    expect(toDecimal(await wallet.balance(user)).toNumber()).toBe(900);

    // 不同键的重复购买 → already_subscribed
    const again = await domain
      .purchase({ operationId: op('buy2'), userId: user, planId })
      .catch((error) => error as LedgerError);
    expect(again).toBeInstanceOf(LedgerError);
    expect((again as LedgerError).code).toBe('already_subscribed');
  });

  it('禁透支：授信在场也必须现金足够（InsufficientCashError，402 语义）', async () => {
    const user = await createUser();
    await fund(user, '50');
    await wallet.setCreditLimit({
      userId: user,
      amount: '1000',
      refType: 'topup',
      refId: `${PREFIX}-cl-${user}`,
    });
    const planId = await createPlan();
    const rejection = await domain
      .purchase({ operationId: op('cash'), userId: user, planId })
      .catch((error) => error);
    expect(rejection).toBeInstanceOf(InsufficientCashError);
    expect(await activeSub(user)).toBeUndefined();
    // 账户与流水零残留（整个操作事务回滚）
    expect(toDecimal(await wallet.balance(user)).toNumber()).toBe(50);
  });

  it('已自然到期但 status=0 的订阅被惰性翻转，可重新购买（C4）', async () => {
    const user = await createUser();
    await fund(user, '500');
    const planId = await createPlan();
    const [stale] = await db
      .insert(userSubscriptions)
      .values({
        userId: user,
        planId,
        startAt: new Date(Date.now() - 60 * 86_400_000),
        endAt: new Date(Date.now() - 30 * 86_400_000),
        quotaAmount: '200',
        price: '100',
      })
      .returning({ id: userSubscriptions.id });
    createdSubs.push(stale!.id);

    const result = await domain.purchase({ operationId: op('stale'), userId: user, planId });
    expect(result.replayed).toBe(false);
    const [flipped] = await db
      .select({ status: userSubscriptions.status })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, stale!.id));
    expect(flipped?.status).toBe(1);
    createdSubs.push(result.subscriptionId);
  });
});

describe('renew：顺延与继承', () => {
  it('未到期续费从旧 end 顺延；旧订阅转到期、新订阅继承席位与套餐', async () => {
    const user = await createUser();
    await fund(user, '1000');
    const planId = await createPlan();
    const first = await domain.purchase({ operationId: op('r1'), userId: user, planId });
    createdSubs.push(first.subscriptionId);

    const renewed = await domain.renew({
      operationId: op('r2'),
      userId: user,
      subscriptionId: first.subscriptionId,
    });
    expect(renewed.replayed).toBe(false);
    expect(renewed.planId).toBe(planId);
    // 顺延：新 startAt = 旧 endAt（未到期）
    expect(new Date(renewed.startAt).getTime()).toBe(new Date(first.endAt).getTime());
    const [oldRow] = await db
      .select({ status: userSubscriptions.status })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, first.subscriptionId));
    expect(oldRow?.status).toBe(1);
    expect(toDecimal(await wallet.balance(user)).toNumber()).toBe(800);
    createdSubs.push(renewed.subscriptionId);
  });

  it('已取消订阅不得续费复活（no_subscription）', async () => {
    const user = await createUser();
    await fund(user, '1000');
    const planId = await createPlan();
    const first = await domain.purchase({ operationId: op('c1'), userId: user, planId });
    createdSubs.push(first.subscriptionId);
    await domain.cancel({ operationId: op('c2'), subscriptionId: first.subscriptionId });
    const rejection = await domain
      .renew({ operationId: op('c3'), userId: user, subscriptionId: first.subscriptionId })
      .catch((error) => error as LedgerError);
    expect(rejection).toBeInstanceOf(LedgerError);
    expect((rejection as LedgerError).code).toBe('no_subscription');
  });
});

describe('change：升档折算', () => {
  it('补差价 = 新总价 − 剩余价值（按已用/在途折旧），现金口径收款', async () => {
    const user = await createUser();
    await fund(user, '2000');
    const liteId = await createPlan({ price: '100', quotaAmount: '200', sortOrder: 1 });
    const proId = await createPlan({ price: '300', quotaAmount: '600', sortOrder: 2 });
    const first = await domain.purchase({ operationId: op('up1'), userId: user, planId: liteId });
    createdSubs.push(first.subscriptionId);
    // 已用 50（总额度 200）：剩余价值 = 100 × 150/200 = 75；补差 = 300 − 75 = 225
    await db
      .update(userSubscriptions)
      .set({ usedAmount: '50' })
      .where(eq(userSubscriptions.id, first.subscriptionId));

    const changed = await domain.change({
      operationId: op('up2'),
      userId: user,
      subscriptionId: first.subscriptionId,
      targetPlanId: proId,
      quantity: 1,
    });
    expect(changed.price).toBe('300');
    // 2000 − 100（购买）− 225（补差）= 1675
    expect(toDecimal(await wallet.balance(user)).toNumber()).toBe(1675);
    expect(changed.balanceAfter).toBe('1675');
    createdSubs.push(changed.subscriptionId);
  });

  it('降级与无变化拒绝；同档加座按剩余价值折算', async () => {
    const user = await createUser({ isEnterprise: true });
    await fund(user, '2000');
    const liteId = await createPlan({ price: '100', quotaAmount: '200', sortOrder: 1 });
    const proId = await createPlan({
      price: '300',
      quotaAmount: '600',
      sortOrder: 2,
      allowSeats: true,
    });
    const first = await domain.purchase({ operationId: op('dg1'), userId: user, planId: proId });
    createdSubs.push(first.subscriptionId);

    const downgrade = await domain
      .change({
        operationId: op('dg2'),
        userId: user,
        subscriptionId: first.subscriptionId,
        targetPlanId: liteId,
        quantity: 1,
      })
      .catch((error) => error as LedgerError);
    expect((downgrade as LedgerError).code).toBe('downgrade_not_allowed');

    const samePlan = await domain
      .change({
        operationId: op('dg3'),
        userId: user,
        subscriptionId: first.subscriptionId,
        targetPlanId: proId,
        quantity: 1,
      })
      .catch((error) => error as LedgerError);
    expect((samePlan as LedgerError).code).toBe('already_subscribed');

    // 席位扩容（同档加座）：剩余额度趋零 → 剩余价值 ≈ 0 → 按全价 600 收款
    await db
      .update(userSubscriptions)
      .set({ usedAmount: '590', reservedAmount: '10' })
      .where(eq(userSubscriptions.id, first.subscriptionId));
    const upgraded = await domain.change({
      operationId: op('dg4'),
      userId: user,
      subscriptionId: first.subscriptionId,
      targetPlanId: proId,
      quantity: 2,
    });
    expect(upgraded.price).toBe('600');
    createdSubs.push(upgraded.subscriptionId);
  });
});

describe('cancel / pack', () => {
  it('cancel CAS 状态 0→2，重复取消拒绝', async () => {
    const user = await createUser();
    await fund(user, '1000');
    const planId = await createPlan();
    const first = await domain.purchase({ operationId: op('x1'), userId: user, planId });
    createdSubs.push(first.subscriptionId);
    const cancelled = await domain.cancel({
      operationId: op('x2'),
      subscriptionId: first.subscriptionId,
    });
    expect(cancelled.replayed).toBe(false);
    const repeat = await domain
      .cancel({ operationId: op('x3'), subscriptionId: first.subscriptionId })
      .catch((error) => error as LedgerError);
    expect((repeat as LedgerError).code).toBe('no_subscription');
  });

  it('pack：现金收款 + 订阅额度累加；无有效订阅拒绝', async () => {
    const user = await createUser();
    const packId = await createPlan({ kind: 'pack', price: '10', quotaAmount: '50', periodDays: 0 });
    const bare = await domain
      .grantPack({ operationId: op('p0'), userId: user, packId })
      .catch((error) => error as LedgerError);
    expect((bare as LedgerError).code).toBe('no_subscription');

    await fund(user, '200');
    const planId = await createPlan();
    const first = await domain.purchase({ operationId: op('p1'), userId: user, planId });
    createdSubs.push(first.subscriptionId);

    const packed = await domain.grantPack({ operationId: op('p2'), userId: user, packId });
    expect(packed.price).toBe('10');
    expect(toDecimal(await wallet.balance(user)).toNumber()).toBe(90);
    const [sub] = await db
      .select({ quotaAmount: userSubscriptions.quotaAmount })
      .from(userSubscriptions)
      .where(eq(userSubscriptions.id, first.subscriptionId));
    expect(toDecimal(sub!.quotaAmount).toNumber()).toBe(250); // 200 + 50
  });
});
