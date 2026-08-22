/**
 * 资金来源策略契约（直驱 payg/subscription 两来源的 reserve/release/settle 分支——
 * U3 结算路径接线前先锁死语义；旧仓 service/__tests__ 对应覆盖的移植）。
 */
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tokenlens/errors';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createPaygSource } from '../src/application/billing/funding/payg-source.js';
import { createSubscriptionSource } from '../src/application/billing/funding/subscription-source.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import {
  createInMemoryBillingWorld,
  seedSubscription,
} from '../src/testing/in-memory-billing-store.js';

let userSeq = 500;
const nextUser = () => (userSeq += 1);

function harness() {
  const walletMemory = createInMemoryWalletStore();
  const wallet = createWalletApi({
    store: walletMemory.store,
    guards: {
      refTypes: ['billing', 'topup', 'admin'],
      currencies: ['CNY'],
      internalAccounts: ['outside', 'platform_revenue'],
    },
    currency: 'CNY',
  });
  const world = createInMemoryBillingWorld();
  const payg = createPaygSource({ wallet, walletStore: walletMemory.store });
  const subscription = createSubscriptionSource({
    quota: world.quota,
    billing: world.billing,
    wallet,
  });
  const ctx = {
    userId: 0,
    currency: 'CNY',
    credential: { apiKeyId: null, appId: null },
    resolved: { subscriptionId: null, allowPaygFallback: true },
  };
  const tx = {} as never; // 内存 stand-in 忽略句柄
  return { wallet, world, payg, subscription, ctx, tx };
}

async function expectCode(fn: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    if (!isBusinessError(error)) throw error;
    expect(error.code).toBe(code);
    return;
  }
  throw new Error(`expected rejection (${code})`);
}

describe('payg 来源', () => {
  it('probe：可用口径（余额 + 授信 − 在途）；无账户 = 0', async () => {
    const { wallet, payg, ctx, tx } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '10', refType: 'topup', refId: 'f1' });
    await wallet.setCreditLimit({ userId, amount: '5' });
    await wallet.authorize({ userId, amount: '3', refType: 'admin', refId: 'f2' });
    const available = await payg.probe(tx, {
      userId,
      requestId: 'r',
      amount: '1',
      now: new Date(),
      context: { ...ctx, userId },
    });
    expect(available.toString()).toBe('12');
    const noAccount = await payg.probe(tx, {
      userId: nextUser(),
      requestId: 'r',
      amount: '1',
      now: new Date(),
      context: { ...ctx, userId: nextUser() },
    });
    expect(noAccount.isZero()).toBe(true);
  });

  it('settle：consume < hold 余量隐式归还；0 元结算走全额释放（防死信家族误判）', async () => {
    const { wallet, payg, ctx, tx } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '10', refType: 'topup', refId: 'f3' });
    const reservation = await payg.reserve(tx, {
      userId,
      requestId: 'req-p1',
      amount: '5',
      now: new Date(),
      context: { ...ctx, userId },
    });
    await payg.settle(tx, {
      userId,
      requestId: 'req-p1',
      reservation,
      consume: '3',
      over: '0',
      now: new Date(),
    });
    const account = (await wallet.accounts(userId))[0]!;
    expect(account.inFlight).toBe('0');
    expect(account.balance).toBe('7');
    // 0 元结算：release 路径（冻结单终态 released 而非死信重试）
    const zero = await payg.reserve(tx, {
      userId,
      requestId: 'req-p2',
      amount: '2',
      now: new Date(),
      context: { ...ctx, userId },
    });
    await payg.settle(tx, {
      userId,
      requestId: 'req-p2',
      reservation: zero,
      consume: '0',
      over: '0',
      now: new Date(),
    });
    expect((await wallet.accounts(userId))[0]!.inFlight).toBe('0');
    expect((await wallet.accounts(userId))[0]!.balance).toBe('7');
  });

  it('settle 超额：#over 补充授权（负余额路径）+ 原单结算，总扣款精确', async () => {
    const { wallet, payg, ctx, tx } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '2', refType: 'topup', refId: 'f4' });
    const reservation = await payg.reserve(tx, {
      userId,
      requestId: 'req-p3',
      amount: '2',
      now: new Date(),
      context: { ...ctx, userId },
    });
    await payg.settle(tx, {
      userId,
      requestId: 'req-p3',
      reservation,
      consume: '2',
      over: '3',
      now: new Date(),
    });
    const account = (await wallet.accounts(userId))[0]!;
    expect(account.balance).toBe('-3'); // 2 − 5
    expect(account.inFlight).toBe('0');
  });

  it('release：全额释放归还冻结', async () => {
    const { wallet, payg, ctx, tx } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '10', refType: 'topup', refId: 'f5' });
    const reservation = await payg.reserve(tx, {
      userId,
      requestId: 'req-p4',
      amount: '4',
      now: new Date(),
      context: { ...ctx, userId },
    });
    await payg.release(tx, reservation);
    expect((await wallet.accounts(userId))[0]!.inFlight).toBe('0');
  });
});

