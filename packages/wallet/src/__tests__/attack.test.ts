// wallet 攻击：注入与伪造载荷 → 模块化测试（源自 wallet.test.ts 拆分）

import { db, wallet, nextUser, ref, sameAmount } from './helpers';
import { eq } from 'drizzle-orm';
import { walletTransactions } from '../schema';
import {
  AuthorizationNotActiveError,
  CreditLimitConflictError,
  SettleExceedsHoldError,
} from '../index';
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
    const [header] = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.refId, payload));
    expect(header?.kind).toBe('credit');
  });

  it('XSS/原型污染载荷在 memo 与 refId：按纯文本原样存储，不解释执行', async () => {
    const user = nextUser();
    const memo = '<script>alert(1)</script>';
    await wallet.credit({
      userId: user,
      amount: '1',
      refType: 'topup',
      refId: '__proto__.pollution',
      memo,
    });
    const [header] = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.refId, '__proto__.pollution'));
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

  it('金额伪造重放：同键不同金额必须报告幂等冲突', async () => {
    const user = nextUser();
    await wallet.credit({
      userId: user,
      amount: '50',
      refType: 'topup',
      refId: ref(user, 'forge'),
    });
    await expect(
      wallet.credit({
        userId: user,
        amount: '999',
        refType: 'topup',
        refId: ref(user, 'forge'),
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    expect(sameAmount(await wallet.balance(user), '50')).toBe(true);
  });

  it('所有资金命令同键异参都拒绝，不静默复用首次结果', async () => {
    const user = nextUser();
    const receiver = nextUser();
    await wallet.credit({ userId: user, amount: '30', refType: 'topup', refId: ref(user, 'fund') });

    const holdKey = ref(user, 'fingerprint-hold');
    await wallet.authorize({ userId: user, amount: '10', refType: 'order', refId: holdKey });
    await expect(
      wallet.authorize({ userId: user, amount: '9', refType: 'order', refId: holdKey }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });

    await wallet.settle({ refType: 'order', refId: holdKey, amount: '8' });
    await expect(
      wallet.settle({ refType: 'order', refId: holdKey, amount: '7' }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });

    const refundKey = ref(user, 'fingerprint-refund');
    await wallet.refund({
      userId: user,
      amount: '1',
      refType: 'topup_refund',
      refId: refundKey,
    });
    await expect(
      wallet.refund({
        userId: user,
        amount: '2',
        refType: 'topup_refund',
        refId: refundKey,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });

    const transferKey = ref(user, 'fingerprint-transfer');
    await wallet.transfer({
      from: { userId: user },
      to: { userId: receiver },
      amount: '1',
      refType: 'p2p',
      refId: transferKey,
    });
    await expect(
      wallet.transfer({
        from: { userId: user },
        to: { userId: receiver },
        amount: '2',
        refType: 'p2p',
        refId: transferKey,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });

    const limitKey = ref(receiver, 'fingerprint-limit');
    await wallet.setCreditLimit({
      userId: receiver,
      amount: '5',
      refType: 'credit_line',
      refId: limitKey,
    });
    await expect(
      wallet.setCreditLimit({
        userId: receiver,
        amount: '6',
        refType: 'credit_line',
        refId: limitKey,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });

    const freezeKey = ref(receiver, 'fingerprint-freeze');
    await wallet.freeze({
      target: { userId: receiver },
      frozen: true,
      refType: 'risk_control',
      refId: freezeKey,
    });
    await expect(
      wallet.freeze({
        target: { userId: receiver },
        frozen: false,
        refType: 'risk_control',
        refId: freezeKey,
      }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });

    const releaseUser = nextUser();
    await wallet.credit({
      userId: releaseUser,
      amount: '3',
      refType: 'topup',
      refId: ref(releaseUser, 'fund'),
    });
    const releaseKey = ref(releaseUser, 'fingerprint-release');
    await wallet.authorize({
      userId: releaseUser,
      amount: '1',
      refType: 'order',
      refId: releaseKey,
    });
    await wallet.release({ refType: 'order', refId: releaseKey, reason: 'cancelled' });
    await expect(
      wallet.release({ refType: 'order', refId: releaseKey, reason: 'fraud' }),
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
  });

  it('结算越权攻击：超额 settle / 0 额 settle / 释放后重结算全部拒绝且状态不变', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({
      userId: user,
      amount: '10',
      refType: 'order',
      refId: ref(user, 'atk'),
    });
    await expect(
      wallet.settle({ refType: 'order', refId: ref(user, 'atk'), amount: '1000000' }),
    ).rejects.toBeInstanceOf(SettleExceedsHoldError);
    await expect(
      wallet.settle({ refType: 'order', refId: ref(user, 'atk'), amount: '0' }),
    ).rejects.toThrow();
    await wallet.release({ refType: 'order', refId: ref(user, 'atk') });
    await expect(
      wallet.settle({ refType: 'order', refId: ref(user, 'atk'), amount: '10' }),
    ).rejects.toBeInstanceOf(AuthorizationNotActiveError);
    expect(sameAmount(await wallet.balance(user), '100')).toBe(true);
  });

  it('授信调整攻击：欠款期内降额击穿地板被拒，并发调整恰好一次生效', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    await wallet.setCreditLimit({
      userId: user,
      amount: '100',
      refType: 'credit_line',
      refId: ref(user, 'g1'),
    });
    await wallet.authorize({ userId: user, amount: '80', refType: 'order', refId: ref(user, 'o') });
    await wallet.settle({ refType: 'order', refId: ref(user, 'o'), amount: '80' });
    // 欠 70（balance = 10 − 80），降额到 50 击穿 → 拒
    await expect(
      wallet.setCreditLimit({
        userId: user,
        amount: '50',
        refType: 'credit_line',
        refId: ref(user, 'down'),
      }),
    ).rejects.toBeInstanceOf(CreditLimitConflictError);
    // 并发同键调整：恰好一次
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        wallet.setCreditLimit({
          userId: user,
          amount: '70',
          refType: 'credit_line',
          refId: ref(user, 'race'),
        }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  });
});
