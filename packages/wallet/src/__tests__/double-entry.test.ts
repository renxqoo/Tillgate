// wallet 复式：对手科目与守恒 → 模块化测试（源自 wallet.test.ts 拆分）

import {
  wallet,
  nextUser,
  ref,
  sameAmount,
  internalAccount,
  assertLedgerCoherent,
} from './helpers';
import { describe, expect, it } from 'vitest';
describe('复式：对手科目与守恒', () => {
  it('credit 对 outside / settle 对 platform_revenue / refund 原路退回：科目余额差值正确', async () => {
    // 专属测试币种 DIX：outside/DIX 与 revenue/DIX 科目仅本测试使用——
    // 并行测试文件共享全局科目，差值断言必须隔离币种
    const user = nextUser();
    await wallet.credit({
      userId: user,
      currency: 'DIX',
      amount: '100',
      refType: 'topup',
      refId: ref(user, 't'),
    });
    await wallet.authorize({
      userId: user,
      currency: 'DIX',
      amount: '30',
      refType: 'order',
      refId: ref(user, 'o'),
    });
    await wallet.settle({ refType: 'order', refId: ref(user, 'o'), amount: '25' });
    await wallet.refund({
      userId: user,
      currency: 'DIX',
      amount: '5',
      refType: 'topup_refund',
      refId: ref(user, 'rr'),
    });

    expect(sameAmount((await internalAccount('outside', 'DIX')).balance, '-95')).toBe(true); // −100 充值 +5 退款
    expect(sameAmount((await internalAccount('platform_revenue', 'DIX')).balance, '25')).toBe(true); // 结算即收入确认
    expect(sameAmount(await wallet.balance(user, 'DIX'), '70')).toBe(true); // 100 − 25 − 5
  });

  it('自定义对手科目：counterparty 指定营销费用科目', async () => {
    const user = nextUser();
    await wallet.credit({
      userId: user,
      amount: '8',
      refType: 'gift',
      refId: ref(user, 'g'),
      counterparty: 'marketing_expense',
    });
    // 本套件仅此测试使用该科目（每轮 deprovision 重建），绝对值即差值
    const marketing = await internalAccount('marketing_expense');
    expect(sameAmount(marketing.balance, '-8')).toBe(true);
  });

  it('全账本对账：Σ 每笔交易腿 = 0（有借必有贷）', async () => {
    await assertLedgerCoherent();
  });
});
