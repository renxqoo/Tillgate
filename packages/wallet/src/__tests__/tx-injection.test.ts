/** tx 注入契约：动词可加入调用方事务——锁/守卫/幂等随 tx 走，与调用方业务写同生共死。
 *  这是「补充授权结算」与订阅购买原子性的内核前提。 */
import { describe, expect, it } from 'vitest';
import { accountOf, db, nextUser, ref, sameAmount, wallet } from './helpers';
import { InsufficientBalanceError } from '../index';

describe('tx 注入：业务-资金原子性', () => {
  it('调用方回滚 → 动词的资金变动一并消失（动词不得自行提交）', async () => {
    const user = nextUser();
    await expect(
      db.transaction(async (tx) => {
        await wallet.credit({
          userId: user,
          amount: '10',
          refType: 'topup',
          refId: ref(user, 'rollback'),
          tx,
        });
        throw new Error('caller aborts');
      }),
    ).rejects.toThrow('caller aborts');
    // 账户都不应存在：账户创建与过账全部随调用方事务回滚
    await expect(accountOf(user)).rejects.toThrow('missing');
  });

  it('同事务守卫读到前序未提交变动：余额守卫在注入事务内生效', async () => {
    const user = nextUser();
    await expect(
      db.transaction(async (tx) => {
        await wallet.credit({
          userId: user,
          amount: '5',
          refType: 'topup',
          refId: ref(user, 'fund'),
          tx,
        });
        await wallet.authorize({
          userId: user,
          amount: '10',
          refType: 'order',
          refId: ref(user, 'hold'),
          tx,
        });
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    await expect(accountOf(user)).rejects.toThrow('missing');
  });

  it('注入事务内同键重复调用走幂等快速路径（读到自身未提交交易）', async () => {
    const user = nextUser();
    const key = ref(user, 'dup');
    await db.transaction(async (tx) => {
      const first = await wallet.credit({
        userId: user,
        amount: '3',
        refType: 'topup',
        refId: key,
        tx,
      });
      const second = await wallet.credit({
        userId: user,
        amount: '3',
        refType: 'topup',
        refId: key,
        tx,
      });
      expect(first.replayed).toBe(false);
      expect(second.replayed).toBe(true);
      expect(second.transactionId).toBe(first.transactionId);
    });
    expect(sameAmount(await wallet.balance(user), '3')).toBe(true);
  });

  it('补充授权结算（实际 > 预留）：单事务内三步原子完成', async () => {
    const user = nextUser();
    const holdKey = ref(user, 'over');
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 'fund') });
    await wallet.authorize({ userId: user, amount: '10', refType: 'order', refId: holdKey });
    await db.transaction(async (tx) => {
      await wallet.authorize({
        userId: user,
        amount: '5',
        refType: 'order',
        refId: `${holdKey}#over`,
        tx,
      });
      await wallet.settle({ refType: 'order', refId: `${holdKey}#over`, amount: '5', tx });
      await wallet.settle({ refType: 'order', refId: holdKey, amount: '10', tx });
    });
    const account = await accountOf(user);
    expect(sameAmount(account.balance, '85')).toBe(true);
    expect(sameAmount(account.inFlight, '0')).toBe(true);
  });

  it('补充结算中途失败：整个组合回滚，原冻结保持 active 余额不动', async () => {
    const user = nextUser();
    const holdKey = ref(user, 'abort');
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 'fund') });
    await wallet.authorize({ userId: user, amount: '10', refType: 'order', refId: holdKey });
    await expect(
      db.transaction(async (tx) => {
        await wallet.authorize({
          userId: user,
          amount: '5',
          refType: 'order',
          refId: `${holdKey}#over`,
          tx,
        });
        await wallet.settle({ refType: 'order', refId: `${holdKey}#over`, amount: '5', tx });
        throw new Error('settle original aborted');
      }),
    ).rejects.toThrow('settle original aborted');
    const account = await accountOf(user);
    expect(sameAmount(account.balance, '100')).toBe(true);
    expect(sameAmount(account.inFlight, '10')).toBe(true);
  });

  it('settle 注入事务回滚后原冻结仍 active，可再次结算', async () => {
    const user = nextUser();
    const key = ref(user, 'settle-rollback');
    await wallet.credit({ userId: user, amount: '20', refType: 'topup', refId: ref(user, 'fund') });
    await wallet.authorize({ userId: user, amount: '8', refType: 'order', refId: key });
    await expect(
      db.transaction(async (tx) => {
        await wallet.settle({ refType: 'order', refId: key, amount: '8', tx });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const settled = await wallet.settle({ refType: 'order', refId: key, amount: '6' });
    expect(settled.replayed).toBe(false);
    expect(sameAmount((await accountOf(user)).balance, '14')).toBe(true);
  });

  it('release 注入事务回滚后在途不归还，冻结单未被释放', async () => {
    const user = nextUser();
    const key = ref(user, 'release-rollback');
    await wallet.credit({ userId: user, amount: '20', refType: 'topup', refId: ref(user, 'fund') });
    await wallet.authorize({ userId: user, amount: '8', refType: 'order', refId: key });
    await expect(
      db.transaction(async (tx) => {
        await wallet.release({ refType: 'order', refId: key, reason: 'retry', tx });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const account = await accountOf(user);
    expect(sameAmount(account.inFlight, '8')).toBe(true);
    // 冻结单仍 active：后续结算可用
    const settled = await wallet.settle({ refType: 'order', refId: key, amount: '8' });
    expect(settled.replayed).toBe(false);
  });
});
