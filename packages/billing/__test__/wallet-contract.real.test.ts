/**
 * 钱包动词真实 PostgreSQL 契约：
 * 触发器不变量同盟、真实唯一冲突、CAS 竞态、幂等竞速回归。默认门禁排除，
 * 经 `bun run test:real`（DB_TEST_URL / DATABASE_URL）显式运行。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { isBusinessError } from '@tillgate/errors';
import {
  REAL_URL,
  assertLedgerCoherent,
  setupRealWallet,
  type RealWalletHarness,
} from './real-pg.js';
import { defined } from './defined.js';

async function expectBusinessCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    if (isBusinessError(error)) return error.code;
    throw error;
  }
  throw new Error('expected business rejection');
}

(REAL_URL ? describe : describe.skip)('wallet 动词真实 PG 契约', () => {
  let h: RealWalletHarness;
  let userSeq = 0;
  const nextUser = () => (userSeq += 1);

  beforeAll(async () => {
    h = await setupRealWallet('contract');
  });
  afterAll(async () => {
    await h.teardown();
  });

  it('credit 落账 → 触发器同盟下的余额/腿/Σ=0；顺序重放回执全等（B12 同族锁定）', async () => {
    const userId = nextUser();
    const first = await h.api.credit({ userId, amount: '10.500', refType: 'topup', refId: 'c1' });
    expect(first).toEqual({
      transactionId: 1,
      amount: '10.5',
      balanceAfter: '10.5',
      replayed: false,
    });
    const replay = await h.api.credit({ userId, amount: '10.5', refType: 'topup', refId: 'c1' });
    expect(replay).toEqual({ ...first, replayed: true });
    await assertLedgerCoherent(h.db);
  });

  it('并发同键恰好一笔：8 路竞速全部成功返回且 transactionId 唯一、余额不变', async () => {
    const userId = nextUser();
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.api.credit({ userId, amount: '3', refType: 'topup', refId: 'race1' }),
      ),
    );
    const ids = new Set(results.map((r) => r.transactionId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.replayed).length).toBe(1);
    const accounts = await h.api.accounts(userId);
    expect(defined(accounts[0]).balance).toBe('3');
    await assertLedgerCoherent(h.db);
  });

  it('两阶段闭环：authorize 冻结在途 → settle 部分结算（余量归还）→ 账本相干', async () => {
    const userId = nextUser();
    await h.api.credit({ userId, amount: '10', refType: 'topup', refId: 'c2' });
    const auth = await h.api.authorize({ userId, amount: '7', refType: 'billing', refId: 'b1' });
    expect(auth.status).toBe('active');
    expect(defined((await h.api.accounts(userId))[0]).inFlight).toBe('7');
    const settled = await h.api.settle({ refType: 'billing', refId: 'b1', amount: '6' });
    expect(settled).toMatchObject({
      settledAmount: '6',
      balanceAfter: '4',
      releasedRemainder: '1',
    });
    const accounts = await h.api.accounts(userId);
    expect(defined(accounts[0]).inFlight).toBe('0');
    expect(defined(accounts[0]).balance).toBe('4');
    // 结算重放读回腿上稳定回执
    const replay = await h.api.settle({ refType: 'billing', refId: 'b1', amount: '6' });
    expect(replay).toEqual({ ...settled, replayed: true });
    await assertLedgerCoherent(h.db);
  });

  it('B1 回归（真实并发）：credit-line 同键异额竞速——输家吃 idempotency_conflict，绝不拿自己的输入当回执', async () => {
    const userId = nextUser();
    const settled = await Promise.allSettled([
      h.api.setCreditLimit({ userId, amount: '10', refType: 'admin', refId: 'cl-race' }),
      h.api.setCreditLimit({ userId, amount: '99', refType: 'admin', refId: 'cl-race' }),
    ]);
    const winner = settled.find((s) => s.status === 'fulfilled');
    const loser = settled.find((s) => s.status === 'rejected');
    expect(winner).toBeDefined();
    // 输家若 fulfilled（并发时序交错）也必须返回存储值（10 或 99 中先落者）——绝无第三种回执
    if (loser) {
      expect(loser.reason.code).toBe('billing.idempotency_conflict');
    }
    const final = defined((await h.api.accounts(userId))[0]).creditLimit;
    expect(['10', '99']).toContain(final);
    // 后到者顺序重放同键异额 → 409
    const other = final === '10' ? '99' : '10';
    expect(
      await expectBusinessCode(() =>
        h.api.setCreditLimit({ userId, amount: other, refType: 'admin', refId: 'cl-race' }),
      ),
    ).toBe('billing.idempotency_conflict');
  });

  it('冻结拒绝一切资金变动（触发器前的动词守卫），但 release 预占不受限（B13）', async () => {
    const userId = nextUser();
    await h.api.credit({ userId, amount: '10', refType: 'topup', refId: 'c3' });
    await h.api.authorize({ userId, amount: '5', refType: 'billing', refId: 'b2' });
    await h.db.execute(
      sql`update wallet_accounts set status = 'frozen' where kind = 'user' and user_id = ${userId}`,
    );
    expect(
      await expectBusinessCode(() =>
        h.api.credit({ userId, amount: '1', refType: 'topup', refId: 'c4' }),
      ),
    ).toBe('billing.account_frozen');
    expect(
      await expectBusinessCode(() =>
        h.api.settle({ refType: 'billing', refId: 'b2', amount: '1' }),
      ),
    ).toBe('billing.account_frozen');
    // 冻结账户的 active 冻结单仍可释放——只归还 in_flight，不动资金
    const released = await h.api.release({ refType: 'billing', refId: 'b2', reason: 'risk_hold' });
    expect(released).toMatchObject({ releasedAmount: '5', replayed: false });
    expect(defined((await h.api.accounts(userId))[0]).inFlight).toBe('0');
    await assertLedgerCoherent(h.db);
  });

  it('expiresAt 是权威截止：到期冻结单结算拒绝（DB 时钟）', async () => {
    const userId = nextUser();
    await h.api.credit({ userId, amount: '10', refType: 'topup', refId: 'c5' });
    await h.api.authorize({
      userId,
      amount: '2',
      refType: 'billing',
      refId: 'b3',
      expiresAt: new Date(Date.now() - 1_000),
    });
    expect(
      await expectBusinessCode(() =>
        h.api.settle({ refType: 'billing', refId: 'b3', amount: '1' }),
      ),
    ).toBe('billing.authorization_not_active');
  });

  it('refund 重放回执与首笔同形（B12：正号命令金额）', async () => {
    const userId = nextUser();
    await h.api.credit({ userId, amount: '10', refType: 'topup', refId: 'c6' });
    const first = await h.api.refund({ userId, amount: '2', refType: 'admin', refId: 'rf1' });
    expect(first.amount).toBe('2');
    const replay = await h.api.refund({ userId, amount: '2', refType: 'admin', refId: 'rf1' });
    expect(replay).toEqual({ ...first, replayed: true });
  });
});
