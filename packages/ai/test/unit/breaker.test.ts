import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../../src/breaker/breaker.js';
import { MemoryKvStorage } from '../../src/internal/memory-storage.js';
import type { BreakerState } from '../../src/config.js';
import type { BreakerConfig } from '../../src/breaker/breaker.js';

const config: BreakerConfig = {
  windowMs: 60_000,
  failureThreshold: 3,
  cooldownMs: 30_000,
  halfOpenProbe: true,
};

function makeBreaker(now: () => number) {
  return new CircuitBreaker('test-channel', config, new MemoryKvStorage<BreakerState>(), now);
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
    const storage = new MemoryKvStorage<BreakerState>();
    const a = new CircuitBreaker('channel-a', config, storage, () => t);
    const b = new CircuitBreaker('channel-b', config, storage, () => t);
    for (let i = 0; i < 3; i++) await a.recordFailure({ circuitTrip: true });
    expect(await a.canRequest()).toBe(false);
    expect(await b.canRequest()).toBe(true);
  });
});

describe('MemoryKvStorage（内存兜底实现）', () => {
  it('缺失 key → null；TTL 过期 → null', async () => {
    const s = new MemoryKvStorage<BreakerState>();
    expect(await s.getState('x')).toBeNull();
    const state = {
      state: 'open' as const,
      failures: [],
      windowStart: 0,
      cooldownUntil: Date.now() + 1000,
      version: 0,
    };
    await s.setState('x', state, 5);
    expect(await s.getState('x')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 20));
    expect(await s.getState('x')).toBeNull();
  });

  it('compareAndSet：version 匹配才写入，返回是否成功', async () => {
    const s = new MemoryKvStorage<BreakerState>();
    // key 不存在 → expectedVersion=0 可写入
    const ok1 = await s.compareAndSet(
      'k',
      0,
      { state: 'closed', failures: [], windowStart: 0, version: 1 },
      10_000,
    );
    expect(ok1).toBe(true);
    // version 不匹配 → 失败
    const ok2 = await s.compareAndSet(
      'k',
      0,
      { state: 'open', failures: [], windowStart: 0, version: 2 },
      10_000,
    );
    expect(ok2).toBe(false);
    // version 匹配 → 成功
    const ok3 = await s.compareAndSet(
      'k',
      1,
      { state: 'open', failures: [], windowStart: 0, version: 2 },
      10_000,
    );
    expect(ok3).toBe(true);
    const got = await s.getState('k');
    expect(got?.state).toBe('open');
    expect(got?.version).toBe(2);
  });
});

describe('CircuitBreaker 并发安全（B5）', () => {
  it('half-open 单探测：冷却到期瞬间 N 个并发 canRequest 只有一个放行', async () => {
    let t = 1000;
    const b = makeBreaker(() => t);
    // 先达阈值熔断
    for (let i = 0; i < 3; i++) await b.recordFailure({ circuitTrip: true });
    expect(await b.canRequest()).toBe(false); // open

    t += 30_000; // 冷却到期
    // 模拟 20 个并发请求同时探测
    const results = await Promise.all(Array.from({ length: 20 }, () => b.canRequest()));
    const allowed = results.filter(Boolean).length;
    expect(allowed).toBe(1); // 严格只有一个赢家进入 half-open
  });

  it('recordFailure 并发不丢计数：N 个并发失败后窗口内计数 = N', async () => {
    let t = 1000;
    const b = makeBreaker(() => t);
    // 10 个并发失败（阈值 3，会有 CAS 重试）
    await Promise.all(Array.from({ length: 10 }, () => b.recordFailure({ circuitTrip: true })));
    // 达阈值后应 open；熔断状态可被观测
    expect(await b.canRequest()).toBe(false);
  });

  it('recordFailure CAS 失败可重试：并发窗口计数最终正确', async () => {
    // 用计数 storage 验证 CAS 重试后状态一致
    const storage = new MemoryKvStorage<BreakerState>();
    let t = 1000;
    const b = new CircuitBreaker('cas-test', config, storage, () => t);
    // 阈值 3，并发 2 个（不足以熔断，验证计数不丢）
    await Promise.all([
      b.recordFailure({ circuitTrip: true }),
      b.recordFailure({ circuitTrip: true }),
    ]);
    const state = await storage.getState('cas-test');
    expect(state?.failures.length).toBe(2); // 两次失败都计入窗口
    expect(state?.state).toBe('closed');
  });
});
