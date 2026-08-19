// wallet 冻结 freeze（风控） → 模块化测试（源自 wallet.test.ts 拆分）

import { wallet, nextUser, ref, sameAmount } from './helpers';
import { FrozenAccountError } from '../index';
import { describe, expect, it } from 'vitest';
describe('冻结 freeze（风控）', () => {
  it('冻结后拒绝一切资金变动，解冻恢复；查询不受限', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    const frozen = await wallet.freeze({
      target: { userId: user },
      frozen: true,
      refType: 'risk_control',
      refId: ref(user, 'f1'),
    });
    expect(frozen.frozen).toBe(true);

    await expect(
      wallet.credit({ userId: user, amount: '1', refType: 'topup', refId: ref(user, 'blocked') }),
    ).rejects.toBeInstanceOf(FrozenAccountError);
    await expect(
      wallet.authorize({
        userId: user,
        amount: '1',
        refType: 'order',
        refId: ref(user, 'blocked'),
      }),
    ).rejects.toBeInstanceOf(FrozenAccountError);
    await expect(
      wallet.refund({
        userId: user,
        amount: '1',
        refType: 'topup_refund',
        refId: ref(user, 'blocked'),
      }),
    ).rejects.toBeInstanceOf(FrozenAccountError);
    await expect(
      wallet.transfer({
        from: { userId: user },
        to: { code: 'platform_revenue' },
        amount: '1',
        refType: 'p2p',
        refId: ref(user, 'blocked'),
      }),
    ).rejects.toBeInstanceOf(FrozenAccountError);
    expect(sameAmount(await wallet.balance(user), '100')).toBe(true); // 查询不受限

    await wallet.freeze({
      target: { userId: user },
      frozen: false,
      refType: 'risk_control',
      refId: ref(user, 'f2'),
    });
    await wallet.credit({ userId: user, amount: '1', refType: 'topup', refId: ref(user, 'after') });
    expect(sameAmount(await wallet.balance(user), '101')).toBe(true);
  });

  it('冻结内部科目同样生效', async () => {
    await wallet.freeze({
      target: { code: 'outside', currency: 'USD' },
      frozen: true,
      refType: 'risk_control',
      refId: `freeze-outside-usd-${Date.now()}`,
    });
    await expect(
      wallet.credit({
        userId: nextUser(),
        currency: 'USD',
        amount: '1',
        refType: 'topup',
        refId: `usd-blocked-${Date.now()}`,
      }),
    ).rejects.toBeInstanceOf(FrozenAccountError);
    await wallet.freeze({
      target: { code: 'outside', currency: 'USD' },
      frozen: false,
      refType: 'risk_control',
      refId: `unfreeze-outside-usd-${Date.now()}`,
    });
  });
});
