// wallet 多币种 currency（缺省 CNY，一币一账互不净额） → 模块化测试（源自 wallet.test.ts 拆分）

import { wallet, nextUser, ref, sameAmount, internalAccount } from './helpers';
import { RefKeyConflictError } from '../index';
import { describe, expect, it } from 'vitest';
describe('多币种 currency（缺省 CNY，一币一账互不净额）', () => {
  it('同用户双币账户隔离：USD 冻结不影响 CNY 可用；accounts 列出双币', async () => {
    const user = nextUser();
    // outside/USD 科目被并行文件共享——隔离断言用专属币种 CUX
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 'cny') });
    await wallet.credit({ userId: user, currency: 'CUX', amount: '20', refType: 'topup', refId: ref(user, 'usd') });

    await wallet.authorize({ userId: user, currency: 'CUX', amount: '15', refType: 'order', refId: ref(user, 'uh') });
    await wallet.authorize({ userId: user, amount: '100', refType: 'order', refId: ref(user, 'ch') });

    const summaries = await wallet.accounts(user);
    expect(summaries.map((s) => s.currency).toSorted()).toEqual(['CNY', 'CUX']);
    const other = summaries.find((s) => s.currency === 'CUX');
    expect(other && sameAmount(other.inFlight, '15')).toBe(true);
    expect(sameAmount(await wallet.balance(user, 'CUX'), '20')).toBe(true);
    expect(sameAmount((await internalAccount('outside', 'CUX')).balance, '-20')).toBe(true); // 外部镜像只动 CUX 腿
  });

  it('幂等键与币种无关：同键跨币种顶撞即 RefKeyConflictError', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, currency: 'USD', amount: '5', refType: 'topup', refId: ref(user, 'k') });
    await expect(
      wallet.credit({ userId: user, amount: '5', refType: 'topup', refId: ref(user, 'k') }),
    ).rejects.toBeInstanceOf(RefKeyConflictError);
  });

  it('非法币种拒绝（小写/长度错）', async () => {
    const user = nextUser();
    await expect(
      wallet.credit({ userId: user, currency: 'usd', amount: '1', refType: 'topup', refId: 'x' }),
    ).rejects.toThrow();
    await expect(
      wallet.credit({ userId: user, currency: 'USDT', amount: '1', refType: 'topup', refId: 'x' }),
    ).rejects.toThrow();
  });
});