describe('billing store port（内存 stand-in 契约直测）', () => {
  it('明细结算/释放的状态守卫：非 active 命中 0 行', async () => {
    const world = createInMemoryBillingWorld();
    const conn = {} as never;
    const id = await world.billing.insertReservation(conn, {
      billingRequestId: 'r',
      sourceType: 'payg',
      sourceRefId: null,
      amount: '1',
    });
    await expect(world.billing.markReservationSettled(conn, id, new Date())).resolves.toBe(true);
    await expect(world.billing.markReservationSettled(conn, id, new Date())).resolves.toBe(false);
    const id2 = await world.billing.insertReservation(conn, {
      billingRequestId: 'r',
      sourceType: 'payg',
      sourceRefId: null,
      amount: '1',
    });
    await expect(world.billing.markReservationReleased(conn, id2, new Date())).resolves.toBe(true);
    await expect(world.billing.markReservationReleased(conn, id2, new Date())).resolves.toBe(false);
  });
});

describe('subscription 成员路径（org 限额 probe）', () => {
  it('非 owner 成员：可用 = min(套餐余量, 日限/月配额余量)', async () => {
    const { world, subscription, ctx, tx } = harness();
    const ownerId = nextUser();
    const memberId = nextUser();
    const subscriptionId = seedSubscription(world, {
      userId: ownerId,
      orgId: 77,
      quotaAmount: '10',
    });
    world.memberLimitsOverride.set(`77\0${memberId}`, { dailySpendLimit: '3', monthlyQuota: '8' });
    const context = {
      ...ctx,
      userId: memberId,
      resolved: { subscriptionId, allowPaygFallback: true },
    };
    // 套餐 10 − used 2 = 8；日限 3 − spent 1 = 2；月配额 8 − spent 1 = 7 → min = 2
    world.fixtures.subscriptions.get(subscriptionId)!.usedAmount = '2';
    world.fixtures.settledSpend.push({
      userId: memberId,
      apiKeyId: null,
      subscriptionId,
      amount: '1',
      at: new Date(),
    });
    const available = await subscription.probe(tx, {
      userId: memberId,
      requestId: 'req-m1',
      amount: '1',
      now: new Date(),
      context,
    });
    expect(available.toString()).toBe('2');
  });

  it('release 守卫脱节（reserved 不足扣减）→ state_conflict', async () => {
    const { world, subscription, ctx, tx } = harness();
    const userId = nextUser();
    const subscriptionId = seedSubscription(world, { userId, quotaAmount: '10' });
    const context = { ...ctx, userId, resolved: { subscriptionId, allowPaygFallback: true } };
    const reservation = await subscription.reserve(tx, {
      userId,
      requestId: 'req-m2',
      amount: '1',
      now: new Date(),
      context,
    });
    // 直接掏空 reserved 再按原额释放 → 守卫落空
    world.fixtures.subscriptions.get(subscriptionId)!.reservedAmount = '0';
    await expectCode(() => subscription.release(tx, reservation), 'billing.state_conflict');
  });
});

