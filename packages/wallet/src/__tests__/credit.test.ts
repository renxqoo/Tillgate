// wallet 入账 credit → 模块化测试（源自 wallet.test.ts 拆分）

import { db, wallet, nextUser, ref, sameAmount } from './helpers';
import { eq } from 'drizzle-orm';
import { walletTransactions } from '../schema';
import { RefKeyConflictError } from '../index';
import { describe, expect, it } from 'vitest';
describe('入账 credit', () => {
  it('入账更新余额，顺序重放返回首次结果（幂等）', async () => {
    const user = nextUser();
    const first = await wallet.credit({
      userId: user,
      amount: '99.00',
      refType: 'topup',
      refId: ref(user, 'tp1'),
    });
    const replay = await wallet.credit({
      userId: user,
      amount: '99.00',
      refType: 'topup',
      refId: ref(user, 'tp1'),
    });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(sameAmount(replay.balanceAfter, first.balanceAfter)).toBe(true);
    expect(sameAmount(await wallet.balance(user), '99')).toBe(true);
    const headers = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.refId, ref(user, 'tp1')));
    expect(headers).toHaveLength(1);
  });

  it('并发同键重放：恰好一笔交易', async () => {
    const user = nextUser();
    const [a, b] = await Promise.all([
      wallet.credit({ userId: user, amount: '50', refType: 'topup', refId: ref(user, 'race') }),
      wallet.credit({ userId: user, amount: '50', refType: 'topup', refId: ref(user, 'race') }),
    ]);
    expect([a.replayed, b.replayed].toSorted()).toEqual([false, true]);
    expect(sameAmount(await wallet.balance(user), '50')).toBe(true);
    const headers = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.refId, ref(user, 'race')));
    expect(headers).toHaveLength(1);
  });

  it('非法金额拒绝（0/负数/非数字），无状态残留', async () => {
    const user = nextUser();
    await expect(
      wallet.credit({ userId: user, amount: '0', refType: 'topup', refId: 'x' }),
    ).rejects.toThrow();
    await expect(
      wallet.credit({ userId: user, amount: '-5', refType: 'topup', refId: 'x' }),
    ).rejects.toThrow();
    await expect(
      wallet.credit({ userId: user, amount: 'abc', refType: 'topup', refId: 'x' }),
    ).rejects.toThrow();
    expect(sameAmount(await wallet.balance(user), '0')).toBe(true);
  });

  it('幂等键跨账户顶撞：拒绝并指向键主，绝不把别人的流水当重放结果', async () => {
    const owner = nextUser();
    const intruder = nextUser();
    await wallet.credit({
      userId: owner,
      amount: '10',
      refType: 'topup',
      refId: ref(owner, 'clash'),
    });
    const error = await wallet
      .credit({ userId: intruder, amount: '5', refType: 'topup', refId: ref(owner, 'clash') })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefKeyConflictError);
    expect((error as RefKeyConflictError).ownerUserId).toBe(owner);
    expect(sameAmount(await wallet.balance(intruder), '0')).toBe(true);

    await wallet.credit({
      userId: intruder,
      amount: '10',
      refType: 'topup',
      refId: ref(intruder, 't'),
    });
    await wallet.authorize({
      userId: owner,
      amount: '3',
      refType: 'order',
      refId: ref(owner, 'clash2'),
    });
    await expect(
      wallet.authorize({
        userId: intruder,
        amount: '1',
        refType: 'order',
        refId: ref(owner, 'clash2'),
      }),
    ).rejects.toBeInstanceOf(RefKeyConflictError);
  });
});
