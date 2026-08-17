import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createWallet } from '../wallet';
import {
  deprovision,
  provision,
  walletAccounts,
  walletAuthorizations,
  walletLegs,
  walletTransactions,
} from '../schema';
import {
  AuthorizationNotActiveError,
  AuthorizationNotFoundError,
  CreditLimitConflictError,
  CurrencyMismatchError,
  Decimal,
  FrozenAccountError,
  InsufficientBalanceError,
  InvalidAccountRefError,
  InvalidAmountError,
  RefKeyConflictError,
  SameAccountTransferError,
  SettleExceedsHoldError,
  WalletError,
  WalletInternalError,
} from '../index';

/**
 * wallet 复式账本契约测试：全部打真 PG。
 * 复式不变量：每笔交易 ≥1 腿、资金类交易 ≥2 腿且 Σ 腿 = 0（有借必有贷）；
 * 每账户腿链恒等 after = before + amount 且连续。
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
});
const db = drizzle(pool);
const wallet = createWallet(db);

let userSeq = 0;
const nextUser = (): number => 900_000_000 + (Date.now() % 1_000_000) * 10 + userSeq++;
/** 该用户的唯一幂等键（跨测试/跨运行唯一） */
const ref = (user: number, key: string): string => `${key}-${user}`;

const d = (v: string): Decimal => new Decimal(v);
const sameAmount = (a: string, b: string): boolean => d(a).eq(d(b));

async function accountOf(userId: number, currency = 'CNY') {
  const [row] = await db
    .select()
    .from(walletAccounts)
    .where(and(eq(walletAccounts.kind, 'user'), eq(walletAccounts.userId, userId), eq(walletAccounts.currency, currency)));
  if (!row) throw new Error(`account ${userId}/${currency} missing`);
  return row;
}

async function internalAccount(code: string, currency = 'CNY') {
  const [row] = await db
    .select()
    .from(walletAccounts)
    .where(and(eq(walletAccounts.kind, 'internal'), eq(walletAccounts.code, code), eq(walletAccounts.currency, currency)));
  if (!row) throw new Error(`internal account ${code}/${currency} missing`);
  return row;
}

/** 用户账户的腿（按序） */
async function legsOfAccount(accountId: string) {
  return db
    .select()
    .from(walletLegs)
    .where(eq(walletLegs.accountId, accountId))
    .orderBy(asc(walletLegs.id));
}

/** 全账本对账：Σ 腿 = 0 / 每账户链恒等且连续 / 账户余额 = 腿的代数和 */
async function assertLedgerCoherent(): Promise<void> {
  const legs = await db.select().from(walletLegs).orderBy(asc(walletLegs.id));
  const byTx = new Map<number, Decimal>();
  for (const leg of legs) {
    byTx.set(leg.transactionId, (byTx.get(leg.transactionId) ?? new Decimal(0)).plus(d(leg.amount)));
  }
  for (const [txId, total] of byTx) {
    expect(total.isZero(), `transaction ${txId} legs must sum to zero`).toBe(true);
  }
  const accounts = await db.select().from(walletAccounts);
  for (const account of accounts) {
    const own = legs.filter((leg) => leg.accountId === account.id);
    let expected = new Decimal(0);
    for (const leg of own) {
      expect(d(leg.balanceAfter).eq(d(leg.balanceBefore).plus(d(leg.amount)))).toBe(true);
      expect(d(leg.balanceBefore).eq(expected)).toBe(true);
      expected = d(leg.balanceAfter);
    }
    expect(d(account.balance).eq(expected), `account ${account.id} balance matches legs`).toBe(true);
  }
}

beforeAll(async () => {
  await deprovision(db);
  await provision(db);
}, 30_000);

afterAll(async () => {
  await assertLedgerCoherent(); // 全套测试跑完全账本仍自洽
  await deprovision(db);
  await pool.end();
});

