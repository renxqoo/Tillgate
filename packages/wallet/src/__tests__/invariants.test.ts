// wallet 全局不变量 → 模块化测试（源自 wallet.test.ts 拆分）

import { provision } from '../schema';
import { db, wallet, nextUser, ref, sameAmount, d, accountOf, legsOfAccount, assertLedgerCoherent } from './helpers';
import { Decimal } from '../index';
import { describe, expect, it } from 'vitest';
describe('全局不变量', () => {
  it('混合操作后：流水链恒等、连续，账户余额 = 各腿代数和', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100.5', refType: 'topup', refId: ref(user, 'iv1') });
    await wallet.credit({ userId: user, amount: '0.5', refType: 'gift', refId: ref(user, 'iv2') });
    await wallet.authorize({ userId: user, amount: '60', refType: 'order', refId: ref(user, 'iv3') });
    await wallet.settle({ refType: 'order', refId: ref(user, 'iv3'), amount: '55' });
    await wallet.authorize({ userId: user, amount: '10', refType: 'order', refId: ref(user, 'iv4') });
    await wallet.release({ refType: 'order', refId: ref(user, 'iv4') });
    await wallet.refund({ userId: user, amount: '1.25', refType: 'topup_refund', refId: ref(user, 'iv1') });

    const account = await accountOf(user);
    expect(d(account.balance).eq(new Decimal('44.75'))).toBe(true); // 101 − 55 − 1.25

    // 用户账户腿链复核
    const legs = await legsOfAccount(account.id);
    expect(legs.length).toBeGreaterThanOrEqual(4);
    let expected = new Decimal(0);
    for (const leg of legs) {
      expect(d(leg.balanceAfter).eq(d(leg.balanceBefore).plus(d(leg.amount)))).toBe(true);
      expect(d(leg.balanceBefore).eq(expected)).toBe(true);
      expected = d(leg.balanceAfter);
    }
    await assertLedgerCoherent();
  });


  it('provision 幂等：重复执行不炸不重置（IF NOT EXISTS）', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '1', refType: 'topup', refId: ref(user, 't') });
    await provision(db); // 第二次建表——幂等
    expect(sameAmount(await wallet.balance(user), '1')).toBe(true); // 数据不受影响
  });

  it('全精度：1e-18 级金额不丢不 round、不落科学计数法', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '0.000000000000000001', refType: 'topup', refId: ref(user, 'p1') });
    await wallet.credit({ userId: user, amount: '0.000000000000000002', refType: 'topup', refId: ref(user, 'p2') });
    expect(sameAmount(await wallet.balance(user), '0.000000000000000003')).toBe(true);
    const account = await accountOf(user);
    const legs = await legsOfAccount(account.id);
    for (const leg of legs) {
      expect(leg.amount.includes('e')).toBe(false);
    }
  });
});
