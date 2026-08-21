// wallet 原子转账 transfer → 模块化测试（源自 wallet.test.ts 拆分）

import { wallet, nextUser, ref, sameAmount, internalAccount } from './helpers';
import { CurrencyMismatchError, InsufficientBalanceError } from '../index';
import { describe, expect, it } from 'vitest';
describe('原子转账 transfer', () => {
  it('用户 ↔ 用户：双腿守恒，双方余额正确', async () => {
    const from = nextUser();
    const to = nextUser();
    await wallet.credit({ userId: from, amount: '100', refType: 'topup', refId: ref(from, 't') });
    const result = await wallet.transfer({
      from: { userId: from },
      to: { userId: to },
      amount: '30',
      refType: 'p2p',
      refId: ref(from, 'tv1'),
    });
    expect(sameAmount(result.fromBalanceAfter, '70')).toBe(true);
    expect(sameAmount(result.toBalanceAfter, '30')).toBe(true);
    expect(sameAmount(await wallet.balance(to), '30')).toBe(true);
  });

  it('电商分账：订单结算后 一笔转账拆平台佣金与商家入账', async () => {
    // 专属测试币种 TSF：revenue/TSF 科目仅本测试使用（并行文件共享全局科目）
    const buyer = nextUser();
    const merchant = nextUser();
    await wallet.credit({
      userId: buyer,
      currency: 'TSF',
      amount: '100',
      refType: 'topup',
      refId: ref(buyer, 't'),
    });
    await wallet.authorize({
      userId: buyer,
      currency: 'TSF',
      amount: '90',
      refType: 'order',
      refId: ref(buyer, 'od'),
    });
    // 买家结算 90（进入 platform_revenue），再分账：佣金留收入，80 转商家
    await wallet.settle({ refType: 'order', refId: ref(buyer, 'od'), amount: '90' });
    await wallet.transfer({
      from: { code: 'platform_revenue', currency: 'TSF' },
      to: { userId: merchant, currency: 'TSF' },
      amount: '80',
      refType: 'payout',
      refId: ref(buyer, 'split'),
    });
    expect(sameAmount(await wallet.balance(merchant, 'TSF'), '80')).toBe(true);
    expect(sameAmount((await internalAccount('platform_revenue', 'TSF')).balance, '10')).toBe(true); // 佣金 = 90 − 80
  });

  it('同账户转账拒绝；跨币种拒绝（换汇 = 两笔独立转账）', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    await wallet.credit({
      userId: user,
      currency: 'USD',
      amount: '5',
      refType: 'topup',
      refId: ref(user, 'tu'),
    });
    await expect(
      wallet.transfer({
        from: { userId: user },
        to: { userId: user },
        amount: '1',
        refType: 'p2p',
        refId: ref(user, 'same'),
      }),
    ).rejects.toThrow();
    await expect(
      wallet.transfer({
        from: { userId: user },
        to: { userId: user, currency: 'USD' },
        amount: '1',
        refType: 'exchange',
        refId: ref(user, 'xm'),
      }),
    ).rejects.toBeInstanceOf(CurrencyMismatchError);
  });

  it('出账守卫：地板内可转、击穿即拒；重放幂等', async () => {
    const from = nextUser();
    const to = nextUser();
    await wallet.credit({ userId: from, amount: '10', refType: 'topup', refId: ref(from, 't') });
    await expect(
      wallet.transfer({
        from: { userId: from },
        to: { userId: to },
        amount: '11',
        refType: 'p2p',
        refId: ref(from, 'x'),
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    const first = await wallet.transfer({
      from: { userId: from },
      to: { userId: to },
      amount: '10',
      refType: 'p2p',
      refId: ref(from, 'ok'),
    });
    const replay = await wallet.transfer({
      from: { userId: from },
      to: { userId: to },
      amount: '10',
      refType: 'p2p',
      refId: ref(from, 'ok'),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(sameAmount(await wallet.balance(to), '10')).toBe(true);
  });
});
