// wallet 退款 refund → 模块化测试（源自 wallet.test.ts 拆分）

import { db, wallet, nextUser, ref, sameAmount } from './helpers';
import { walletTransactions } from '../schema';
import { InsufficientBalanceError } from '../index';
import { describe, expect, it } from 'vitest';
describe('退款 refund', () => {
  it('余额守卫 + 独立幂等域', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 'r') });
    await expect(
      wallet.refund({ userId: user, amount: '11', refType: 'topup_refund', refId: ref(user, 'r') }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    const first = await wallet.refund({ userId: user, amount: '4', refType: 'topup_refund', refId: ref(user, 'r') });
    const replay = await wallet.refund({ userId: user, amount: '4', refType: 'topup_refund', refId: ref(user, 'r') });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(sameAmount(await wallet.balance(user), '6')).toBe(true);
    const all = await db.select().from(walletTransactions);
    expect(all.filter((h) => h.kind === 'refund' && h.refId === ref(user, 'r'))).toHaveLength(1);
  });
});
