/** 生产发布契约：这些测试先于修复落地，覆盖资金预占、稳定重放与安全边界。 */
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as publicApi from '../index';
import * as migrationsApi from '../migrations';
import { RefKeyConflictError } from '../errors';
import { walletAccounts, walletLegs, walletTransactions } from '../schema';
import { accountOf, db, nextUser, ref, sameAmount, wallet } from './helpers';

describe('生产资金不变量', () => {
  it('expiresAt 是结算权威截止时间，worker 延迟不能允许过期后 settle', async () => {
    const user = nextUser();
    await wallet.credit({
      userId: user,
      amount: '10',
      refType: 'topup',
      refId: ref(user, 'fund-expiry'),
    });
    await wallet.authorize({
      userId: user,
      amount: '5',
      refType: 'order',
      refId: ref(user, 'expired-before-settle'),
      expiresAt: new Date(Date.now() - 1_000),
    });
    await expect(
      wallet.settle({ refType: 'order', refId: ref(user, 'expired-before-settle'), amount: '5' }),
    ).rejects.toMatchObject({ code: 'authorization_not_active', status: 'expired' });
    expect(sameAmount(await wallet.balance(user), '10')).toBe(true);
  });

  it('active 冻结占用的额度不能再被 transfer 或 refund 花掉', async () => {
    const user = nextUser();
    const receiver = nextUser();
    await wallet.credit({
      userId: user,
      amount: '100',
      refType: 'topup',
      refId: ref(user, 'fund'),
    });
    await wallet.authorize({
      userId: user,
      amount: '80',
      refType: 'order',
      refId: ref(user, 'hold'),
    });

    await expect(
      wallet.transfer({
        from: { userId: user },
        to: { userId: receiver },
        amount: '21',
        refType: 'p2p',
        refId: ref(user, 'blocked-transfer'),
      }),
    ).rejects.toMatchObject({ code: 'insufficient_balance' });
    await expect(
      wallet.refund({
        userId: user,
        amount: '21',
        refType: 'topup_refund',
        refId: ref(user, 'blocked-refund'),
      }),
    ).rejects.toMatchObject({ code: 'insufficient_balance' });

    const settled = await wallet.settle({
      refType: 'order',
      refId: ref(user, 'hold'),
      amount: '80',
    });
    expect(sameAmount(settled.balanceAfter, '20')).toBe(true);
  });

  it('下调授信不能使 active 冻结失去资金覆盖', async () => {
    const user = nextUser();
    await wallet.setCreditLimit({
      userId: user,
      amount: '100',
      refType: 'credit_line',
      refId: ref(user, 'grant'),
    });
    await wallet.authorize({
      userId: user,
      amount: '80',
      refType: 'order',
      refId: ref(user, 'hold'),
    });

    await expect(
      wallet.setCreditLimit({
        userId: user,
        amount: '79',
        refType: 'credit_line',
        refId: ref(user, 'lower'),
      }),
    ).rejects.toMatchObject({ code: 'credit_limit_conflict' });
    await wallet.settle({ refType: 'order', refId: ref(user, 'hold'), amount: '80' });
    expect(sameAmount(await wallet.balance(user), '-80')).toBe(true);
  });

  it('DB 在事务提交前拒绝单边分录', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '1', refType: 'topup', refId: ref(user, 'seed') });
    const account = await accountOf(user);
    const marker = new Error('missing deferred ledger constraint');
    let failure: unknown;

    try {
      await db.transaction(async (tx) => {
        const [header] = await tx
          .insert(walletTransactions)
          .values({ kind: 'credit', refType: 'topup', refId: ref(user, 'unbalanced') })
          .returning({ id: walletTransactions.id });
        await tx.insert(walletLegs).values({
          transactionId: header!.id,
          accountId: account.id,
          currency: 'CNY',
          amount: '1',
          balanceBefore: account.balance,
          balanceAfter: String(Number(account.balance) + 1),
        });
        await tx.execute(sql`set constraints all immediate`);
        throw marker;
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeDefined();
    expect(failure).not.toBe(marker);
  });
});

