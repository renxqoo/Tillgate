// wallet 安全：冻结边界与完整性 → 模块化测试（源自 wallet.test.ts 拆分）

import { db, wallet, nextUser, ref, sameAmount, accountOf, assertLedgerCoherent } from './helpers';
import { eq } from 'drizzle-orm';
import { walletAuthorizations, walletTransactions } from '../schema';
import { FrozenAccountError } from '../index';
import { describe, expect, it } from 'vitest';
describe('安全：冻结边界与完整性', () => {
  it('冻结账户上的 active 冻结单：settle 被拒且单据保持 active（解冻后可结算）', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '30', refType: 'order', refId: ref(user, 'o') });
    await wallet.freeze({ target: { userId: user }, frozen: true, refType: 'risk_control', refId: ref(user, 'f') });
    await expect(
      wallet.settle({ refType: 'order', refId: ref(user, 'o'), amount: '30' }),
    ).rejects.toBeInstanceOf(FrozenAccountError);
    const [auth] = await db.select().from(walletAuthorizations).where(eq(walletAuthorizations.refId, ref(user, 'o')));
    expect(auth?.status).toBe('active'); // CAS 也一并回滚

    await wallet.freeze({ target: { userId: user }, frozen: false, refType: 'risk_control', refId: ref(user, 'uf') });
    await wallet.settle({ refType: 'order', refId: ref(user, 'o'), amount: '30' });
    expect(sameAmount(await wallet.balance(user), '70')).toBe(true);
  });

  it('冻结账户的过期冻结单：releaseExpired 跳过不中断，解冻后下轮释放', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({
      userId: user, amount: '20', refType: 'order', refId: ref(user, 'stale'),
      expiresAt: new Date(Date.now() - 1_000),
    });
    await wallet.freeze({ target: { userId: user }, frozen: true, refType: 'risk_control', refId: ref(user, 'f') });
    // 不炸；自有单据受冻结保护保持 active（计数器不断言——并行文件的扫描器会互相抢终态）
    await wallet.releaseExpired(new Date());
    const [auth] = await db.select().from(walletAuthorizations).where(eq(walletAuthorizations.refId, ref(user, 'stale')));
    expect(auth?.status).toBe('active');

    await wallet.freeze({ target: { userId: user }, frozen: false, refType: 'risk_control', refId: ref(user, 'uf') });
    await wallet.releaseExpired(new Date());
    const [after] = await db.select().from(walletAuthorizations).where(eq(walletAuthorizations.refId, ref(user, 'stale')));
    expect(after?.status).toBe('expired'); // 自有单据必达终态（无论哪个文件的扫描器抢到）
    const account = await accountOf(user);
    expect(sameAmount(account.inFlight, '0')).toBe(true);
  });

  it('非法输入不产生任何状态残留（目标用户作用域零账户零交易）', async () => {
    const user = nextUser(); // 全库计数会被并行测试文件干扰——按作用域断言
    const attacks = [
      () => wallet.credit({ userId: user, amount: '-1', refType: 'topup', refId: 'x' }),
      () => wallet.credit({ userId: user, amount: '1', refType: 'TOPUP', refId: 'x' }),
      () => wallet.credit({ userId: 0, amount: '1', refType: 'topup', refId: 'x' }),
      () => wallet.settle({ refType: 'topup', refId: 'x', amount: '0' }),
      () => wallet.transfer({ from: { userId: user }, to: {}, amount: '1', refType: 'p2p', refId: 'x' }),
      () => wallet.transfer({ from: { userId: user, code: 'a' }, to: { userId: user }, amount: '1', refType: 'p2p', refId: 'x' }),
    ];
    for (const attack of attacks) {
      await expect(attack()).rejects.toThrow();
    }
    await expect(accountOf(user)).rejects.toThrow();       // 无账户
    expect(sameAmount(await wallet.balance(user), '0')).toBe(true);
    const txs = await db.select().from(walletTransactions).where(eq(walletTransactions.refType, 'p2p'));
    expect(txs.filter((t) => t.refId === 'x')).toHaveLength(0); // 无交易
  });

  it('全套攻击/并发打完：全账本仍自洽（Σ=0 / 链恒等 / 余额=代数和）', async () => {
    await assertLedgerCoherent();
  });
});
