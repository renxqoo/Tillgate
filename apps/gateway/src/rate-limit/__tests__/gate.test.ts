/**
 * 限流闸单元测试：免费日限的 Redis 语义（忠实 eval 假件——INCR+首置 EXPIRE）、
 * 计数器故障 fail-closed、output-cap 优先级口径。
 */
import { describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { createFreeDailyGate } from '../gate.js';
import { maxOutputTokens } from '../../pipeline/output-cap.js';

/** 忠实假件：实现 createFreeDailyGate 用到的 eval(INCR+EXPIRE) 子集 */
function fakeRedis(plan: { failEval?: boolean } = {}): { redis: Redis; store: Map<string, number> } {
  const store = new Map<string, number>();
  const redis = {
    async eval(_script: string, _numKeys: number, key: string): Promise<number> {
      if (plan.failEval) throw new Error('redis down');
      const next = (store.get(key) ?? 0) + 1;
      store.set(key, next);
      return next;
    },
  } as unknown as Redis;
  return { redis, store };
}

describe('免费模型日限（createFreeDailyGate）', () => {
  it('窗口内超限：第 N+1 次拒绝且 retryAfter 指向本地次日零点', async () => {
    const { redis } = fakeRedis();
    const gate = createFreeDailyGate(redis, 2);
    expect(await gate.check(1)).toMatchObject({ ok: true });
    expect(await gate.check(1)).toMatchObject({ ok: true });
    const denied = await gate.check(1);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.code).toBe('limit');
      const secondsToMidnight = Math.ceil((new Date(new Date().setHours(24, 0, 0, 0)).getTime() - Date.now()) / 1000);
      expect(denied.retryAfterSec).toBeLessThanOrEqual(secondsToMidnight + 1);
      expect(denied.retryAfterSec).toBeGreaterThan(0);
    }
  });

  it('用户维度隔离（各自独立计数）', async () => {
    const { redis } = fakeRedis();
    const gate = createFreeDailyGate(redis, 1);
    expect((await gate.check(10)).ok).toBe(true);
    expect((await gate.check(20)).ok).toBe(true); // 另一用户不受影响
    expect((await gate.check(10)).ok).toBe(false);
  });

  it('计数器故障 fail-closed：拒绝放行（code=counter）', async () => {
    const { redis } = fakeRedis({ failEval: true });
    const gate = createFreeDailyGate(redis, 100);
    const result = await gate.check(1);
    expect(result).toMatchObject({ ok: false, code: 'counter' });
  });
});

describe('输出上界口径（maxOutputTokens）', () => {
  const config = { defaultMax: 4_096, exposureCap: 32_768 };

  it('max_completion_tokens 优先于 max_tokens，均无取装配缺省；×n 倍数；封顶 exposureCap', () => {
    expect(maxOutputTokens({}, config)).toBe(4_096);
    expect(maxOutputTokens({ max_tokens: 100 }, config)).toBe(100);
    expect(maxOutputTokens({ max_tokens: 100, max_completion_tokens: 200 }, config)).toBe(200);
    expect(maxOutputTokens({ max_tokens: 1_000, n: 3 }, config)).toBe(3_000);
    expect(maxOutputTokens({ max_tokens: 1_000_000 }, config)).toBe(32_768);
    expect(maxOutputTokens({ max_tokens: 1_000, n: 0 }, config)).toBe(1_000); // n 非法按 1
  });
});
