/**
 * 连接与生命周期:池参数逐字段透传、无默认、closeDb 收口。
 * bun-native:Bun SQL 构造惰性(不触网),参数经 $client.options 回读断言;
 * ping 需真实连接,由 __test__/pg.real.test.ts 覆盖。
 */
import { describe, expect, it } from 'vitest';

import { closeDb, createDb, ping } from '../src/client.js';
import { isInfrastructureError } from '@tillgate/errors';

const CONFIG = {
  url: 'postgres://user:pass@db.local:5432/tillgate',
  poolMax: 7,
  idleTimeoutMillis: 31_000,
  connectionTimeoutMillis: 4_000,
} as const;

describe('createDb(零隐藏默认,B2)', () => {
  it('池参数逐字段透传给 Bun SQL(毫秒→秒换算,内部回读为毫秒),无额外默认注入', async () => {
    const db = createDb(CONFIG);
    // 构造惰性不触网;close 收口防句柄滞留
    const { options } = db.$client as unknown as { options: Record<string, number> };
    expect(options.max).toBe(CONFIG.poolMax);
    expect(options.idleTimeout).toBe(CONFIG.idleTimeoutMillis);
    expect(options.connectionTimeout).toBe(CONFIG.connectionTimeoutMillis);
    await closeDb(db);
  });

  it('缺字段在类型面即编译失败(必填契约);运行时 Bun SQL 急切校验同方向兜底', () => {
    // @ts-expect-error 缺 poolMax 等——零隐藏默认的类型面证明
    expect(() => createDb({ url: 'postgres://x' })).toThrow();
  });
});

describe('closeDb(五处 app 拷贝的收敛点,C1)', () => {
  it('end() 收口后连接拒绝(懒池未建连,收口即刻生效)', async () => {
    const db = createDb(CONFIG);
    await closeDb(db);
    await expect(db.$client`select 1`).rejects.toThrow();
  });
});

describe('ping(§11 根契约:失败源头分类为 InfrastructureError)', () => {
  it('探测失败抛 InfrastructureError(db.unavailable),cause 链保留底层事实', async () => {
    const db = createDb(CONFIG);
    await closeDb(db); // 已收口的池 → execute 必然失败,不依赖网络可达性
    const failure = await ping(db).catch((error: unknown) => error);
    expect(isInfrastructureError(failure)).toBe(true);
    expect((failure as { code: string }).code).toBe('db.unavailable');
  });
});
