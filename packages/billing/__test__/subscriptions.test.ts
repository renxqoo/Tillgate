/**
 * 订阅生命周期与幂等操作档案契约测试（内存 stand-in；迁移自旧仓 service/__tests__/
 * subscription 主干 + operations.test；真实 PG 的唯一索引/行锁竞态在 U5 收口真 PG 套件）。
 */
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tokenlens/errors';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createSubscriptionsApi } from '../src/application/subscriptions/subscriptions.js';
import { createOperationsUseCase, assertOperationId } from '../src/application/operations.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import {
  createInMemoryBillingWorld,
  type InMemoryPlanRow,
} from '../src/testing/in-memory-billing-store.js';

let userSeq = 1500;
const nextUser = () => (userSeq += 1);
let opSeq = 0;
const nextOp = () => `op-${(opSeq += 1)}`;

function seedPlan(
  world: ReturnType<typeof createInMemoryBillingWorld>,
  overrides: Partial<InMemoryPlanRow> = {},
): number {
  const id = (world.fixtures.plans.size + 1) * 100;
  world.fixtures.plans.set(id, {
    id,
    name: '标准档',
    kind: 'subscription',
    sortOrder: 1,
    price: '30',
    periodDays: 30,
    quotaAmount: '100',
    allowSeats: false,
    status: 0,
    ...overrides,
  });
  return id;
}

function harness() {
  const walletMemory = createInMemoryWalletStore();
  const wallet = createWalletApi({
    store: walletMemory.store,
    guards: {
      refTypes: ['billing', 'topup', 'admin', 'subscription', 'pack'],
      currencies: ['CNY'],
      internalAccounts: ['outside', 'platform_revenue'],
    },
    currency: 'CNY',
  });
  const world = createInMemoryBillingWorld();
  const subscriptions = createSubscriptionsApi({
    store: world.billing,
    accounts: world.accountContext,
    wallet,
    clock: () => new Date(),
  });
  return { wallet, world, subscriptions };
}

async function rejection(
  fn: () => Promise<unknown>,
): Promise<{ code: string; context: Record<string, unknown> }> {
  try {
    await fn();
  } catch (error) {
    if (isBusinessError(error)) {
      return { code: error.code, context: (error.context ?? {}) as Record<string, unknown> };
    }
    throw error;
  }
  throw new Error('expected rejection');
}

describe('operations 幂等档案', () => {
  it('占位→执行→回执存档；同键同参重放回执；同键异参 409', async () => {
    const { world } = harness();
    const operations = createOperationsUseCase({ store: world.billing });
    const first = await operations.run({
      operationId: 'op-abc',
      kind: 'subscription.purchase',
      payload: { userId: 1, planId: 2 },
      execute: async () => ({ ok: true as const }),
    });
    expect(first).toEqual({ receipt: { ok: true }, replayed: false });
    const replay = await operations.run({
      operationId: 'op-abc',
      kind: 'subscription.purchase',
      payload: { userId: 1, planId: 2 },
      execute: async () => ({ ok: false as const }),
    });
    expect(replay).toEqual({ receipt: { ok: true }, replayed: true });
    const conflict = await rejection(() =>
      operations.run({
        operationId: 'op-abc',
        kind: 'subscription.purchase',
        payload: { userId: 9, planId: 2 },
        execute: async () => ({ ok: true }),
      }),
    );
    expect(conflict.code).toBe('billing.idempotency_conflict');
  });

  it('operationId 词表 + kind 隔离（同键不同 kind = 异指纹冲突）', async () => {
    const { world } = harness();
    const operations = createOperationsUseCase({ store: world.billing });
    expect(() => assertOperationId('bad id!')).toThrow();
    expect(() => assertOperationId('')).toThrow();
    await operations.run({
      operationId: 'op-kind',
      kind: 'a',
      payload: { x: 1 },
      execute: async () => ({ r: 1 }),
    });
    const conflict = await rejection(() =>
      operations.run({
        operationId: 'op-kind',
        kind: 'b',
        payload: { x: 1 },
        execute: async () => ({ r: 2 }),
      }),
    );
    expect(conflict.code).toBe('billing.idempotency_conflict');
  });
});