describe('wallet 错误面契约', () => {
  it('所有公开错误均为 WalletError 子类且 code 全局唯一——外部可凭 code 精确分流', () => {
    const samples: Array<{ error: WalletError; code: string }> = [
      { error: new InvalidAmountError('x'), code: 'invalid_amount' },
      { error: new InvalidAccountRefError('x'), code: 'invalid_account_ref' },
      { error: new InsufficientBalanceError(1, '0', '1'), code: 'insufficient_balance' },
      { error: new AuthorizationNotFoundError('a', 'b'), code: 'authorization_not_found' },
      { error: new AuthorizationNotActiveError('a', 'b', 'settled'), code: 'authorization_not_active' },
      { error: new SettleExceedsHoldError('1', '2'), code: 'settle_exceeds_hold' },
      { error: new RefKeyConflictError('a', 'b', 1), code: 'ref_key_conflict' },
      { error: new CreditLimitConflictError(1, 'CNY', '0', '0'), code: 'credit_limit_conflict' },
      { error: new FrozenAccountError('uuid'), code: 'account_frozen' },
      { error: new SameAccountTransferError('uuid'), code: 'same_account_transfer' },
      { error: new CurrencyMismatchError('CNY', 'USD'), code: 'currency_mismatch' },
      { error: new WalletInternalError('credit.insert'), code: 'internal_error' },
    ];
    const codes = new Set<string>();
    for (const { error, code } of samples) {
      expect(error).toBeInstanceOf(WalletError);
      expect(error.code).toBe(code);
      expect(codes.has(code)).toBe(false);
      codes.add(code);
    }
  });
});

describe('wallet 入账 credit', () => {
  it('入账更新余额，顺序重放返回首次结果（幂等）', async () => {
    const user = nextUser();
    const first = await wallet.credit({ userId: user, amount: '99.00', refType: 'topup', refId: ref(user, 'tp1') });
    const replay = await wallet.credit({ userId: user, amount: '99.00', refType: 'topup', refId: ref(user, 'tp1') });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(sameAmount(replay.balanceAfter, first.balanceAfter)).toBe(true);
    expect(sameAmount(await wallet.balance(user), '99')).toBe(true);
    const headers = await db.select().from(walletTransactions).where(eq(walletTransactions.refId, ref(user, 'tp1')));
    expect(headers).toHaveLength(1);
  });

  it('并发同键重放：恰好一笔交易', async () => {
    const user = nextUser();
    const [a, b] = await Promise.all([
      wallet.credit({ userId: user, amount: '50', refType: 'topup', refId: ref(user, 'race') }),
      wallet.credit({ userId: user, amount: '50', refType: 'topup', refId: ref(user, 'race') }),
    ]);
    expect([a.replayed, b.replayed].toSorted()).toEqual([false, true]);
    expect(sameAmount(await wallet.balance(user), '50')).toBe(true);
    const headers = await db.select().from(walletTransactions).where(eq(walletTransactions.refId, ref(user, 'race')));
    expect(headers).toHaveLength(1);
  });

  it('非法金额拒绝（0/负数/非数字），无状态残留', async () => {
    const user = nextUser();
    await expect(wallet.credit({ userId: user, amount: '0', refType: 'topup', refId: 'x' })).rejects.toThrow();
    await expect(wallet.credit({ userId: user, amount: '-5', refType: 'topup', refId: 'x' })).rejects.toThrow();
    await expect(wallet.credit({ userId: user, amount: 'abc', refType: 'topup', refId: 'x' })).rejects.toThrow();
    expect(sameAmount(await wallet.balance(user), '0')).toBe(true);
  });

  it('幂等键跨账户顶撞：拒绝并指向键主，绝不把别人的流水当重放结果', async () => {
    const owner = nextUser();
    const intruder = nextUser();
    await wallet.credit({ userId: owner, amount: '10', refType: 'topup', refId: ref(owner, 'clash') });
    const error = await wallet
      .credit({ userId: intruder, amount: '5', refType: 'topup', refId: ref(owner, 'clash') })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RefKeyConflictError);
    expect((error as RefKeyConflictError).ownerUserId).toBe(owner);
    expect(sameAmount(await wallet.balance(intruder), '0')).toBe(true);

    await wallet.credit({ userId: intruder, amount: '10', refType: 'topup', refId: ref(intruder, 't') });
    await wallet.authorize({ userId: owner, amount: '3', refType: 'order', refId: ref(owner, 'clash2') });
    await expect(
      wallet.authorize({ userId: intruder, amount: '1', refType: 'order', refId: ref(owner, 'clash2') }),
    ).rejects.toBeInstanceOf(RefKeyConflictError);
  });
});

