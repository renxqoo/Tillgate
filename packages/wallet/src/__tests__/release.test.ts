// 两阶段扣费之 release / releaseExpired：释放、状态机互斥与超时扫描

import { db, wallet, walletMaintenance, nextUser, ref, sameAmount, accountOf } from './helpers';
import { eq, inArray } from 'drizzle-orm';
import { walletAuthorizations, walletTransactions } from '../schema';
import { AuthorizationNotActiveError } from '../index';
import { describe, expect, it } from 'vitest';
describe('release / releaseExpired：释放、状态机互斥与超时扫描', () => {
  it('释放：余额不动、在途归还；重复释放为幂等 no-op；不落交易（审计在单据）', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({
      userId: user,
      amount: '70',
      refType: 'order',
      refId: ref(user, 'rel'),
    });
    const scoped = await db
      .select()
      .from(walletTransactions)
      .where(inArray(walletTransactions.refId, [ref(user, 't'), ref(user, 'rel')]));
    const before = scoped.length;
    const released = await wallet.release({
      refType: 'order',
      refId: ref(user, 'rel'),
      reason: 'user_cancel',
    });
    expect(released.replayed).toBe(false);
    expect(sameAmount(await wallet.balance(user), '100')).toBe(true);
    const replay = await wallet.release({
      refType: 'order',
      refId: ref(user, 'rel'),
      reason: 'user_cancel',
    });
    expect(replay.replayed).toBe(true);
    const account = await accountOf(user);
    expect(sameAmount(account.inFlight, '0')).toBe(true);
    const afterScoped = await db
      .select()
      .from(walletTransactions)
      .where(inArray(walletTransactions.refId, [ref(user, 't'), ref(user, 'rel')]));
    expect(afterScoped.length).toBe(before); // 释放不产生交易（复式下零额噪声行取消；作用域计数防并行文件干扰）
  });

  it('已释放的冻结不可结算（状态机互斥）', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({
      userId: user,
      amount: '10',
      refType: 'order',
      refId: ref(user, 'dead'),
    });
    await wallet.release({ refType: 'order', refId: ref(user, 'dead') });
    await expect(
      wallet.settle({ refType: 'order', refId: ref(user, 'dead'), amount: '10' }),
    ).rejects.toBeInstanceOf(AuthorizationNotActiveError);
    expect(sameAmount(await wallet.balance(user), '100')).toBe(true);
  });

  it('releaseExpired：到点冻结转 expired 并归还在途；未到期不动', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({
      userId: user,
      amount: '30',
      refType: 'order',
      refId: ref(user, 'stale'),
      expiresAt: new Date(Date.now() - 1_000),
    });
    await wallet.authorize({
      userId: user,
      amount: '20',
      refType: 'order',
      refId: ref(user, 'fresh'),
      expiresAt: new Date(Date.now() + 60_000),
    });
    // 过期单全局可见：并行文件的扫描器可能先抢到——断言自有单据终态而非计数
    await walletMaintenance.releaseExpired();
    const [stale] = await db
      .select()
      .from(walletAuthorizations)
      .where(eq(walletAuthorizations.refId, ref(user, 'stale')));
    expect(stale?.status).toBe('expired');
    const account = await accountOf(user);
    expect(sameAmount(account.inFlight, '20')).toBe(true);
    expect(sameAmount(await wallet.balance(user), '100')).toBe(true);
  });
});
