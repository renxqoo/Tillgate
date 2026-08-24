/**
 * 连接与生命周期(IMPLEMENTATION.md §4):池参数逐字段透传、无默认、closeDb 收口。
 * ping 需真实连接,由 __test__/pg.real.test.ts 覆盖。
 */
import { describe, expect, it, vi, type Mock } from 'vitest';

const { FakePool } = vi.hoisted(() => {
  class Pool {
    /** 每次构造的入参(断言透传) */
    static calls: unknown[] = [];
    /** 每次构造产生的池实例(断言 end 收口) */
    static instances: Array<{ end: Mock }> = [];
    constructor(args: unknown) {
      FakePool.calls.push(args);
      const instance = { end: vi.fn() };
      FakePool.instances.push(instance);
      // 构造器返回对象替代 this——drizzle 只需要池形态,不触真实连接
      return instance;
    }
  }
  return { FakePool: Pool };
});

vi.mock('pg', () => ({ default: { Pool: FakePool } }));

import { closeDb, createDb, ping } from '../src/client.js';
import { isInfrastructureError } from '@tillgate/errors';

const CONFIG = {
  url: 'postgres://user:pass@db.local:5432/tillgate',
  poolMax: 7,
  idleTimeoutMillis: 31_000,
  connectionTimeoutMillis: 4_000,
  maxUses: 999,
} as const;

describe('createDb(零隐藏默认,B2)', () => {
  it('池参数逐字段透传给 pg.Pool,无额外默认注入', () => {
    createDb(CONFIG);
    expect(FakePool.calls).toEqual([
      {
        connectionString: CONFIG.url,
        max: CONFIG.poolMax,
        idleTimeoutMillis: CONFIG.idleTimeoutMillis,
        connectionTimeoutMillis: CONFIG.connectionTimeoutMillis,
        maxUses: CONFIG.maxUses,
      },
    ]);
  });

  it('缺字段在类型面即编译失败(必填契约)', () => {
    // @ts-expect-error 缺 poolMax 等——零隐藏默认的类型面证明
    createDb({ url: 'postgres://x' });
    expect(true).toBe(true);
  });
});

describe('closeDb(五处 app 拷贝的收敛点,C1)', () => {
  it('调用池 end() 恰一次', async () => {
    const db = createDb(CONFIG);
    const instance = FakePool.instances.at(-1)!;
    await closeDb(db);
    expect(instance.end).toHaveBeenCalledTimes(1);
  });
});

describe('ping(§11 根契约:失败源头分类为 InfrastructureError)', () => {
  it('探测失败抛 InfrastructureError(db.unavailable),cause 链保留底层事实', async () => {
    const db = createDb(CONFIG); // FakePool 无 query 能力 → execute 必然失败
    const failure = await ping(db).catch((error: unknown) => error);
    expect(isInfrastructureError(failure)).toBe(true);
    expect((failure as { code: string }).code).toBe('db.unavailable');
  });
});