describe('wallet 两阶段 authorize/settle/release', () => {
  it('全额结算：冻结 → 实扣，余额与在途归零', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '300', refType: 'topup', refId: ref(user, 't') });
    const hold = await wallet.authorize({ userId: user, amount: '259.00', refType: 'order', refId: ref(user, 'full') });
    expect(hold.status).toBe('active');
    expect(hold.replayed).toBe(false);

    const settled = await wallet.settle({ refType: 'order', refId: ref(user, 'full'), amount: '259.00' });
    expect(settled.replayed).toBe(false);
    expect(sameAmount(settled.settledAmount, '259')).toBe(true);
    expect(sameAmount(settled.balanceAfter, '41')).toBe(true);
    expect(sameAmount(settled.releasedRemainder, '0')).toBe(true);

    const account = await accountOf(user);
    expect(sameAmount(account.balance, '41')).toBe(true);
    expect(sameAmount(account.inFlight, '0')).toBe(true);
  });

  it('部分结算：实扣少于冻结，余量归还（在途归零）', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '80', refType: 'order', refId: ref(user, 'part') });
    const settled = await wallet.settle({ refType: 'order', refId: ref(user, 'part'), amount: '60' });
    expect(sameAmount(settled.settledAmount, '60')).toBe(true);
    expect(sameAmount(settled.releasedRemainder, '20')).toBe(true);
    const account = await accountOf(user);
    expect(sameAmount(account.balance, '40')).toBe(true);
    expect(sameAmount(account.inFlight, '0')).toBe(true);
  });

  it('结算重放返回首次结果', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '30', refType: 'order', refId: ref(user, 're') });
    const first = await wallet.settle({ refType: 'order', refId: ref(user, 're'), amount: '30' });
    const replay = await wallet.settle({ refType: 'order', refId: ref(user, 're'), amount: '30' });
    expect(replay.replayed).toBe(true);
    expect(sameAmount(replay.settledAmount, first.settledAmount)).toBe(true);
    expect(sameAmount(await wallet.balance(user), '70')).toBe(true);
  });

  it('并发双重结算：恰好一次生效', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '40', refType: 'order', refId: ref(user, 'srace') });
    const [a, b] = await Promise.all([
      wallet.settle({ refType: 'order', refId: ref(user, 'srace'), amount: '40' }),
      wallet.settle({ refType: 'order', refId: ref(user, 'srace'), amount: '40' }),
    ]);
    expect([a.replayed, b.replayed].toSorted()).toEqual([false, true]);
    expect(sameAmount(await wallet.balance(user), '60')).toBe(true);
    const headers = await db.select().from(walletTransactions).where(eq(walletTransactions.refId, ref(user, 'srace')));
    expect(headers.filter((h) => h.kind === 'settle')).toHaveLength(1);
  });

  it('结算超过冻结额拒绝，状态不变', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '10', refType: 'order', refId: ref(user, 'over') });
    await expect(
      wallet.settle({ refType: 'order', refId: ref(user, 'over'), amount: '11' }),
    ).rejects.toBeInstanceOf(SettleExceedsHoldError);
    const [auth] = await db
      .select()
      .from(walletAuthorizations)
      .where(eq(walletAuthorizations.refId, ref(user, 'over')));
    expect(auth?.status).toBe('active');
    expect(sameAmount(await wallet.balance(user), '100')).toBe(true);
  });

  it('释放：余额不动、在途归还；重复释放为幂等 no-op；不落交易（审计在单据）', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '70', refType: 'order', refId: ref(user, 'rel') });
    const before = (await db.select().from(walletTransactions)).length;
    const released = await wallet.release({ refType: 'order', refId: ref(user, 'rel'), reason: 'user_cancel' });
    expect(released.replayed).toBe(false);
    expect(sameAmount(await wallet.balance(user), '100')).toBe(true);
    const replay = await wallet.release({ refType: 'order', refId: ref(user, 'rel') });
    expect(replay.replayed).toBe(true);
    const account = await accountOf(user);
    expect(sameAmount(account.inFlight, '0')).toBe(true);
    const after = (await db.select().from(walletTransactions)).length;
    expect(after).toBe(before); // 释放不产生交易（复式下零额噪声行取消）
  });

  it('已释放的冻结不可结算（状态机互斥）', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '10', refType: 'order', refId: ref(user, 'dead') });
    await wallet.release({ refType: 'order', refId: ref(user, 'dead') });
    await expect(
      wallet.settle({ refType: 'order', refId: ref(user, 'dead'), amount: '10' }),
    ).rejects.toBeInstanceOf(AuthorizationNotActiveError);
    expect(sameAmount(await wallet.balance(user), '100')).toBe(true);
  });

  it('可用口径扣减在途：第二笔冻结被拒且无状态残留', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '8', refType: 'order', refId: ref(user, 'a') });
    await expect(
      wallet.authorize({ userId: user, amount: '3', refType: 'order', refId: ref(user, 'b') }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    const account = await accountOf(user);
    expect(sameAmount(account.inFlight, '8')).toBe(true);
    expect(sameAmount(account.balance, '10')).toBe(true);
  });

  it('authorize 幂等：同键重放返回既有冻结，在途不重复累计', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    const first = await wallet.authorize({ userId: user, amount: '20', refType: 'order', refId: ref(user, 'idem') });
    const replay = await wallet.authorize({ userId: user, amount: '20', refType: 'order', refId: ref(user, 'idem') });
    expect(replay.replayed).toBe(true);
    expect(replay.authorizationId).toBe(first.authorizationId);
    const account = await accountOf(user);
    expect(sameAmount(account.inFlight, '20')).toBe(true);
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
    const { released } = await wallet.releaseExpired(new Date());
    expect(released).toBeGreaterThanOrEqual(1);
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

describe('wallet 退款 refund', () => {
  it('余额守卫 + 独立幂等域', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 'r') });
    await expect(
      wallet.refund({ userId: user, amount: '11', refType: 'topup_refund', refId: ref(user, 'r') }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    const first = await wallet.refund({ userId: user, amount: '4', refType: 'topup_refund', refId: ref(user, 'r') });
    const replay = await wallet.refund({ userId: user, amount: '4', refType: 'topup_refund', refId: ref(user, 'r') });
    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(sameAmount(await wallet.balance(user), '6')).toBe(true);
    const all = await db.select().from(walletTransactions);
    expect(all.filter((h) => h.kind === 'refund' && h.refId === ref(user, 'r'))).toHaveLength(1);
  });
});

