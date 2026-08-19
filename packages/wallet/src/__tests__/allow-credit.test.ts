/** allowCredit:false —— 现金口径守卫（订阅等禁透支场景）：
 *  锁内判定 balance − in_flight ≥ amount，授信地板不参与；
 *  拒绝抛 InsufficientCashError（code 'insufficient_cash'），与 insufficient_balance 可分流。 */
import { describe, expect, it } from 'vitest';
import { accountOf, nextUser, ref, sameAmount, wallet } from './helpers';
import { IdempotencyConflictError, InsufficientCashError } from '../index';

/** 造一个有余额与授信的用户（0 值跳过对应动作） */
async function userWith(balance: string, credit: string): Promise<number> {
  const user = nextUser();
  if (!sameAmount(balance, '0')) {
    await wallet.credit({ userId: user, amount: balance, refType: 'topup', refId: ref(user, 'fund') });
  }
  if (!sameAmount(credit, '0')) {
    await wallet.setCreditLimit({
      userId: user,
      amount: credit,
      refType: 'credit_line',
      refId: ref(user, 'cl'),
    });
  }
  return user;
}

describe('allowCredit: false（现金口径）', () => {
  it('缺省口径不变：0 余额 + 授信 100 可 authorize 60（授信地板参与）', async () => {
    const user = await userWith('0', '100');
    const result = await wallet.authorize({
      userId: user,
      amount: '60',
      refType: 'order',
      refId: ref(user, 'default'),
    });
    expect(result.status).toBe('active');
    // authorize 只冻结不动余额：授信体现在可用口径而非余额
    expect(sameAmount((await accountOf(user)).balance, '0')).toBe(true);
    expect(sameAmount((await accountOf(user)).inFlight, '60')).toBe(true);
  });

  it('allowCredit:false 拒绝同一笔：InsufficientCashError，code 可分流', async () => {
    const user = await userWith('0', '100');
    const rejection = (await wallet
      .authorize({
        userId: user,
        amount: '60',
        refType: 'order',
        refId: ref(user, 'cash'),
        allowCredit: false,
      })
      .catch((error) => error)) as InsufficientCashError;
    expect(rejection).toBeInstanceOf(InsufficientCashError);
    expect(rejection.code).toBe('insufficient_cash');
  });

  it('现金足够时 allowCredit:false 成功', async () => {
    const user = await userWith('50', '100');
    const result = await wallet.authorize({
      userId: user,
      amount: '50',
      refType: 'order',
      refId: ref(user, 'cash-ok'),
      allowCredit: false,
    });
    expect(result.status).toBe('active');
    expect(sameAmount((await accountOf(user)).inFlight, '50')).toBe(true);
  });

  it('现金口径扣除在途：balance 50 − inFlight 30 = 20 → 25 拒 / 20 过', async () => {
    const user = await userWith('50', '100');
    await wallet.authorize({ userId: user, amount: '30', refType: 'order', refId: ref(user, 'inflight') });
    await expect(
      wallet.authorize({
        userId: user,
        amount: '25',
        refType: 'order',
        refId: ref(user, 'cash-25'),
        allowCredit: false,
      }),
    ).rejects.toBeInstanceOf(InsufficientCashError);
    const ok = await wallet.authorize({
      userId: user,
      amount: '20',
      refType: 'order',
      refId: ref(user, 'cash-20'),
      allowCredit: false,
    });
    expect(ok.status).toBe('active');
  });

  it('transfer from 用户账户同口径：现金不足拒，充足过', async () => {
    const user = await userWith('10', '100');
    const peer = nextUser();
    await wallet.credit({ userId: peer, amount: '1', refType: 'topup', refId: ref(peer, 'fund') });
    await expect(
      wallet.transfer({
        from: { userId: user },
        to: { userId: peer },
        amount: '50',
        refType: 'p2p',
        refId: ref(user, 't-reject'),
        allowCredit: false,
      }),
    ).rejects.toBeInstanceOf(InsufficientCashError);
    const ok = await wallet.transfer({
      from: { userId: user },
      to: { userId: peer },
      amount: '10',
      refType: 'p2p',
      refId: ref(user, 't-ok'),
      allowCredit: false,
    });
    expect(ok.replayed).toBe(false);
    expect(sameAmount((await accountOf(user)).balance, '0')).toBe(true);
  });

  it('allowCredit 参与命令指纹：同键异策略 = IdempotencyConflictError', async () => {
    const user = await userWith('50', '100');
    const key = ref(user, 'fp');
    await wallet.authorize({ userId: user, amount: '10', refType: 'order', refId: key });
    await expect(
      wallet.authorize({
        userId: user,
        amount: '10',
        refType: 'order',
        refId: key,
        allowCredit: false,
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });
});