describe('稳定幂等回执', () => {
  it('settle 重放返回首次落账余额，不受后续交易影响', async () => {
    const user = nextUser();
    await wallet.credit({
      userId: user,
      amount: '100',
      refType: 'topup',
      refId: ref(user, 'fund'),
    });
    await wallet.authorize({
      userId: user,
      amount: '30',
      refType: 'order',
      refId: ref(user, 'hold'),
    });
    const first = await wallet.settle({ refType: 'order', refId: ref(user, 'hold'), amount: '30' });
    await wallet.credit({
      userId: user,
      amount: '50',
      refType: 'topup',
      refId: ref(user, 'later'),
    });
    const replay = await wallet.settle({
      refType: 'order',
      refId: ref(user, 'hold'),
      amount: '30',
    });

    expect(replay.replayed).toBe(true);
    expect(replay.balanceAfter).toBe(first.balanceAfter);
    expect(replay.settledAmount).toBe(first.settledAmount);
  });

  it('freeze 重放返回首次目标状态，不受后续解冻影响', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '1', refType: 'topup', refId: ref(user, 'fund') });
    const freezeKey = ref(user, 'freeze');
    await wallet.freeze({
      target: { userId: user },
      frozen: true,
      refType: 'risk_control',
      refId: freezeKey,
    });
    await wallet.freeze({
      target: { userId: user },
      frozen: false,
      refType: 'risk_control',
      refId: ref(user, 'unfreeze'),
    });
    const replay = await wallet.freeze({
      target: { userId: user },
      frozen: true,
      refType: 'risk_control',
      refId: freezeKey,
    });

    expect(replay.replayed).toBe(true);
    expect(replay.frozen).toBe(true);
  });

  it('authorize 同键跨币种重放必须拒绝', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 'cny') });
    await wallet.credit({
      userId: user,
      currency: 'USD',
      amount: '10',
      refType: 'topup',
      refId: ref(user, 'usd'),
    });
    const key = ref(user, 'hold');
    await wallet.authorize({ userId: user, amount: '1', refType: 'order', refId: key });

    await expect(
      wallet.authorize({
        userId: user,
        currency: 'USD',
        amount: '1',
        refType: 'order',
        refId: key,
      }),
    ).rejects.toBeInstanceOf(RefKeyConflictError);
  });

  it('transfer 内部科目多币种重放使用调用方币种，不猜测任意账户', async () => {
    const usdUser = nextUser();
    const cnyUser = nextUser();
    await wallet.credit({
      userId: usdUser,
      currency: 'USD',
      amount: '10',
      counterparty: 'marketing_budget',
      refType: 'topup',
      refId: ref(usdUser, 'usd-first'),
    });
    await wallet.credit({
      userId: cnyUser,
      amount: '10',
      refType: 'topup',
      refId: ref(cnyUser, 'cny'),
    });
    const key = ref(cnyUser, 'to-budget');
    const first = await wallet.transfer({
      from: { userId: cnyUser, currency: 'CNY' },
      to: { code: 'marketing_budget', currency: 'CNY' },
      amount: '3',
      refType: 'p2p',
      refId: key,
    });
    const replay = await wallet.transfer({
      from: { userId: cnyUser, currency: 'CNY' },
      to: { code: 'marketing_budget', currency: 'CNY' },
      amount: '3',
      refType: 'p2p',
      refId: key,
    });

    expect(replay).toMatchObject({
      transactionId: first.transactionId,
      fromBalanceAfter: first.fromBalanceAfter,
      toBalanceAfter: first.toBalanceAfter,
      replayed: true,
    });
  });

  it('transfer 冲突重放不创建目标空账户', async () => {
    const from = nextUser();
    const to = nextUser();
    const intruder = nextUser();
    await wallet.credit({ userId: from, amount: '10', refType: 'topup', refId: ref(from, 'fund') });
    const key = ref(from, 'transfer');
    await wallet.transfer({
      from: { userId: from },
      to: { userId: to },
      amount: '1',
      refType: 'p2p',
      refId: key,
    });

    await expect(
      wallet.transfer({
        from: { userId: from },
        to: { userId: intruder },
        amount: '1',
        refType: 'p2p',
        refId: key,
      }),
    ).rejects.toBeInstanceOf(RefKeyConflictError);
    const intruderRows = await db
      .select()
      .from(walletAccounts)
      .where(and(eq(walletAccounts.kind, 'user'), eq(walletAccounts.userId, intruder)));
    expect(intruderRows).toHaveLength(0);
  });

  it('credit 与 setCreditLimit 在账户冻结后仍返回首次稳定回执', async () => {
    const user = nextUser();
    const creditKey = ref(user, 'stable-credit');
    const limitKey = ref(user, 'stable-limit');
    const firstCredit = await wallet.credit({
      userId: user,
      amount: '10',
      refType: 'topup',
      refId: creditKey,
    });
    const firstLimit = await wallet.setCreditLimit({
      userId: user,
      amount: '20',
      refType: 'credit_line',
      refId: limitKey,
    });
    await wallet.freeze({
      target: { userId: user },
      frozen: true,
      refType: 'risk_control',
      refId: ref(user, 'stable-freeze'),
    });

    await expect(
      wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: creditKey }),
    ).resolves.toMatchObject({ transactionId: firstCredit.transactionId, replayed: true });
    await expect(
      wallet.setCreditLimit({
        userId: user,
        amount: '20',
        refType: 'credit_line',
        refId: limitKey,
      }),
    ).resolves.toMatchObject({ transactionId: firstLimit.transactionId, replayed: true });
  });
});

describe('安全组件边界', () => {
  it('根入口只暴露安全 Facade/契约，不暴露原始动词、表和清场方法', () => {
    for (const unsafe of [
      'credit',
      'authorize',
      'settle',
      'release',
      'refund',
      'transfer',
      'setCreditLimit',
      'freeze',
      'walletAccounts',
      'walletLegs',
      'walletTransactions',
      'walletAuthorizations',
      'deprovision',
      'migrateWallet',
      'Decimal',
    ]) {
      expect(publicApi).not.toHaveProperty(unsafe);
    }
    expect(publicApi).toHaveProperty('createWallet');
    expect(migrationsApi).toHaveProperty('migrateWallet');
    expect(wallet).not.toHaveProperty('releaseExpired');
  });
});
