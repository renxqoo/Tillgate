// wallet 并发：资金安全竞态 → 模块化测试（源自 wallet.test.ts 拆分）

import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { createWallet } from '../wallet';
import { wallet, nextUser, ref, sameAmount, accountOf } from './helpers';
import { AuthorizationNotActiveError } from '../index';
import { describe, expect, it } from 'vitest';
describe('并发：资金安全竞态', () => {
  it('10 路并发同键入账：恰好 1 笔交易、9 路重放、余额只加一次', async () => {
    const user = nextUser();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 'n10') }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(sameAmount(await wallet.balance(user), '10')).toBe(true);
  });

  it('可用额度不被超卖：余额 10 下 11 路并发 authorize 1 元——恰好成功 10 路', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '10', refType: 'topup', refId: ref(user, 't') });
    const results = await Promise.allSettled(
      Array.from({ length: 11 }, (_, i) =>
        wallet.authorize({ userId: user, amount: '1', refType: 'order', refId: `${ref(user, 'sell')}-${i}` }),
      ),
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    expect(fulfilled).toBe(10);
    const account = await accountOf(user);
    expect(sameAmount(account.inFlight, '10')).toBe(true);
    expect(sameAmount(account.balance, '10')).toBe(true); // 余额未被冻结动过
  });

  it('并发 settle vs release 同一冻结单：恰好一方终态化，资金与状态一致', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    await wallet.authorize({ userId: user, amount: '40', refType: 'order', refId: ref(user, 'duel') });
    const [settleRes, releaseRes] = await Promise.allSettled([
      wallet.settle({ refType: 'order', refId: ref(user, 'duel'), amount: '40' }),
      wallet.release({ refType: 'order', refId: ref(user, 'duel') }),
    ]);
    const settledWon = settleRes.status === 'fulfilled';
    if (settledWon) {
      expect(releaseRes.status === 'rejected' || (releaseRes.value as { replayed: boolean }).replayed).toBeTruthy();
      expect(sameAmount(await wallet.balance(user), '60')).toBe(true);
    } else {
      expect(settleRes.reason).toBeInstanceOf(AuthorizationNotActiveError);
      expect(sameAmount(await wallet.balance(user), '100')).toBe(true);
    }
    const account = await accountOf(user);
    expect(sameAmount(account.inFlight, '0')).toBe(true); // 无论谁赢，在途必归零
  });

  it('并发对向转账（A→B 与 B→A）：定序锁防死锁，双方守恒', async () => {
    const a = nextUser();
    const b = nextUser();
    await wallet.credit({ userId: a, amount: '10', refType: 'topup', refId: ref(a, 't') });
    await wallet.credit({ userId: b, amount: '10', refType: 'topup', refId: ref(b, 't') });
    // 若有死锁，vitest 默认 10s 超时即失败
    await Promise.all([
      wallet.transfer({ from: { userId: a }, to: { userId: b }, amount: '5', refType: 'p2p', refId: ref(a, 'ab') }),
      wallet.transfer({ from: { userId: b }, to: { userId: a }, amount: '5', refType: 'p2p', refId: ref(b, 'ba') }),
    ]);
    expect(sameAmount(await wallet.balance(a), '10')).toBe(true);
    expect(sameAmount(await wallet.balance(b), '10')).toBe(true);
  });

  it('并发同键 transfer：恰好一次，双腿不重复', async () => {
    const a = nextUser();
    const b = nextUser();
    await wallet.credit({ userId: a, amount: '10', refType: 'topup', refId: ref(a, 't') });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        wallet.transfer({ from: { userId: a }, to: { userId: b }, amount: '4', refType: 'p2p', refId: ref(a, 'tr5') }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(sameAmount(await wallet.balance(a), '6')).toBe(true);
    expect(sameAmount(await wallet.balance(b), '4')).toBe(true);
  });


  it('8 路真并发同键 authorize：恰好一张冻结单（含唯一索引竞态兜底路径）', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    // 独立大池制造真并发窗口（共享池 max 3 会把竞态串行化成快速路径）
    const racePool = new Pool({
      connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/ai_gateway',
      max: 8,
    });
    const raceWallet = createWallet(drizzle(racePool));
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          raceWallet.authorize({ userId: user, amount: '5', refType: 'order', refId: ref(user, 'race8') }),
        ),
      );
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(new Set(results.map((r) => r.authorizationId)).size).toBe(1);
      const account = await accountOf(user);
      expect(sameAmount(account.inFlight, '5')).toBe(true);
    } finally {
      await racePool.end();
    }
  });

  it('并发不同键入账 20 路：总额精确（顺序无关）', async () => {
    const user = nextUser();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        wallet.credit({ userId: user, amount: '0.15', refType: 'topup', refId: `${ref(user, 'sum')}-${i}` }),
      ),
    );
    expect(sameAmount(await wallet.balance(user), '3')).toBe(true); // 20 × 0.15
  });

  it('并发同键 refund：恰好一次退款', async () => {
    const user = nextUser();
    await wallet.credit({ userId: user, amount: '100', refType: 'topup', refId: ref(user, 't') });
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        wallet.refund({ userId: user, amount: '30', refType: 'topup_refund', refId: ref(user, 'rf5') }),
      ),
    );
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(sameAmount(await wallet.balance(user), '70')).toBe(true);
  });
});
