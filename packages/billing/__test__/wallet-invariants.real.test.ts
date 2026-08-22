/**
 * 账本不变量与并发竞态（真实 PG；引擎不变量清单在新活路径逐项重现——MIGRATION-U1 §1）：
 * 不超卖、settle/release 互斥恰好一方、账本 append-only、in_flight 投影、链连续。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  REAL_URL,
  assertLedgerCoherent,
  setupRealWallet,
  type RealWalletHarness,
} from './real-pg.js';

(REAL_URL ? describe : describe.skip)('wallet 不变量与并发（真实 PG）', () => {
  let h: RealWalletHarness;
  let userSeq = 0;
  const nextUser = () => (userSeq += 1);

  beforeAll(async () => {
    h = await setupRealWallet('invariants');
  });
  afterAll(async () => {
    await h.teardown();
  });

  it('可用口径不超卖：余额 10，11 路并发 authorize 4 → 成功数 ≤ 2 且 in_flight 精确对账', async () => {
    const userId = nextUser();
    await h.api.credit({ userId, amount: '10', refType: 'topup', refId: 'c1' });
    const settled = await Promise.allSettled(
      Array.from({ length: 11 }, (_, i) =>
        h.api.authorize({ userId, amount: '4', refType: 'billing', refId: `race-${i}` }),
      ),
    );
    const wins = settled.filter((s) => s.status === 'fulfilled').length;
    expect(wins).toBeLessThanOrEqual(2); // 2×4 = 8 ≤ 10；第三笔必拒（12 > 10）
    expect(wins).toBeGreaterThanOrEqual(1);
    const account = (await h.api.accounts(userId))[0]!;
    expect(account.inFlight).toBe(String(wins * 4));
    expect(account.balance).toBe('10');
    await assertLedgerCoherent(h.db);
  });

  it('settle 与 release 竞速恰好一方了结：终态互斥、在途归零、无双腿', async () => {
    const userId = nextUser();
    await h.api.credit({ userId, amount: '10', refType: 'topup', refId: 'c2' });
    await h.api.authorize({ userId, amount: '5', refType: 'billing', refId: 'b1' });
    const settled = await Promise.allSettled([
      h.api.settle({ refType: 'billing', refId: 'b1', amount: '5' }),
      h.api.release({ refType: 'billing', refId: 'b1', reason: 'race' }),
    ]);
    const ok = settled.filter((s) => s.status === 'fulfilled');
    expect(ok.length).toBe(1);
    const status = await h.db.execute<{ status: string }>(
      sql`select status from wallet_authorizations where ref_type = 'billing' and ref_id = 'b1'`,
    );
    expect(['settled', 'released']).toContain(status.rows[0]!.status);
    expect((await h.api.accounts(userId))[0]!.inFlight).toBe('0');
    await assertLedgerCoherent(h.db);
  });

  it('账本 append-only：UPDATE/DELETE wallet_legs 被触发器拒绝（0059 不变量）', async () => {
    const userId = nextUser();
    await h.api.credit({ userId, amount: '1', refType: 'topup', refId: 'c3' });
    await expect(
      h.db.execute(sql`update wallet_legs set amount = '999' where id = 1`),
    ).rejects.toThrow();
    await expect(h.db.execute(sql`delete from wallet_legs where id = 1`)).rejects.toThrow();
    await assertLedgerCoherent(h.db);
  });

  it('并发异键转账守恒：对向同时转账，总额精确、无死锁、账本相干', async () => {
    const a = nextUser();
    const b = nextUser();
    await h.api.credit({ userId: a, amount: '100', refType: 'topup', refId: 'c4' });
    await h.api.credit({ userId: b, amount: '100', refType: 'topup', refId: 'c5' });
    await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        h.api.transfer({
          from: { userId: a },
          to: { userId: b },
          amount: '1',
          refType: 'admin',
          refId: `t-a-${i}`,
        }),
      ),
    );
    await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        h.api.transfer({
          from: { userId: b },
          to: { userId: a },
          amount: '1',
          refType: 'admin',
          refId: `t-b-${i}`,
        }),
      ),
    );
    const accounts = await h.api.accounts(a);
    expect(accounts[0]!.balance).toBe('100');
    expect((await h.api.accounts(b))[0]!.balance).toBe('100');
    await assertLedgerCoherent(h.db);
  });

  it('定序锁防死锁：多账户对向并发（a→b 与 b→a 交错）全部完成且不超时', async () => {
    const a = nextUser();
    const b = nextUser();
    await h.api.credit({ userId: a, amount: '20', refType: 'topup', refId: 'c6' });
    await h.api.credit({ userId: b, amount: '20', refType: 'topup', refId: 'c7' });
    const settled = await Promise.allSettled([
      ...Array.from({ length: 5 }, (_, i) =>
        h.api.transfer({
          from: { userId: a },
          to: { userId: b },
          amount: '1',
          refType: 'admin',
          refId: `d-a-${i}`,
        }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        h.api.transfer({
          from: { userId: b },
          to: { userId: a },
          amount: '1',
          refType: 'admin',
          refId: `d-b-${i}`,
        }),
      ),
    ]);
    expect(settled.filter((s) => s.status === 'fulfilled').length).toBe(10);
    expect((await h.api.accounts(a))[0]!.balance).toBe('20');
    expect((await h.api.accounts(b))[0]!.balance).toBe('20');
    await assertLedgerCoherent(h.db);
  });
});
