/**
 * 快路径基准与原子门口径（2026-08-26 增量；真 PG）：
 *   ① conditionalReserve 三档守卫（信用/现金/#over）+ frozen 拒绝（表驱动）
 *   ② 无限额并发 authorize 吞吐：同用户 50 并发在钱包原子门上串行，
 *      总墙钟远低于旧「整事务串行」基线（实测 ~128ms/事务 → 串行预期 ~6.4s）；
 *      in_flight 精确 = Σ授权，可用额守卫无击穿。
 * 不变量基线由 wallet-invariants/wallet-contract 承担，此处不重复。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, closeDb, type Db } from '@tillgate/db';
import { createPostgresWalletStore } from '../src/adapters/postgres/wallet-store.js';
import { createWalletApi } from '../src/application/wallet/wallet.js';
import type { WalletStore } from '../src/ports/wallet-store.js';

const url = process.env.DB_TEST_URL ?? process.env.DATABASE_URL;
const DB_POOL = { poolMax: 20, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 5_000 };
const RETRY = { maxAttempts: 5, baseDelayMs: 15, maxJitterMs: 20 };
const GUARDS = {
  refTypes: ['billing', 'topup', 'admin', 'test'],
  currencies: ['CNY'],
  internalAccounts: ['outside', 'platform_revenue'],
} as const;

describe.skipIf(url == null)('wallet 快路径（真 PG）', () => {
  let db: Db;
  let store: WalletStore;
  let wallet: ReturnType<typeof createWalletApi>;
  /** 跨 run 唯一用户段(测试库共享,自增计数会跨 run 撞同一用户) */
  const runTag = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

  beforeAll(async () => {
    db = createDb({ url: url as string, ...DB_POOL });
    store = createPostgresWalletStore(db, { retry: RETRY });
    wallet = createWalletApi({ store, guards: GUARDS, currency: 'CNY' });
  });
  afterAll(async () => {
    await closeDb(db).catch(() => {});
  });

  /** 独立用户 + 充值（内部账 double-entry 经 wallet.credit） */
  async function freshUser(amount: string): Promise<number> {
    const id = 900_000_000 + Math.floor(Math.random() * 90_000_000);
    await wallet.credit({
      userId: id,
      amount,
      refType: 'test',
      refId: `fp-credit-${id}-${runTag}`,
    });
    return id;
  }

  /** 门必须事务内调用(deferred coherence 在 commit 校验;直调=autocommit 立即检查必炸) */
  async function gate(input: Parameters<WalletStore['conditionalReserve']>[1]) {
    return store.transaction((tx) => store.conditionalReserve(tx, input));
  }

  it('authorize 三档守卫（完整链;信用/现金/超额拒/#over 负余额）', async () => {
    const id = await freshUser('10');
    // 信用口径:8 过;现金口径:2 过;超额:拒 insufficient_balance;#over:负余额过
    expect(
      (
        await wallet.authorize({
          userId: id,
          amount: '8',
          refType: 'test',
          refId: `fp-3a-${runTag}`,
        })
      ).status,
    ).toBe('active');
    expect(
      (
        await wallet.authorize({
          userId: id,
          amount: '2',
          refType: 'test',
          refId: `fp-3b-${runTag}`,
          allowCredit: false,
        })
      ).status,
    ).toBe('active');
    await expect(
      wallet.authorize({ userId: id, amount: '0.001', refType: 'test', refId: `fp-3c-${runTag}` }),
    ).rejects.toMatchObject({ code: 'billing.insufficient_balance' });
    expect(
      (
        await wallet.authorize({
          userId: id,
          amount: '5',
          refType: 'billing',
          refId: `fp-3d-${runTag}#over`,
          collectOverage: true,
        })
      ).status,
    ).toBe('active');
    // 自清:释放全部持有
    for (const refId of [`fp-3a-${runTag}`, `fp-3b-${runTag}`, `fp-3d-${runTag}#over`]) {
      await wallet.release({
        refType: refId.endsWith('#over') ? 'billing' : 'test',
        refId,
        reason: 'fastpath test cleanup',
      });
    }
  });

  it('frozen 账户 → 原子门 0 行（status 守卫,#over 也不借道）', async () => {
    const { sql } = await import('drizzle-orm');
    const id = await freshUser('5');
    const accountId = await store.transaction((tx) => store.ensureUserAccount(tx, id, 'CNY'));
    await db.execute(
      sql`update wallet_accounts set status = 'frozen' where id = ${accountId}::uuid`,
    );
    expect(
      await gate({ accountId, amount: '1', guardKind: 'credit', collectOverage: false }),
    ).toBeNull();
    expect(
      await gate({ accountId, amount: '1', guardKind: 'credit', collectOverage: true }),
    ).toBeNull();
  });

  it('无限额 50 并发 authorize：钱包原子门串行吞吐（in_flight 精确、全部成功）', async () => {
    const id = await freshUser('50');
    const refIds = Array.from({ length: 50 }, (_, i) => `fp-bench-${Date.now()}-${i}`);
    const start = Date.now();
    /** 单次授权的结局(失败归一为 failed,断言统一) */
    const outcomeOf = async (refId: string): Promise<string> => {
      try {
        return (await wallet.authorize({ userId: id, amount: '1', refType: 'test', refId })).status;
      } catch {
        return 'failed';
      }
    };
    const results = await Promise.all(refIds.map((refId) => outcomeOf(refId)));
    const wall = Date.now() - start;
    expect(results.every((status) => status === 'active')).toBe(true);
    const accounts = await wallet.accounts(id);
    const account = accounts.find((a) => a.currency === 'CNY');
    expect(account?.inFlight).toBe('50');
    // 快路径断言：远低于旧整事务串行基线(实测 ~128ms/事务 → 串行 ~6.4s)。
    // 阈值取 3s(≈15×加速)——留机器负载余量,只锁量级不锁毫秒。
    expect(wall).toBeLessThan(3_000);
    // 清场:释放全部持有(走 release 语义,防跨用例残留)
    await Promise.all(
      refIds.map((refId) =>
        wallet.release({ refType: 'test', refId, reason: 'fastpath bench cleanup' }),
      ),
    );
  });
});