describe('订阅生命周期', () => {
  it('purchase：现金购买（禁透支）→ 订阅行 + 收入科目入账；重放幂等', async () => {
    const { wallet, world, subscriptions } = harness();
    const userId = nextUser();
    world.fixtures.knownUsers.add(userId);
    await wallet.credit({ userId, amount: '100', refType: 'topup', refId: 'c1' });
    const planId = seedPlan(world);
    const first = await subscriptions.purchase({
      operationId: nextOp(),
      userId,
      planId,
      quantity: 1,
    });
    expect(first).toMatchObject({
      userId,
      quantity: 1,
      price: '30',
      quotaAmount: '100',
      replayed: false,
      balanceAfter: '70',
    });
    const sub = world.fixtures.subscriptions.get(first.subscriptionId)!;
    expect(sub.status).toBe(0);
    // 同 operationId 的重放语义已在 operations 档案测试证明；此处验证单有效订阅约束
    // 不同 operationId 再购 → already_subscribed
    const again = await rejection(() =>
      subscriptions.purchase({ operationId: nextOp(), userId, planId, quantity: 2 }),
    );
    expect(again.code).toBe('billing.subscription_state');
    expect(again.context.reason).toBe('already_subscribed');
    expect((await wallet.accounts(userId))[0]!.balance).toBe('70');
  });

  it('余额不足（现金口径禁透支）→ insufficient_cash，零残留', async () => {
    const { wallet, world, subscriptions } = harness();
    const userId = nextUser();
    world.fixtures.knownUsers.add(userId);
    await wallet.credit({ userId, amount: '10', refType: 'topup', refId: 'c2' });
    const planId = seedPlan(world);
    const rejected = await rejection(() =>
      subscriptions.purchase({ operationId: nextOp(), userId, planId }),
    );
    expect(rejected.code).toBe('billing.insufficient_cash');
    expect(world.fixtures.subscriptions.size).toBe(0);
  });

  it('套餐闸门：零价/停售/不存在/pack 类型/席位能力', async () => {
    const { wallet, world, subscriptions } = harness();
    const userId = nextUser();
    world.fixtures.knownUsers.add(userId);
    await wallet.credit({ userId, amount: '1000', refType: 'topup', refId: 'c3' });
    const zero = seedPlan(world, { price: '0' });
    const disabled = seedPlan(world, { status: 1 });
    const pack = seedPlan(world, { kind: 'pack' });
    const seats = seedPlan(world, { allowSeats: true });
    expect(
      (
        await rejection(() =>
          subscriptions.purchase({ operationId: nextOp(), userId, planId: zero }),
        )
      ).code,
    ).toBe('billing.plan_not_purchasable');
    expect(
      (
        await rejection(() =>
          subscriptions.purchase({ operationId: nextOp(), userId, planId: disabled }),
        )
      ).code,
    ).toBe('billing.plan_disabled');
    expect(
      (
        await rejection(() =>
          subscriptions.purchase({ operationId: nextOp(), userId, planId: 99999 }),
        )
      ).code,
    ).toBe('billing.plan_not_found');
    expect(
      (
        await rejection(() =>
          subscriptions.purchase({ operationId: nextOp(), userId, planId: pack }),
        )
      ).code,
    ).toBe('billing.not_a_pack');
    // 团队套餐要求企业账户（个人拒绝——防绕过企业验证开共享池）
    const enterpriseOnly = await rejection(() =>
      subscriptions.purchase({ operationId: nextOp(), userId, planId: seats }),
    );
    expect(enterpriseOnly.code).toBe('billing.subscription_rule');
    expect(enterpriseOnly.context.reason).toBe('enterprise_required');
    // 数量 >1 但套餐不允许席位
    const solo = seedPlan(world);
    const noSeats = await rejection(() =>
      subscriptions.purchase({ operationId: nextOp(), userId, planId: solo, quantity: 3 }),
    );
    expect(noSeats.context.reason).toBe('seats_not_allowed');
  });

  it('change：升档补差价（剩余价值线性折旧）；降档/无变化拒绝', async () => {
    const { wallet, world, subscriptions } = harness();
    const userId = nextUser();
    world.fixtures.knownUsers.add(userId);
    await wallet.credit({ userId, amount: '1000', refType: 'topup', refId: 'c4' });
    const basicId = seedPlan(world, {
      name: '基础档',
      sortOrder: 1,
      price: '30',
      quotaAmount: '100',
    });
    const proId = seedPlan(world, {
      name: '专业档',
      sortOrder: 2,
      price: '90',
      quotaAmount: '300',
    });
    const purchased = await subscriptions.purchase({
      operationId: nextOp(),
      userId,
      planId: basicId,
    });
    // 用掉一半额度 → 剩余价值 = 30 × 50/100 = 15；升档补差 = 90 − 15 = 75
    const sub = world.fixtures.subscriptions.get(purchased.subscriptionId)!;
    sub.usedAmount = '50';
    const changed = await subscriptions.change({
      operationId: nextOp(),
      userId,
      subscriptionId: purchased.subscriptionId,
      targetPlanId: proId,
      quantity: 1,
    });
    expect(changed).toMatchObject({ planId: proId, quotaAmount: '300', replayed: false });
    // 1000 − 30(购) − 75(差) = 895
    expect((await wallet.accounts(userId))[0]!.balance).toBe('895');
    expect(sub.status).toBe(1); // 旧订阅转到期
    // 降档拒绝 / 无变化拒绝
    expect(
      (
        await rejection(() =>
          subscriptions.change({
            operationId: nextOp(),
            userId,
            subscriptionId: changed.subscriptionId,
            targetPlanId: basicId,
            quantity: 1,
          }),
        )
      ).context.reason,
    ).toBe('downgrade_not_allowed');
    expect(
      (
        await rejection(() =>
          subscriptions.change({
            operationId: nextOp(),
            userId,
            subscriptionId: changed.subscriptionId,
            targetPlanId: proId,
            quantity: 1,
          }),
        )
      ).context.reason,
    ).toBe('already_subscribed');
  });

  it('renew：顺延（未到期从旧 end 起）+ 旧订阅转到期 + 凭证改绑', async () => {
    const { wallet, world, subscriptions } = harness();
    const userId = nextUser();
    world.fixtures.knownUsers.add(userId);
    await wallet.credit({ userId, amount: '1000', refType: 'topup', refId: 'c5' });
    const planId = seedPlan(world, { periodDays: 10 });
    const purchased = await subscriptions.purchase({ operationId: nextOp(), userId, planId });
    world.fixtures.credentialBindings.set(701, purchased.subscriptionId);
    const renewed = await subscriptions.renew({
      operationId: nextOp(),
      userId,
      subscriptionId: purchased.subscriptionId,
    });
    // 未到期续费从旧 end 顺延 10 天
    expect(new Date(renewed.endAt).getTime()).toBe(
      new Date(purchased.endAt).getTime() + 10 * 86_400_000,
    );
    expect(world.fixtures.subscriptions.get(purchased.subscriptionId)!.status).toBe(1);
    expect(world.fixtures.credentialBindings.get(701)).toBe(renewed.subscriptionId);
    expect((await wallet.accounts(userId))[0]!.balance).toBe('940'); // 1000 − 30 × 2
  });

  it('cancel：CAS 0→2 无资金变动；重复取消 no_subscription', async () => {
    const { wallet, world, subscriptions } = harness();
    const userId = nextUser();
    world.fixtures.knownUsers.add(userId);
    await wallet.credit({ userId, amount: '100', refType: 'topup', refId: 'c6' });
    const planId = seedPlan(world);
    const purchased = await subscriptions.purchase({ operationId: nextOp(), userId, planId });
    const cancelled = await subscriptions.cancel({
      operationId: nextOp(),
      subscriptionId: purchased.subscriptionId,
    });
    expect(cancelled.replayed).toBe(false);
    expect(world.fixtures.subscriptions.get(purchased.subscriptionId)!.status).toBe(2);
    expect((await wallet.accounts(userId))[0]!.balance).toBe('70'); // 无退款
    expect(
      (
        await rejection(() =>
          subscriptions.cancel({ operationId: nextOp(), subscriptionId: purchased.subscriptionId }),
        )
      ).context.reason,
    ).toBe('no_subscription');
  });

  it('grantPack：现金发放 + 配额加到有效订阅；无有效订阅拒绝', async () => {
    const { wallet, world, subscriptions } = harness();
    const userId = nextUser();
    world.fixtures.knownUsers.add(userId);
    await wallet.credit({ userId, amount: '100', refType: 'topup', refId: 'c7' });
    const planId = seedPlan(world);
    const packId = seedPlan(world, {
      kind: 'pack',
      name: '加油包',
      price: '5',
      quotaAmount: '20',
      periodDays: 0,
    });
    const noSub = await rejection(() =>
      subscriptions.grantPack({ operationId: nextOp(), userId, packId }),
    );
    expect(noSub.context.reason).toBe('no_subscription');
    const purchased = await subscriptions.purchase({ operationId: nextOp(), userId, planId });
    const granted = await subscriptions.grantPack({ operationId: nextOp(), userId, packId });
    expect(granted).toMatchObject({ quotaAdded: '20', balanceAfter: '65' });
    expect(world.fixtures.subscriptions.get(purchased.subscriptionId)!.quotaAmount).toBe('120');
  });
});

