// 两阶段扣费之 authorize：冻结/预占——可用口径与幂等

import { wallet, nextUser, ref, sameAmount, accountOf } from './helpers';
import { InsufficientBalanceError } from '../index';
import { describe, expect, it } from 'vitest';
describe('authorize：冻结/预占——可用口径与幂等', () => {
  it('可用口径扣减在途：第二笔冻结被拒且无状态残留', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '8', refType: 'order', refId: ref(user, 'a') });
    await expect(
      wallet.authorize({ userId: user, amount: '3', refType: 'order', refId: ref(user, 'b') }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    const account = await accountOf(user);
    expect(sameAmount(account.inFlight, '8')).toBe(true);
    expect(sameAmount(account.balance, '10')).toBe(true);
  });

  it('authorize 幂等：同键重放返回既有冻结，在途不重复累计', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    const first = await wallet.authorize({
      userId: user,
      amount: '20',
      refType: 'order',
      refId: ref(user, 'idem'),
    });
    const replay = await wallet.authorize({
      userId: user,
      amount: '20',
      refType: 'order',
      refId: ref(user, 'idem'),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.authorizationId).toBe(first.authorizationId);
    const account = await accountOf(user);
    expect(sameAmount(account.inFlight, '20')).toBe(true);
  });
});
