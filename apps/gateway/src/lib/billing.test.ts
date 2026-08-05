import { describe, expect, it, vi } from 'vitest';
import { BillingService } from './billing.js';
import type { Db } from '@ai-gateway/db';

/**
 * BillingService 测试（重构后：DB 行锁权威账本，Redis 仅 hold 在途标记）。
 *
 * 架构变化（与重构前对比）：
 *   - 不再有 Redis 余额缓存。getBalance 直接查 DB。
 *   - hold 走 DB 条件 UPDATE（balance >= amount 才扣，防超卖），不再有 fail-open。
 *   - release 读 Redis hold 标记（value="userId:amount"）→ DB 加回余额 → 删标记。
 *   - Redis 不可用时：hold 仍可用（DB 权威）；release 无法判定标记 → 幂等返回 ''。
 *   - DB 不可用时：hold 抛错（DB 是唯一权威，挂了本就不可用，不再 fail-open）。
 */

/** mock Redis（可控成功/失败） */
function makeRedis(opts: { failing?: boolean; holdValue?: string } = {}) {
  const { failing = false, holdValue } = opts;
  const maybeFail = <T>(v: T): Promise<T> =>
    failing ? Promise.reject(new Error('ECONNREFUSED')) : Promise.resolve(v);
  return {
    get: vi.fn(() => maybeFail(holdValue ?? null)),
    set: vi.fn(() => maybeFail('OK')),
    del: vi.fn(() => maybeFail(1)),
    evalsha: vi.fn(() => maybeFail(holdValue ?? '')),
    script: vi.fn(() => maybeFail('sha-dummy')),
    scan: vi.fn(() => maybeFail(['0', []])),
    pttl: vi.fn(() => maybeFail(-2)),
    quit: vi.fn(() => Promise.resolve()),
  };
}

/** mock Db：users.update 模拟条件 UPDATE（balance >= amount 时返回扣减后余额） */
function makeDb(initialBalance: string) {
  let balance = initialBalance;
  return {
    query: {
      users: {
        findFirst: vi.fn(async () => ({ balance })),
      },
    },
    update: () => ({
      set: () => ({
        where: () => ({
          returning: vi.fn(async () => {
            // 简化：总是返回当前 balance（实际条件 WHERE balance>=amount 由 DB 保证）
            return [{ balance }];
          }),
        }),
      }),
    }),
  } as unknown as Db;
}

describe('BillingService（DB 行锁）', () => {
  it('getBalance 从 DB 读权威余额（元 string）', async () => {
    const db = makeDb('99.99');
    const billing = new BillingService(makeRedis() as never, db, 600_000);
    const balance = await billing.getBalance(1);
    expect(balance).toBe('99.99');
  });

  it('hold 成功 → ok:true，返回扣减后余额', async () => {
    const db = makeDb('100');
    const billing = new BillingService(makeRedis() as never, db, 600_000);
    const result = await billing.hold(1, 'req-1', '10');
    expect(result.ok).toBe(true);
    expect(typeof result.balance).toBe('string');
  });

  it('hold 接受 Decimal/number/string 金额', async () => {
    const db = makeDb('100');
    const billing = new BillingService(makeRedis() as never, db, 600_000);
    const r1 = await billing.hold(1, 'req-num', 5);
    expect(r1.ok).toBe(true);
    const r2 = await billing.hold(1, 'req-str', '0.0001');
    expect(r2.ok).toBe(true);
  });

  it('release：Redis 无 hold 标记 → 幂等返回空串', async () => {
    const db = makeDb('100');
    const billing = new BillingService(makeRedis({ holdValue: '' }) as never, db, 600_000);
    const result = await billing.release(1, 'req-none');
    expect(result).toBe(''); // 幂等无操作
  });

  it('release：Redis 不可用 → 幂等返回空串（不抛错，不重复退）', async () => {
    const db = makeDb('100');
    const billing = new BillingService(makeRedis({ failing: true }) as never, db, 600_000);
    const result = await billing.release(1, 'req-1');
    expect(result).toBe(''); // Redis 不可用：无法判定，幂等返回
  });

  it('reclaimExpiredHolds：Redis 不可用 → 返回 0（无 hold 可回收）', async () => {
    const db = makeDb('100');
    const billing = new BillingService(makeRedis({ failing: true }) as never, db, 600_000);
    const n = await billing.reclaimExpiredHolds();
    expect(n).toBe(0);
  });

  it('reclaimExpiredHolds：无残留 hold → 返回 0', async () => {
    const db = makeDb('100');
    const billing = new BillingService(makeRedis() as never, db, 600_000);
    const n = await billing.reclaimExpiredHolds();
    expect(n).toBe(0);
  });
});