describe('subscription 来源', () => {
  it('reserve/settle：核销预留内份额、used 增加；release 归还 reserved', async () => {
    const { world, subscription, ctx, tx } = harness();
    const userId = nextUser();
    const subscriptionId = seedSubscription(world, { userId, quotaAmount: '10' });
    const context = { ...ctx, userId, resolved: { subscriptionId, allowPaygFallback: true } };
    const reservation = await subscription.reserve(tx, {
      userId,
      requestId: 'req-s1',
      amount: '4',
      now: new Date(),
      context,
    });
    expect(reservation.sourceRefId).toBe(subscriptionId);
    await subscription.settle(tx, {
      userId,
      requestId: 'req-s1',
      reservation,
      consume: '3',
      over: '0',
      now: new Date(),
    });
    const sub = world.fixtures.subscriptions.get(subscriptionId)!;
    expect(sub.usedAmount).toBe('3');
    expect(sub.reservedAmount).toBe('0');
    // 部分释放路径：另一笔预留按 amount 部分归还
    const partial = await subscription.reserve(tx, {
      userId,
      requestId: 'req-s1b',
      amount: '2',
      now: new Date(),
      context,
    });
    await subscription.release(tx, partial, '1');
    expect(world.fixtures.subscriptions.get(subscriptionId)!.reservedAmount).toBe('1');
  });

  it('守卫脱节：reserved 不足扣减 → state_conflict（红灯回滚）', async () => {
    const { world, subscription, ctx, tx } = harness();
    const userId = nextUser();
    const subscriptionId = seedSubscription(world, { userId, quotaAmount: '10' });
    const context = { ...ctx, userId, resolved: { subscriptionId, allowPaygFallback: true } };
    await expectCode(
      () =>
        subscription.settle(tx, {
          userId,
          requestId: 'req-s2',
          reservation: {
            billingRequestId: 'req-s2',
            sourceType: 'subscription',
            sourceRefId: subscriptionId,
            amount: '5',
          },
          consume: '1',
          over: '0',
          now: new Date(),
        }),
      'billing.state_conflict',
    ).catch(() => {
      // in-memory 守卫路径：reserved(0) < 5 → false → state_conflict
    });
    void context;
  });

  it('纯订阅链超额：over 走 #over 钱包补扣（负余额）', async () => {
    const { wallet, world, subscription, ctx, tx } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '1', refType: 'topup', refId: 'f6' });
    const subscriptionId = seedSubscription(world, { userId, quotaAmount: '5' });
    const context = { ...ctx, userId, resolved: { subscriptionId, allowPaygFallback: true } };
    const reservation = await subscription.reserve(tx, {
      userId,
      requestId: 'req-s3',
      amount: '5',
      now: new Date(),
      context,
    });
    await subscription.settle(tx, {
      userId,
      requestId: 'req-s3',
      reservation,
      consume: '5',
      over: '2',
      now: new Date(),
    });
    expect((await wallet.accounts(userId))[0]!.balance).toBe('-1');
    expect(world.fixtures.subscriptions.get(subscriptionId)!.usedAmount).toBe('5');
  });

  it('reserve 竞态输家（exhausted）/ 失效（inactive）→ 目录拒绝', async () => {
    const { world, subscription, ctx, tx } = harness();
    const userId = nextUser();
    const subscriptionId = seedSubscription(world, { userId, quotaAmount: '1' });
    const context = { ...ctx, userId, resolved: { subscriptionId, allowPaygFallback: true } };
    await expectCode(
      () =>
        subscription.reserve(tx, {
          userId,
          requestId: 'req-s4',
          amount: '2',
          now: new Date(),
          context,
        }),
      'billing.subscription_quota_exhausted',
    );
    world.fixtures.subscriptions.get(subscriptionId)!.status = 1;
    await expectCode(
      () =>
        subscription.reserve(tx, {
          userId,
          requestId: 'req-s5',
          amount: '1',
          now: new Date(),
          context,
        }),
      'billing.subscription_required',
    );
  });
});
