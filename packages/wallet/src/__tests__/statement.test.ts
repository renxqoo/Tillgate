/** statement 流水查询：分页正确性、币种隔离、种类过滤、对手方信息、只读零副作用 */
import { describe, expect, it } from 'vitest';
import { db, nextUser, ref, sameAmount, wallet } from './helpers';
import { walletAccounts } from '../schema';
import { eq } from 'drizzle-orm';

describe('statement 流水查询', () => {
  it('按时间倒序返回本方腿：金额有符号、balanceAfter 逐条衔接成余额历史', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't1') });
    await wallet.authorize({
      userId: user,
      amount: '30',
      refType: 'order',
      refId: ref(user, 'o1'),
    });
    await wallet.settle({ refType: 'order', refId: ref(user, 'o1'), amount: '25' });
    await wallet.refund({
      userId: user,
      amount: '5',
      refType: 'topup_refund',
      refId: ref(user, 'r1'),
    });

    const { items, nextCursor } = await wallet.statement({ userId: user });
    expect(nextCursor).toBeNull();
    expect(items.map((i) => i.kind)).toEqual(['refund', 'settle', 'credit']); // newest-first，冻结/释放不落交易
    expect(sameAmount(items[0]!.amount, '-5')).toBe(true);
    expect(sameAmount(items[0]!.balanceAfter, '70')).toBe(true); // 100−25−5
    expect(sameAmount(items[1]!.amount, '-25')).toBe(true);
    expect(sameAmount(items[2]!.amount, '100')).toBe(true);
    // 对手方：充值的对手是外部科目
    expect(items[2]!.counterparties).toEqual([{ kind: 'internal', userId: null, code: 'outside' }]);
  });

  it('游标分页：limit 翻页不重不漏直到 nextCursor=null', async () => {
    const user = nextUser();
    for (let i = 0; i < 5; i += 1) {
      await wallet.credit({
        userId: user,
        amount: '1',
        refType: 'topup',
        refId: `${ref(user, 'p')}-${i}`,
      });
    }
    const seen: number[] = [];
    let cursor: number | undefined;
    for (;;) {
      const page = await wallet.statement({ userId: user, limit: 2, before: cursor });
      seen.push(...page.items.map((i) => i.transactionId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5); // 不重
    expect(seen.toSorted((a, b) => b - a)).toEqual(seen); // 不漏且降序
  });

  it('kinds 过滤与 currency 隔离', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 'c') });
    await wallet.credit({
      userId: user,
      currency: 'USD',
      amount: '5',
      refType: 'topup',
      refId: ref(user, 'u'),
    });
    await wallet.authorize({ userId: user, amount: '4', refType: 'order', refId: ref(user, 'o') });
    await wallet.settle({ refType: 'order', refId: ref(user, 'o'), amount: '4' });

    const onlyCredit = await wallet.statement({ userId: user, kinds: ['credit'] });
    expect(onlyCredit.items.map((i) => i.kind)).toEqual(['credit']); // USD 腿不在 CNY 账单

    const usd = await wallet.statement({ userId: user, currency: 'USD' });
    expect(usd.items).toHaveLength(1);
    expect(usd.items[0]!.currency).toBe('USD');
  });

  it('转账双方各自账单互为对手方；无户用户返回空且不建户（只读零副作用）', async () => {
    const a = nextUser();
    const b = nextUser();
    const fresh = nextUser();
    await wallet.credit({
      userId: a,
      amount: '10',
      currency: 'ZBF',
      refType: 'topup',
      refId: ref(a, 't'),
    });
    await wallet.transfer({
      from: { userId: a, currency: 'ZBF' },
      to: { userId: b, currency: 'ZBF' },
      amount: '3',
      refType: 'p2p',
      refId: ref(a, 'tv'),
    });

    const from = await wallet.statement({ userId: a, currency: 'ZBF' });
    expect(from.items[0]!.amount).toBe('-3');
    expect(from.items[0]!.counterparties).toEqual([{ kind: 'user', userId: b, code: null }]);

    const to = await wallet.statement({ userId: b, currency: 'ZBF' });
    expect(to.items[0]!.amount).toBe('3');
    expect(to.items[0]!.counterparties).toEqual([{ kind: 'user', userId: a, code: null }]);

    const empty = await wallet.statement({ userId: fresh });
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toBeNull();
    expect(
      await db.select().from(walletAccounts).where(eq(walletAccounts.userId, fresh)),
    ).toHaveLength(0);
  });

  it('入参校验：limit 越界 / 非法 kinds / 非法币种拒绝', async () => {
    const user = nextUser();
    await expect(wallet.statement({ userId: user, limit: 0 })).rejects.toThrow();
    await expect(wallet.statement({ userId: user, limit: 101 })).rejects.toThrow();
    await expect(wallet.statement({ userId: user, kinds: [] })).rejects.toThrow();
    await expect(wallet.statement({ userId: user, kinds: ['hack' as 'credit'] })).rejects.toThrow();
    await expect(wallet.statement({ userId: user, currency: 'usd' })).rejects.toThrow();
  });
});
