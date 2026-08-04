import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../../src/breaker/breaker.js';
import { MemoryBreakerStorage } from '../../src/breaker/memory-storage.js';
import type { BreakerConfig } from '../../src/breaker/breaker.js';

const config: BreakerConfig = {
  windowMs: 60_000,
  failureThreshold: 3,
  cooldownMs: 30_000,
  halfOpenProbe: true,
};

function makeBreaker(now: () => number) {
  return new CircuitBreaker('test-channel', config, new MemoryBreakerStorage(), now);
}

describe('CircuitBreaker', () => {
  it('closed：放行；失败未达阈值保持 closed', async () => {
    let t = 1000;
    const b = makeBreaker(() => t);
    expect(await b.canRequest()).toBe(true);
    await b.recordFailure({ circuitTrip: true });
    await b.recordFailure({ circuitTrip: true });
    expect(await b.canRequest()).toBe(true);
  });

  it('窗口内失败达阈值 → open，拒绝请求', async () => {
    let t = 1000;
    const b = makeBreaker(() => t);
    for (let i = 0; i < 3; i++) await b.recordFailure({ circuitTrip: true });
    expect(await b.canRequest()).toBe(false);
  });

  it('窗口滑动：旧失败过期后不计数', async () => {
    let t = 1000;
    const b = makeBreaker(() => t);
    for (let i = 0; i < 2; i++) await b.recordFailure({ circuitTrip: true });
    t += 61_000; // 超过窗口
    await b.recordFailure({ circuitTrip: true }); // 旧失败已过期，只剩 1 次
    expect(await b.canRequest()).toBe(true);
  });

  it('circuitTrip=false（429/4xx/死凭据）不计数，永不跳闸', async () => {
    let t = 1000;
    const b = makeBreaker(() => t);
    for (let i = 0; i < 10; i++) await b.recordFailure({ circuitTrip: false });
    expect(await b.canRequest()).toBe(true);
  });

  it('冷却到期 → half-open 放行探测；探测成功 → 恢复 closed', async () => {
    let t = 1000;
    const b = makeBreaker(() => t);
    for (let i = 0; i < 3; i++) await b.recordFailure({ circuitTrip: true });
    expect(await b.canRequest()).toBe(false);

    t += 30_000; // 冷却到期
    expect(await b.canRequest()).toBe(true); // half-open 探测放行
    await b.recordSuccess();
    expect(await b.canRequest()).toBe(true); // 恢复 closed
  });

  it('half-open 探测失败 → 立即回 open（再拒绝）', async () => {
    let t = 1000;
    const b = makeBreaker(() => t);
    for (let i = 0; i < 3; i++) await b.recordFailure({ circuitTrip: true });

    t += 30_000;
    expect(await b.canRequest()).toBe(true);
    await b.recordFailure({ circuitTrip: true }); // 探测失败
    expect(await b.canRequest()).toBe(false);
  });

  it('不同 key 状态隔离', async () => {
    let t = 1000;
    const storage = new MemoryBreakerStorage();
    const a = new CircuitBreaker('channel-a', config, storage, () => t);
    const b = new CircuitBreaker('channel-b', config, storage, () => t);
    for (let i = 0; i < 3; i++) await a.recordFailure({ circuitTrip: true });
    expect(await a.canRequest()).toBe(false);
    expect(await b.canRequest()).toBe(true);
  });
});

describe('MemoryBreakerStorage', () => {
  it('缺失 key → null；TTL 过期 → null', async () => {
    const s = new MemoryBreakerStorage();
    expect(await s.getState('x')).toBeNull();
    const state = {
      state: 'open' as const,
      failures: [],
      windowStart: 0,
      cooldownUntil: Date.now() + 1000,
    };
    await s.setState('x', state, 5);
    expect(await s.getState('x')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(await s.getState('x')).toBeNull();
  });
});