describe('U4 分支封口', () => {
  it('企业团队套餐：ensureOrg 同事务建组织；席位多席购买', async () => {
    const { wallet, world, subscriptions } = harness();
    const userId = nextUser();
    world.fixtures.knownUsers.add(userId);
    world.fixtures.enterpriseUsers.add(userId);
    await wallet.credit({ userId, amount: '1000', refType: 'topup', refId: 'c8' });
    const teamId = seedPlan(world, {
      name: '团队档',
      allowSeats: true,
      price: '50',
      quotaAmount: '200',
    });
    const purchased = await subscriptions.purchase({
      operationId: nextOp(),
      userId,
      planId: teamId,
      quantity: 3,
      ensureOrg: true,
    });
    expect(purchased).toMatchObject({ quantity: 3, price: '150', quotaAmount: '600' });
    expect(purchased.orgId).not.toBeNull();
  });

  it('免费升级（diff ≤ 0）：无资金变动，仅换行', async () => {
    const { wallet, world, subscriptions } = harness();
    const userId = nextUser();
    world.fixtures.knownUsers.add(userId);
    await wallet.credit({ userId, amount: '100', refType: 'topup', refId: 'c9' });
    const aId = seedPlan(world, { name: 'A', sortOrder: 1, price: '30' });
    // 免费升级路径：目标价低于剩余价值（A 剩余价值 30 ≥ C 价 20 → diff = 0）
    const cId = seedPlan(world, { name: 'C', sortOrder: 3, price: '20', quotaAmount: '300' });
    const purchased = await subscriptions.purchase({ operationId: nextOp(), userId, planId: aId });
    const changed = await subscriptions.change({
      operationId: nextOp(),
      userId,
      subscriptionId: purchased.subscriptionId,
      targetPlanId: cId,
      quantity: 1,
    });
    expect(changed.balanceBefore).toBeNull();
    expect(changed.balanceAfter).toBeNull();
    expect((await wallet.accounts(userId))[0]!.balance).toBe('70'); // 只有首次购买扣款
  });

  it('管理面续费（userId=null 免属主检查）', async () => {
    const { wallet, world, subscriptions } = harness();
    const userId = nextUser();
    world.fixtures.knownUsers.add(userId);
    await wallet.credit({ userId, amount: '1000', refType: 'topup', refId: 'c10' });
    const planId = seedPlan(world);
    const purchased = await subscriptions.purchase({ operationId: nextOp(), userId, planId });
    const renewed = await subscriptions.renew({
      operationId: nextOp(),
      userId: null,
      subscriptionId: purchased.subscriptionId,
    });
    expect(renewed.userId).toBe(userId);
  });

  it('operations 回执超限（16KB）= 缺陷红灯', async () => {
    const { world } = harness();
    const operations = createOperationsUseCase({ store: world.billing });
    let caught: unknown;
    try {
      await operations.run({
        operationId: 'op-oversize',
        kind: 'test',
        payload: { x: 1 },
        execute: async () => ({ blob: 'x'.repeat(20_000) }),
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe('billing.operation_receipt_oversize');
  });
});
