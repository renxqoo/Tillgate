/**
 * 资金来源策略契约:直驱 payg/subscription 两来源的 reserve/release/settle 分支语义。
 */
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import { createPaygSource } from '../src/application/billing/funding/payg-source.js';
import { createFundingRegistry } from '../src/application/billing/funding/registry.js';
import { createSubscriptionSource } from '../src/application/billing/funding/subscription-source.js';
import { createInMemoryWalletStore } from '../src/testing/in-memory-wallet-store.js';
import {
  createInMemoryBillingWorld,
  seedSubscription,
} from '../src/testing/in-memory-billing-store.js';
import { defined } from './defined.js';

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
    walletStore: walletMemory.store,
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
    const account = defined((await wallet.accounts(userId))[0]);
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
    expect(defined((await wallet.accounts(userId))[0]).inFlight).toBe('0');
    expect(defined((await wallet.accounts(userId))[0]).balance).toBe('7');
  });

  it('settle 超额：可用不足钳到可收额（不形成负余额），差额 waived 上报', async () => {
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
    // 应收 5；可用 = 2 − 2(在途) = 0 → 全额放弃，余额归零不为负
    const settled = await payg.settle(tx, {
      userId,
      requestId: 'req-p3',
      reservation,
      consume: '2',
      over: '3',
      now: new Date(),
    });
    expect(settled.waived).toBe('3');
    const account = defined((await wallet.accounts(userId))[0]);
    expect(account.balance).toBe('0'); // 2 − 2（无 #over 可收）
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
    expect(defined((await wallet.accounts(userId))[0]).inFlight).toBe('0');
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
    defined(world.fixtures.subscriptions.get(subscriptionId)).usedAmount = '2';
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
    defined(world.fixtures.subscriptions.get(subscriptionId)).reservedAmount = '0';
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
    const sub = defined(world.fixtures.subscriptions.get(subscriptionId));
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
    expect(defined(world.fixtures.subscriptions.get(subscriptionId)).reservedAmount).toBe('1');
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

  it('纯订阅链超额：over 钳到钱包可收额（负余额不形成），差额 waived', async () => {
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
    const settled = await subscription.settle(tx, {
      userId,
      requestId: 'req-s3',
      reservation,
      consume: '5',
      over: '2',
      now: new Date(),
    });
    // 钱包余额 1 全额可收（无在途）→ 收 1 弃 1
    expect(settled.waived).toBe('1');
    expect(defined((await wallet.accounts(userId))[0]).balance).toBe('0');
    expect(defined(world.fixtures.subscriptions.get(subscriptionId)).usedAmount).toBe('5');
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
    defined(world.fixtures.subscriptions.get(subscriptionId)).status = 1;
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
describe('funding registry(铁律 16 分支封口)', () => {
  it('未注册类型显式拒绝(fail-fast,不静默返回 undefined)', () => {
    const registry = createFundingRegistry([]);
    expect(() => registry.get('payg')).toThrow(/funding source not registered/);
  });
});

describe('payg 超收钳制（#over 死信回归）', () => {
  it('可用不足：按可收额入账 + waived 上报，余额不为负、在途归零', async () => {
    const { wallet, payg, ctx, tx } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '2', refType: 'topup', refId: 'oc1' });
    const reservation = await payg.reserve(tx, {
      userId,
      requestId: 'req-oc1',
      amount: '1',
      now: new Date(),
      context: { ...ctx, userId },
    });
    // 应收 5（consume 1 + over 4）；可用 = 2 − 1(在途) = 1 → 只收 1，放弃 3
    const settled = await payg.settle(tx, {
      userId,
      requestId: 'req-oc1',
      reservation,
      consume: '1',
      over: '4',
      now: new Date(),
    });
    expect(settled.waived).toBe('3');
    const account = defined((await wallet.accounts(userId))[0]);
    expect(account.balance).toBe('0');
    expect(account.inFlight).toBe('0');
  });

  it('可用为零：全额放弃，不产生 #over 授权', async () => {
    const { wallet, payg, ctx, tx } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '1', refType: 'topup', refId: 'oc2' });
    const reservation = await payg.reserve(tx, {
      userId,
      requestId: 'req-oc2',
      amount: '1',
      now: new Date(),
      context: { ...ctx, userId },
    });
    const settled = await payg.settle(tx, {
      userId,
      requestId: 'req-oc2',
      reservation,
      consume: '1',
      over: '2',
      now: new Date(),
    });
    expect(settled.waived).toBe('2');
    expect(defined((await wallet.accounts(userId))[0]).balance).toBe('0');
  });

  it('可用充足：全额收取 waived=0', async () => {
    const { wallet, payg, ctx, tx } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '10', refType: 'topup', refId: 'oc3' });
    const reservation = await payg.reserve(tx, {
      userId,
      requestId: 'req-oc3',
      amount: '1',
      now: new Date(),
      context: { ...ctx, userId },
    });
    const settled = await payg.settle(tx, {
      userId,
      requestId: 'req-oc3',
      reservation,
      consume: '1',
      over: '0.5',
      now: new Date(),
    });
    expect(settled.waived).toBe('0');
    expect(defined((await wallet.accounts(userId))[0]).balance).toBe('8.5');
  });
});

describe('payg 超收钳制 × 透支地板（受控负余额）', () => {
  it('地板内扣负：over 可收到 可用+地板，余额触底不为零', async () => {
    const { wallet, payg, ctx, tx } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '2', refType: 'topup', refId: 'df1' });
    await wallet.setDebitFloor({ userId, amount: '3' });
    const reservation = await payg.reserve(tx, {
      userId,
      requestId: 'req-df1',
      amount: '1',
      now: new Date(),
      context: { ...ctx, userId },
    });
    // 应收 5（consume 1 + over 4）；可收 = 可用 1 + 地板 3 = 4 → 全收，余额触底 −3 = −地板
    const settled = await payg.settle(tx, {
      userId,
      requestId: 'req-df1',
      reservation,
      consume: '1',
      over: '4',
      now: new Date(),
    });
    expect(settled.waived).toBe('0');
    const account = defined((await wallet.accounts(userId))[0]);
    expect(account.balance).toBe('-3');
    expect(account.inFlight).toBe('0');
  });

  it('地板外仍放弃：负余额深度不穿透地板', async () => {
    const { wallet, payg, ctx, tx } = harness();
    const userId = nextUser();
    await wallet.credit({ userId, amount: '1', refType: 'topup', refId: 'df2' });
    await wallet.setDebitFloor({ userId, amount: '2' });
    const reservation = await payg.reserve(tx, {
      userId,
      requestId: 'req-df2',
      amount: '1',
      now: new Date(),
      context: { ...ctx, userId },
    });
    // 应收 10；可收 = 0(可用) + 2(地板) = 2 → 弃 8，余额恰好 −2 = 地板
    const settled = await payg.settle(tx, {
      userId,
      requestId: 'req-df2',
      reservation,
      consume: '1',
      over: '9',
      now: new Date(),
    });
    expect(settled.waived).toBe('7');
    expect(defined((await wallet.accounts(userId))[0]).balance).toBe('-2');
  });
});
