import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createWallet } from '../wallet';
import {
  deprovision,
  provision,
  walletAccounts,
  walletAuthorizations,
  walletTransactions,
} from '../schema';
import {
  AuthorizationNotActiveError,
  CreditLimitConflictError,
  Decimal,
  InsufficientBalanceError,
  RefKeyConflictError,
  SettleExceedsHoldError,
} from '../index';

type AccountRow = typeof walletAccounts.$inferSelect;

/**
 * wallet 契约测试：全部打真 PG（与 ledger 红线测试同标准）。
 * 表为本包私有（wallet_*），beforeAll 建 / afterAll 删，不碰业务表。
 * 幂等键全局唯一——refId 一律按用户唯一化，防跨测试顶撞。
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

async function accountOf(user: number): Promise<AccountRow> {
  const [row] = await db.select().from(walletAccounts).where(eq(walletAccounts.userId, user));
  if (!row) throw new Error(`account ${user} missing`);
  return row;
}

beforeAll(async () => {
  await deprovision(db);
  await provision(db);
}, 30_000);

afterAll(async () => {
  await deprovision(db);
  await pool.end();
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
    const rows = await db.select().from(walletTransactions).where(eq(walletTransactions.userId, user));
    expect(rows).toHaveLength(1);
  });

  it('并发同键重放：恰好一条入账流水', async () => {
    const user = nextUser();
    const [a, b] = await Promise.all([
      wallet.credit({ userId: user, amount: '50', refType: 'topup', refId: ref(user, 'race') }),
      wallet.credit({ userId: user, amount: '50', refType: 'topup', refId: ref(user, 'race') }),
    ]);
    expect([a.replayed, b.replayed].toSorted()).toEqual([false, true]);
    expect(sameAmount(await wallet.balance(user), '50')).toBe(true);
    const rows = await db.select().from(walletTransactions).where(eq(walletTransactions.userId, user));
    expect(rows).toHaveLength(1);
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
    expect(sameAmount(await wallet.balance(intruder), '0')).toBe(true); // 串号方余额零污染

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
    expect(sameAmount(replay.balanceAfter, first.balanceAfter)).toBe(true);
    expect(sameAmount(await wallet.balance(user), '70')).toBe(true);
  });

  it('并发双重结算：恰好一次生效', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '40', refType: 'order', refId: ref(user, 'race') });
    const [a, b] = await Promise.all([
      wallet.settle({ refType: 'order', refId: ref(user, 'race'), amount: '40' }),
      wallet.settle({ refType: 'order', refId: ref(user, 'race'), amount: '40' }),
    ]);
    expect([a.replayed, b.replayed].toSorted()).toEqual([false, true]);
    expect(sameAmount(await wallet.balance(user), '60')).toBe(true);
    const settles = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.refId, ref(user, 'race')));
    expect(settles.filter((r) => r.kind === 'settle')).toHaveLength(1);
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

  it('释放：余额不动、在途归还；重复释放为幂等 no-op', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '70', refType: 'order', refId: ref(user, 'rel') });
    const released = await wallet.release({ refType: 'order', refId: ref(user, 'rel'), reason: 'user_cancel' });
    expect(released.replayed).toBe(false);
    expect(sameAmount(await wallet.balance(user), '100')).toBe(true);
    const replay = await wallet.release({ refType: 'order', refId: ref(user, 'rel') });
    expect(replay.replayed).toBe(true);
    const account = await accountOf(user);
    expect(sameAmount(account.inFlight, '0')).toBe(true);
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
    const rows = await db.select().from(walletTransactions).where(eq(walletTransactions.userId, user));
    expect(rows).toHaveLength(2); // credit + refund 各一条
  });
});

describe('wallet 全局不变量', () => {
  it('混合操作后：流水链恒等、连续，且账户余额 = 各流水代数和', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100.5', refType: 'topup', refId: ref(user, 'iv1') });
    await wallet.credit({ userId: user, amount: '0.5', refType: 'gift', refId: ref(user, 'iv2') });
    await wallet.authorize({ userId: user, amount: '60', refType: 'order', refId: ref(user, 'iv3') });
    await wallet.settle({ refType: 'order', refId: ref(user, 'iv3'), amount: '55' });
    await wallet.authorize({ userId: user, amount: '10', refType: 'order', refId: ref(user, 'iv4') });
    await wallet.release({ refType: 'order', refId: ref(user, 'iv4') });
    await wallet.refund({ userId: user, amount: '1.25', refType: 'topup_refund', refId: ref(user, 'iv1') });

    const rows = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.userId, user))
      .orderBy(asc(walletTransactions.id));
    expect(rows).toHaveLength(5);

    let expected = new Decimal(0);
    for (const row of rows) {
      const before = d(row.balanceBefore);
      const after = d(row.balanceAfter);
      const amount = d(row.amount);
      expect(after.eq(before.plus(amount))).toBe(true); // 链恒等（DB check 外应用层复核）
      expect(before.eq(expected)).toBe(true); // 连续性
      expected = after;
    }
    const account = await accountOf(user);
    expect(d(account.balance).eq(expected)).toBe(true);
    expect(expected.eq(new Decimal('44.75'))).toBe(true); // 101 − 55 − 1.25
  });

  it('全精度：1e-18 级金额不丢不 round、不落科学计数法', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '0.000000000000000001', refType: 'topup', refId: ref(user, 'p1') });
    await wallet.credit({ userId: user, amount: '0.000000000000000002', refType: 'topup', refId: ref(user, 'p2') });
    expect(sameAmount(await wallet.balance(user), '0.000000000000000003')).toBe(true);
    const rows = await db.select().from(walletTransactions).where(eq(walletTransactions.userId, user));
    for (const row of rows) {
      expect(row.amount.includes('e')).toBe(false);
    }
  });
});

describe('wallet 多币种 currency（缺省 CNY，一币一账互不净额）', () => {
  it('同用户双币账户隔离：USD 冻结不影响 CNY 可用；accounts 列出双币', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 'cny') });
    await wallet.credit({ userId: user, currency: 'USD', amount: '20', refType: 'topup', refId: ref(user, 'usd') });

    await wallet.authorize({ userId: user, currency: 'USD', amount: '15', refType: 'order', refId: ref(user, 'usd-hold') });
    // CNY 可用不受 USD 在途影响
    await wallet.authorize({ userId: user, amount: '100', refType: 'order', refId: ref(user, 'cny-hold') });

    const summaries = await wallet.accounts(user);
    expect(summaries.map((s) => s.currency).toSorted()).toEqual(['CNY', 'USD']);
    const usd = summaries.find((s) => s.currency === 'USD');
    const cny = summaries.find((s) => s.currency === 'CNY');
    expect(usd && sameAmount(usd.inFlight, '15')).toBe(true);
    expect(cny && sameAmount(cny.inFlight, '100')).toBe(true);
    expect(sameAmount(await wallet.balance(user, 'USD'), '20')).toBe(true);
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
    // 无授信：可用 10
    await expect(
      wallet.authorize({ userId: user, amount: '11', refType: 'order', refId: ref(user, 'x') }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    // 授信 50：可用 = 10 + 50
    await wallet.setCreditLimit({ userId: user, amount: '50', refType: 'credit_line', refId: ref(user, 'grant') });
    await wallet.authorize({ userId: user, amount: '55', refType: 'order', refId: ref(user, 'big') });
    await expect(
      wallet.authorize({ userId: user, amount: '6', refType: 'order', refId: ref(user, 'over') }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);

    // 结算后负余额成立（10 − 55×部分）：结 35 → balance = −25 ≥ −50
    await wallet.settle({ refType: 'order', refId: ref(user, 'big'), amount: '35' });
    expect(sameAmount(await wallet.balance(user), '-25')).toBe(true);
  });

  it('退款受地板守卫：可用授信额度内可退，击穿即拒', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    await wallet.setCreditLimit({ userId: user, amount: '50', refType: 'credit_line', refId: ref(user, 'grant') });
    // balance 10 → 退 30：到 −20 ≥ −50 ✓
    await wallet.refund({ userId: user, amount: '30', refType: 'topup_refund', refId: ref(user, 'r1') });
    expect(sameAmount(await wallet.balance(user), '-20')).toBe(true);
    // 再退 35：到 −55 < −50 ✗
    await expect(
      wallet.refund({ userId: user, amount: '35', refType: 'topup_refund', refId: ref(user, 'r2') }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it('setCreditLimit 幂等；降额低于当前欠款拒绝；审计行不破坏余额链', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    const first = await wallet.setCreditLimit({ userId: user, amount: '50', refType: 'credit_line', refId: ref(user, 'g') });
    const replay = await wallet.setCreditLimit({ userId: user, amount: '50', refType: 'credit_line', refId: ref(user, 'g') });
    expect(replay.replayed).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(sameAmount(replay.creditLimit, '50')).toBe(true);

    // 欠款 30（授信 50 内消费）
    await wallet.authorize({ userId: user, amount: '30', refType: 'order', refId: ref(user, 'o') });
    await wallet.settle({ refType: 'order', refId: ref(user, 'o'), amount: '30' });
    expect(sameAmount(await wallet.balance(user), '-20')).toBe(true);
    // 降额到 10：−20 < −10 击穿地板
    await expect(
      wallet.setCreditLimit({ userId: user, amount: '10', refType: 'credit_line', refId: ref(user, 'down') }),
    ).rejects.toBeInstanceOf(CreditLimitConflictError);
    // 降额到 20：恰好贴地板，允许
    const lowered = await wallet.setCreditLimit({ userId: user, amount: '20', refType: 'credit_line', refId: ref(user, 'ok') });
    expect(sameAmount(lowered.creditLimit, '20')).toBe(true);

    // 审计行链完整性：credit_line 行 amount=0 且 before=after
    const rows = await db
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.userId, user))
      .orderBy(asc(walletTransactions.id));
    let expected = new Decimal(0);
    for (const row of rows) {
      expect(d(row.balanceAfter).eq(d(row.balanceBefore).plus(d(row.amount)))).toBe(true);
      expect(d(row.balanceBefore).eq(expected)).toBe(true);
      expected = d(row.balanceAfter);
    }
    expect(expected.eq(new Decimal('-20'))).toBe(true);
  });
});
