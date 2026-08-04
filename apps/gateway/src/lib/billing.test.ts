import { describe, expect, it, vi } from 'vitest';
import { BillingService } from './billing.js';
import type { Db } from '@ai-gateway/db';

/**
 * Redis 高可用容错测试：
 *   - billing.hold Redis 不可用时 → fail-open（降级放行，不抛错导致全站 500）
 *   - billing.getBalance Redis 不可用时 → 从 DB 兜底
 *   - billing.release Redis 不可用时 → 静默失败（hold TTL 10min 兜底）
 *
 * 策略：Redis 不可用时宁可漏扣（worker 结算时 DB 权威兜底）也不能全站宕机。
 * 用 mock Redis 模拟连接失败。
 */

/** 模拟 Redis 不可用（所有方法抛 ConnectionError） */
const rejectConnRefused = (): Promise<never> => Promise.reject(new Error('ECONNREFUSED'));
function makeFailingRedis() {
  return {
    get: vi.fn(rejectConnRefused),
    set: vi.fn(rejectConnRefused),
    setnx: vi.fn(rejectConnRefused),
    del: vi.fn(rejectConnRefused),
    incrby: vi.fn(rejectConnRefused),
    expire: vi.fn(rejectConnRefused),
    evalsha: vi.fn(rejectConnRefused),
    script: vi.fn(rejectConnRefused),
    ttl: vi.fn(rejectConnRefused),
    pttl: vi.fn(rejectConnRefused),
    quit: vi.fn(() => Promise.resolve()),
  };
}

const mockDb = {} as Db;

describe('BillingService Redis 容错', () => {
  it('hold Redis 失败 → fail-open 返回 {ok:true, degraded:true}（不抛错）', async () => {
    const redis = makeFailingRedis();
    const billing = new BillingService(redis as never, mockDb, 600_000);
    // Redis 全部失败 → hold 应降级而非抛错
    const result = await billing.hold(1, 'req-1', 1000);
    expect(result.ok).toBe(true); // fail-open 放行
    expect(result.degraded).toBe(true); // 标记降级（供日志/指标）
  });

  it('getBalance Redis 失败 → 从 DB 兜底（查 DB users.balance）', async () => {
    const redis = makeFailingRedis();
    const dbMock = {
      query: {
        users: {
          findFirst: vi.fn().mockResolvedValue({ balance: 99999 }),
        },
      },
    } as unknown as Db;
    const billing = new BillingService(redis as never, dbMock, 600_000);
    const balance = await billing.getBalance(1);
    expect(balance).toBe(99999); // 从 DB 拿到余额
  });

  it('release Redis 失败 → 静默返回（不抛错，hold TTL 兜底）', async () => {
    const redis = makeFailingRedis();
    const billing = new BillingService(redis as never, mockDb, 600_000);
    // release 失败不应抛错（hold TTL 10min 会自然过期）
    const result = await billing.release(1, 'req-1');
    expect(result).toBe(-1); // -1 = hold 不存在（降级语义）
  });

  it('Redis 恢复后正常工作（非永久降级）', async () => {
    // 用可切换的 mock：先失败后恢复
    let failing = true;
    const redis = {
      get: vi.fn(() => failing ? Promise.reject(new Error('down')) : Promise.resolve('5000')),
      set: vi.fn(() => Promise.resolve('OK')),
      setnx: vi.fn(() => failing ? Promise.reject(new Error('down')) : Promise.resolve(1)),
      del: vi.fn(() => Promise.resolve(1)),
      evalsha: vi.fn(() => failing ? Promise.reject(new Error('down')) : Promise.resolve(4000)),
      script: vi.fn(() => Promise.resolve('sha-dummy')),
      ttl: vi.fn(() => Promise.resolve(-2)),
      pttl: vi.fn(() => Promise.resolve(-2)),
      incrby: vi.fn(() => Promise.resolve(1)),
      expire: vi.fn(() => Promise.resolve(1)),
      quit: vi.fn(() => Promise.resolve()),
    };
    const billing = new BillingService(redis as never, mockDb, 600_000);
    // Redis down → fail-open
    const r1 = await billing.hold(1, 'req-a', 100);
    expect(r1.ok).toBe(true);
    expect(r1.degraded).toBe(true);
    // Redis 恢复 → 正常 hold
    failing = false;
    const r2 = await billing.hold(1, 'req-b', 100);
    expect(r2.ok).toBe(true);
  });
});
