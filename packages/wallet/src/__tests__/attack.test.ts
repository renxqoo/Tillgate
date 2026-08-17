// wallet 攻击：注入与伪造载荷 → 模块化测试（源自 wallet.test.ts 拆分）

import { db, wallet, nextUser, ref, sameAmount } from './helpers';
import { eq } from 'drizzle-orm';
import { walletTransactions } from '../schema';
import { AuthorizationNotActiveError, CreditLimitConflictError, SettleExceedsHoldError } from '../index';
import { describe, expect, it } from 'vitest';
describe('攻击：注入与伪造载荷', () => {
  it('SQL 注入载荷在 refId：参数化存储、表完好、余额正确', async () => {
    const user = nextUser();
    const payload = "'; DROP TABLE wallet_accounts; --";
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: payload });
    await wallet.credit({ userId: user, amount: '5', refType: 'topup', refId: "' OR '1'='1" });
    // 表还在（能继续正常入账）、参数化未执行任何注入语义
    await wallet.credit({ userId: user, amount: '1', refType: 'topup', refId: ref(user, 'after') });
    expect(sameAmount(await wallet.balance(user), '16')).toBe(true);
    const [header] = await db.select().from(walletTransactions).where(eq(walletTransactions.refId, payload));
    expect(header?.kind).toBe('credit');
  });

  it('XSS/原型污染载荷在 memo 与 refId：按纯文本原样存储，不解释执行', async () => {
    const user = nextUser();
    const memo = '<script>alert(1)</script>';
    await wallet.credit({ userId: user, amount: '1', refType: 'topup', refId: '__proto__.pollution', memo });
    const [header] = await db.select().from(walletTransactions).where(eq(walletTransactions.refId, '__proto__.pollution'));
    expect(header?.memo).toBe(memo);
  });

  it('Unicode refId（中文/emoji/韩文）合法且幂等键有效', async () => {
    const user = nextUser();
    const key = '订单-🚀-결제-2026';
    const first = await wallet.credit({ userId: user, amount: '1', refType: 'topup', refId: key });
    const replay = await wallet.credit({ userId: user, amount: '1', refType: 'topup', refId: key });
    expect(replay.replayed).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
  });

  it('金额伪造重放：同键不同金额的重复调用返回首次金额，不采信新值', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '50', refType: 'topup', refId: ref(user, 'forge') });
    const tampered = await wallet.credit({ userId: user, amount: '999', refType: 'topup', refId: ref(user, 'forge') });
    expect(tampered.replayed).toBe(true);
    expect(sameAmount(tampered.amount, '50')).toBe(true); // 首次金额
    expect(sameAmount(await wallet.balance(user), '50')).toBe(true);
  });

  it('结算越权攻击：超额 settle / 0 额 settle / 释放后重结算全部拒绝且状态不变', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '10', refType: 'order', refId: ref(user, 'atk') });
    await expect(wallet.settle({ refType: 'order', refId: ref(user, 'atk'), amount: '1000000' })).rejects.toBeInstanceOf(SettleExceedsHoldError);
    await expect(wallet.settle({ refType: 'order', refId: ref(user, 'atk'), amount: '0' })).rejects.toThrow();
    await wallet.release({ refType: 'order', refId: ref(user, 'atk') });
    await expect(wallet.settle({ refType: 'order', refId: ref(user, 'atk'), amount: '10' })).rejects.toBeInstanceOf(AuthorizationNotActiveError);
    expect(sameAmount(await wallet.balance(user), '100')).toBe(true);
  });

  it('授信调整攻击：欠款期内降额击穿地板被拒，并发调整恰好一次生效', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    await wallet.setCreditLimit({ userId: user, amount: '100', refType: 'credit_line', refId: ref(user, 'g1') });
    await wallet.authorize({ userId: user, amount: '80', refType: 'order', refId: ref(user, 'o') });
    await wallet.settle({ refType: 'order', refId: ref(user, 'o'), amount: '80' });
    // 欠 70（balance = 10 − 80），降额到 50 击穿 → 拒
    await expect(
      wallet.setCreditLimit({ userId: user, amount: '50', refType: 'credit_line', refId: ref(user, 'down') }),
    ).rejects.toBeInstanceOf(CreditLimitConflictError);
    // 并发同键调整：恰好一次
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        wallet.setCreditLimit({ userId: user, amount: '70', refType: 'credit_line', refId: ref(user, 'race') }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });
});
