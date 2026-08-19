// wallet 授信地板 credit_limit（缺省 0 = 纯预付） → 模块化测试（源自 wallet.test.ts 拆分）

import { wallet, nextUser, ref, sameAmount } from './helpers';
import { CreditLimitConflictError, InsufficientBalanceError } from '../index';
import { describe, expect, it } from 'vitest';
describe('授信地板 credit_limit（缺省 0 = 纯预付）', () => {
  it('授信扩大可用口径，消费可至负余额但不击穿地板', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    await expect(
      wallet.authorize({ userId: user, amount: '11', refType: 'order', refId: ref(user, 'x') }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    await wallet.setCreditLimit({
      userId: user,
      amount: '50',
      refType: 'credit_line',
      refId: ref(user, 'grant'),
    });
    await wallet.authorize({
      userId: user,
      amount: '55',
      refType: 'order',
      refId: ref(user, 'big'),
    });
    await expect(
      wallet.authorize({ userId: user, amount: '6', refType: 'order', refId: ref(user, 'over') }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);

    await wallet.settle({ refType: 'order', refId: ref(user, 'big'), amount: '35' });
    expect(sameAmount(await wallet.balance(user), '-25')).toBe(true);
  });

  it('退款受地板守卫：可用授信额度内可退，击穿即拒', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    await wallet.setCreditLimit({
      userId: user,
      amount: '50',
      refType: 'credit_line',
      refId: ref(user, 'grant'),
    });
    await wallet.refund({
      userId: user,
      amount: '30',
      refType: 'topup_refund',
      refId: ref(user, 'r1'),
    });
    expect(sameAmount(await wallet.balance(user), '-20')).toBe(true);
    await expect(
      wallet.refund({
        userId: user,
        amount: '35',
        refType: 'topup_refund',
        refId: ref(user, 'r2'),
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it('setCreditLimit 幂等；降额低于当前欠款拒绝；零额审计腿不破坏链', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    const first = await wallet.setCreditLimit({
      userId: user,
      amount: '50',
      refType: 'credit_line',
      refId: ref(user, 'g'),
    });
    const replay = await wallet.setCreditLimit({
      userId: user,
      amount: '50',
      refType: 'credit_line',
      refId: ref(user, 'g'),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(sameAmount(replay.creditLimit, '50')).toBe(true);

    await wallet.authorize({ userId: user, amount: '30', refType: 'order', refId: ref(user, 'o') });
    await wallet.settle({ refType: 'order', refId: ref(user, 'o'), amount: '30' });
    expect(sameAmount(await wallet.balance(user), '-20')).toBe(true);
    await expect(
      wallet.setCreditLimit({
        userId: user,
        amount: '10',
        refType: 'credit_line',
        refId: ref(user, 'down'),
      }),
    ).rejects.toBeInstanceOf(CreditLimitConflictError);
    const lowered = await wallet.setCreditLimit({
      userId: user,
      amount: '20',
      refType: 'credit_line',
      refId: ref(user, 'ok'),
    });
    expect(sameAmount(lowered.creditLimit, '20')).toBe(true);
  });
});