describe('wallet 复式：对手科目与守恒', () => {
  it('credit 对 outside / settle 对 platform_revenue / refund 原路退回：科目余额差值正确', async () => {
    const user = nextUser();
    const outsideBefore = d((await internalAccount('outside')).balance);
    const revenueBefore = d((await internalAccount('platform_revenue')).balance);

    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '30', refType: 'order', refId: ref(user, 'o') });
    await wallet.settle({ refType: 'order', refId: ref(user, 'o'), amount: '25' });
    await wallet.refund({ userId: user, amount: '5', refType: 'topup_refund', refId: ref(user, 'rr') });

    // 差值断言（内部科目全账本共享，不比绝对值）
    expect(d((await internalAccount('outside')).balance).minus(outsideBefore).eq(new Decimal('-95'))).toBe(true); // −100 充值 +5 退款
    expect(d((await internalAccount('platform_revenue')).balance).minus(revenueBefore).eq(new Decimal('25'))).toBe(true); // 结算即收入确认
    expect(sameAmount(await wallet.balance(user), '70')).toBe(true); // 100 − 25 − 5
  });

  it('自定义对手科目：counterparty 指定营销费用科目', async () => {
    const user = nextUser();
    await wallet.credit({
      userId: user, amount: '8', refType: 'gift', refId: ref(user, 'g'),
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

describe('wallet 原子转账 transfer', () => {
  it('用户 ↔ 用户：双腿守恒，双方余额正确', async () => {
    const from = nextUser();
    const to = nextUser();
    await wallet.credit({ userId: from, amount: '100', refType: 'topup', refId: ref(from, 't') });
    const result = await wallet.transfer({
      from: { userId: from }, to: { userId: to }, amount: '30',
      refType: 'p2p', refId: ref(from, 'tv1'),
    });
    expect(sameAmount(result.fromBalanceAfter, '70')).toBe(true);
    expect(sameAmount(result.toBalanceAfter, '30')).toBe(true);
    expect(sameAmount(await wallet.balance(to), '30')).toBe(true);
  });

  it('电商分账：订单结算后 一笔转账拆平台佣金与商家入账', async () => {
    const buyer = nextUser();
    const merchant = nextUser();
    const revenueBefore = d((await internalAccount('platform_revenue')).balance);
    await wallet.credit({ userId: buyer, amount: '100', refType: 'topup', refId: ref(buyer, 't') });
    await wallet.authorize({ userId: buyer, amount: '90', refType: 'order', refId: ref(buyer, 'od') });
    // 买家结算 90（进入 platform_revenue），再分账：佣金留收入，80 转商家
    await wallet.settle({ refType: 'order', refId: ref(buyer, 'od'), amount: '90' });
    await wallet.transfer({
      from: { code: 'platform_revenue' }, to: { userId: merchant }, amount: '80',
      refType: 'payout', refId: ref(buyer, 'split'),
    });
    expect(sameAmount(await wallet.balance(merchant), '80')).toBe(true);
    // 佣金 = 90 − 80（差值断言：科目全账本共享）
    expect(d((await internalAccount('platform_revenue')).balance).minus(revenueBefore).eq(new Decimal('10'))).toBe(true);
  });

  it('同账户转账拒绝；跨币种拒绝（换汇 = 两笔独立转账）', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    await wallet.credit({ userId: user, currency: 'USD', amount: '5', refType: 'topup', refId: ref(user, 'tu') });
    await expect(
      wallet.transfer({ from: { userId: user }, to: { userId: user }, amount: '1', refType: 'p2p', refId: ref(user, 'same') }),
    ).rejects.toThrow();
    await expect(
      wallet.transfer({
        from: { userId: user }, to: { userId: user, currency: 'USD' }, amount: '1',
        refType: 'exchange', refId: ref(user, 'xm'),
      }),
    ).rejects.toBeInstanceOf(CurrencyMismatchError);
  });

  it('出账守卫：地板内可转、击穿即拒；重放幂等', async () => {
    const from = nextUser();
    const to = nextUser();
    await wallet.credit({ userId: from, amount: '10', refType: 'topup', refId: ref(from, 't') });
    await expect(
      wallet.transfer({ from: { userId: from }, to: { userId: to }, amount: '11', refType: 'p2p', refId: ref(from, 'x') }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    const first = await wallet.transfer({
      from: { userId: from }, to: { userId: to }, amount: '10',
      refType: 'p2p', refId: ref(from, 'ok'),
    });
    const replay = await wallet.transfer({
      from: { userId: from }, to: { userId: to }, amount: '10',
      refType: 'p2p', refId: ref(from, 'ok'),
    });
    expect(replay.replayed).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(sameAmount(await wallet.balance(to), '10')).toBe(true);
  });
});

describe('wallet 多币种 currency（缺省 CNY，一币一账互不净额）', () => {
  it('同用户双币账户隔离：USD 冻结不影响 CNY 可用；accounts 列出双币', async () => {
    const user = nextUser();
    const outsideUsdBefore = d((await internalAccount('outside', 'USD')).balance);
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 'cny') });
    await wallet.credit({ userId: user, currency: 'USD', amount: '20', refType: 'topup', refId: ref(user, 'usd') });

    await wallet.authorize({ userId: user, currency: 'USD', amount: '15', refType: 'order', refId: ref(user, 'uh') });
    await wallet.authorize({ userId: user, amount: '100', refType: 'order', refId: ref(user, 'ch') });

    const summaries = await wallet.accounts(user);
    expect(summaries.map((s) => s.currency).toSorted()).toEqual(['CNY', 'USD']);
    const usd = summaries.find((s) => s.currency === 'USD');
    expect(usd && sameAmount(usd.inFlight, '15')).toBe(true);
    expect(sameAmount(await wallet.balance(user, 'USD'), '20')).toBe(true);
    // 双币各自配对科目（outside/USD 只动 USD 腿）——差值断言
    const outsideUsd = await internalAccount('outside', 'USD');
    expect(d(outsideUsd.balance).minus(outsideUsdBefore).eq(new Decimal('-20'))).toBe(true);
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

describe('wallet 授信地板 credit_limit（缺省 0 = 纯预付）', () => {
  it('授信扩大可用口径，消费可至负余额但不击穿地板', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    await expect(
      wallet.authorize({ userId: user, amount: '11', refType: 'order', refId: ref(user, 'x') }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    await wallet.setCreditLimit({ userId: user, amount: '50', refType: 'credit_line', refId: ref(user, 'grant') });
    await wallet.authorize({ userId: user, amount: '55', refType: 'order', refId: ref(user, 'big') });
    await expect(
      wallet.authorize({ userId: user, amount: '6', refType: 'order', refId: ref(user, 'over') }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);

    await wallet.settle({ refType: 'order', refId: ref(user, 'big'), amount: '35' });
    expect(sameAmount(await wallet.balance(user), '-25')).toBe(true);
  });

  it('退款受地板守卫：可用授信额度内可退，击穿即拒', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    await wallet.setCreditLimit({ userId: user, amount: '50', refType: 'credit_line', refId: ref(user, 'grant') });
    await wallet.refund({ userId: user, amount: '30', refType: 'topup_refund', refId: ref(user, 'r1') });
    expect(sameAmount(await wallet.balance(user), '-20')).toBe(true);
    await expect(
      wallet.refund({ userId: user, amount: '35', refType: 'topup_refund', refId: ref(user, 'r2') }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it('setCreditLimit 幂等；降额低于当前欠款拒绝；零额审计腿不破坏链', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    const first = await wallet.setCreditLimit({ userId: user, amount: '50', refType: 'credit_line', refId: ref(user, 'g') });
    const replay = await wallet.setCreditLimit({ userId: user, amount: '50', refType: 'credit_line', refId: ref(user, 'g') });
    expect(replay.replayed).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(sameAmount(replay.creditLimit, '50')).toBe(true);

    await wallet.authorize({ userId: user, amount: '30', refType: 'order', refId: ref(user, 'o') });
    await wallet.settle({ refType: 'order', refId: ref(user, 'o'), amount: '30' });
    expect(sameAmount(await wallet.balance(user), '-20')).toBe(true);
    await expect(
      wallet.setCreditLimit({ userId: user, amount: '10', refType: 'credit_line', refId: ref(user, 'down') }),
    ).rejects.toBeInstanceOf(CreditLimitConflictError);
    const lowered = await wallet.setCreditLimit({ userId: user, amount: '20', refType: 'credit_line', refId: ref(user, 'ok') });
    expect(sameAmount(lowered.creditLimit, '20')).toBe(true);
  });
});

describe('wallet 冻结 freeze（风控）', () => {
  it('冻结后拒绝一切资金变动，解冻恢复；查询不受限', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    const frozen = await wallet.freeze({ target: { userId: user }, frozen: true, refType: 'risk_control', refId: ref(user, 'f1') });
    expect(frozen.frozen).toBe(true);

    await expect(
      wallet.credit({ userId: user, amount: '1', refType: 'topup', refId: ref(user, 'blocked') }),
    ).rejects.toBeInstanceOf(FrozenAccountError);
    await expect(
      wallet.authorize({ userId: user, amount: '1', refType: 'order', refId: ref(user, 'blocked') }),
    ).rejects.toBeInstanceOf(FrozenAccountError);
    await expect(
      wallet.refund({ userId: user, amount: '1', refType: 'topup_refund', refId: ref(user, 'blocked') }),
    ).rejects.toBeInstanceOf(FrozenAccountError);
    await expect(
      wallet.transfer({ from: { userId: user }, to: { code: 'platform_revenue' }, amount: '1', refType: 'p2p', refId: ref(user, 'blocked') }),
    ).rejects.toBeInstanceOf(FrozenAccountError);
    expect(sameAmount(await wallet.balance(user), '100')).toBe(true); // 查询不受限

    await wallet.freeze({ target: { userId: user }, frozen: false, refType: 'risk_control', refId: ref(user, 'f2') });
    await wallet.credit({ userId: user, amount: '1', refType: 'topup', refId: ref(user, 'after') });
    expect(sameAmount(await wallet.balance(user), '101')).toBe(true);
  });

  it('冻结内部科目同样生效', async () => {
    await wallet.freeze({ target: { code: 'outside', currency: 'USD' }, frozen: true, refType: 'risk_control', refId: `freeze-outside-usd-${Date.now()}` });
    await expect(
      wallet.credit({ userId: nextUser(), currency: 'USD', amount: '1', refType: 'topup', refId: `usd-blocked-${Date.now()}` }),
    ).rejects.toBeInstanceOf(FrozenAccountError);
    await wallet.freeze({ target: { code: 'outside', currency: 'USD' }, frozen: false, refType: 'risk_control', refId: `unfreeze-outside-usd-${Date.now()}` });
  });
});

describe('wallet 全局不变量', () => {
  it('混合操作后：流水链恒等、连续，账户余额 = 各腿代数和', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100.5', refType: 'topup', refId: ref(user, 'iv1') });
    await wallet.credit({ userId: user, amount: '0.5', refType: 'gift', refId: ref(user, 'iv2') });
    await wallet.authorize({ userId: user, amount: '60', refType: 'order', refId: ref(user, 'iv3') });
    await wallet.settle({ refType: 'order', refId: ref(user, 'iv3'), amount: '55' });
    await wallet.authorize({ userId: user, amount: '10', refType: 'order', refId: ref(user, 'iv4') });
    await wallet.release({ refType: 'order', refId: ref(user, 'iv4') });
    await wallet.refund({ userId: user, amount: '1.25', refType: 'topup_refund', refId: ref(user, 'iv1') });

    const account = await accountOf(user);
    expect(d(account.balance).eq(new Decimal('44.75'))).toBe(true); // 101 − 55 − 1.25

    // 用户账户腿链复核
    const legs = await legsOfAccount(account.id);
    expect(legs.length).toBeGreaterThanOrEqual(4);
    let expected = new Decimal(0);
    for (const leg of legs) {
      expect(d(leg.balanceAfter).eq(d(leg.balanceBefore).plus(d(leg.amount)))).toBe(true);
      expect(d(leg.balanceBefore).eq(expected)).toBe(true);
      expected = d(leg.balanceAfter);
    }
    await assertLedgerCoherent();
  });

  it('全精度：1e-18 级金额不丢不 round、不落科学计数法', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '0.000000000000000001', refType: 'topup', refId: ref(user, 'p1') });
    await wallet.credit({ userId: user, amount: '0.000000000000000002', refType: 'topup', refId: ref(user, 'p2') });
    expect(sameAmount(await wallet.balance(user), '0.000000000000000003')).toBe(true);
    const account = await accountOf(user);
    const legs = await legsOfAccount(account.id);
    for (const leg of legs) {
      expect(leg.amount.includes('e')).toBe(false);
    }
  });
});
