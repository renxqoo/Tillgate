// 两阶段扣费之 settle：实扣落定——全额/部分/重放/并发/超扣

import { db, wallet, nextUser, ref, sameAmount, accountOf } from './helpers';
import { eq } from 'drizzle-orm';
import { walletAuthorizations, walletTransactions } from '../schema';
import { SettleExceedsHoldError } from '../index';
import { describe, expect, it } from 'vitest';
describe('settle：实扣落定——全额/部分/重放/并发/超扣', () => {
  it('全额结算：冻结 → 实扣，余额与在途归零', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '300', refType: 'topup', refId: ref(user, 't') });
    const hold = await wallet.authorize({
      userId: user,
      amount: '259.00',
      refType: 'order',
      refId: ref(user, 'full'),
    });
    expect(hold.status).toBe('active');
    expect(hold.replayed).toBe(false);

    const settled = await wallet.settle({
      refType: 'order',
      refId: ref(user, 'full'),
      amount: '259.00',
    });
    expect(settled.replayed).toBe(false);
    expect(sameAmount(settled.settledAmount, '259')).toBe(true);
    expect(sameAmount(settled.balanceAfter, '41')).toBe(true);
    expect(sameAmount(settled.releasedRemainder, '0')).toBe(true);

    const account = await accountOf(user);
    expect(sameAmount(account.balance, '41')).toBe(true);
    expect(sameAmount(account.inFlight, '0')).toBe(true);
  });

  it('部分结算：实扣少于冻结，余量归还（在途归零）', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({
      userId: user,
      amount: '80',
      refType: 'order',
      refId: ref(user, 'part'),
    });
    const settled = await wallet.settle({
      refType: 'order',
      refId: ref(user, 'part'),
      amount: '60',
    });
    expect(sameAmount(settled.settledAmount, '60')).toBe(true);
    expect(sameAmount(settled.releasedRemainder, '20')).toBe(true);
    const account = await accountOf(user);
    expect(sameAmount(account.balance, '40')).toBe(true);
    expect(sameAmount(account.inFlight, '0')).toBe(true);
  });

  it('结算重放返回首次结果', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({
      userId: user,
      amount: '30',
      refType: 'order',
      refId: ref(user, 're'),
    });
    const first = await wallet.settle({ refType: 'order', refId: ref(user, 're'), amount: '30' });
    const replay = await wallet.settle({ refType: 'order', refId: ref(user, 're'), amount: '30' });
    expect(replay.replayed).toBe(true);
    expect(sameAmount(replay.settledAmount, first.settledAmount)).toBe(true);
    expect(sameAmount(await wallet.balance(user), '70')).toBe(true);
  });

  it('并发双重结算：恰好一次生效', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({
      userId: user,
      amount: '40',
      refType: 'order',
      refId: ref(user, 'srace'),
    });
    const [a, b] = await Promise.all([
      wallet.settle({ refType: 'order', refId: ref(user, 'srace'), amount: '40' }),
      wallet.settle({ refType: 'order', refId: ref(user, 'srace'), amount: '40' }),
    ]);
    expect([a.replayed, b.replayed].toSorted()).toEqual([false, true]);
    expect(sameAmount(await wallet.balance(user), '60')).toBe(true);
    const headers = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.refId, ref(user, 'srace')));
    expect(headers.filter((h) => h.kind === 'settle')).toHaveLength(1);
  });

  it('结算超过冻结额拒绝，状态不变', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({
      userId: user,
      amount: '10',
      refType: 'order',
      refId: ref(user, 'over'),
    });
    await expect(
      wallet.settle({ refType: 'order', refId: ref(user, 'over'), amount: '11' }),
    ).rejects.toBeInstanceOf(SettleExceedsHoldError);
    const [auth] = await db
      .select()
      .from(walletAuthorizations)
      .where(eq(walletAuthorizations.refId, ref(user, 'over')));
    expect(auth?.status).toBe('active');
    expect(sameAmount(await wallet.balance(user), '100')).toBe(true);
  });
});
