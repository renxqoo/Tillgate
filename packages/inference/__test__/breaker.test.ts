import { describe, expect, it } from 'vitest';
import { createCircuitBreaker } from '../src/health/breaker';
import { createMemoryHealthStore } from '../src/adapters/state-memory';
import type { BreakerState } from '../src/health/breaker';
import type { HealthStore } from '../src/ports/state';

const config = { windowMs: 60_000, failureThreshold: 3, cooldownMs: 300_000, halfOpenProbe: true };

function breakerOf(store: HealthStore, now: () => number) {
  return createCircuitBreaker({ key: 'k', config, store, now });
}

async function stateOf(store: HealthStore): Promise<BreakerState | null> {
  return await store.getState<BreakerState>('k');
}

describe('health/breaker：closed/open/half-open 状态机（v1 迁移）', () => {
  it('closed：窗口内失败达阈值 → open（cooldownUntil=now+cooldown）；成功无副作用', async () => {
    let now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const breaker = breakerOf(store, () => now);
    expect(await breaker.canRequest()).toBe(true);
    await breaker.recordFailure({ circuitTrip: true });
    now += 10_000;
    await breaker.recordFailure({ circuitTrip: true });
    now += 10_000;
    await breaker.recordSuccess(); // closed 状态成功无意义
    await breaker.recordFailure({ circuitTrip: true });
    const state = await stateOf(store);
    expect(state?.state).toBe('open');
    expect(state?.cooldownUntil).toBe(now + config.cooldownMs);
    expect(state?.failures).toEqual([]);
  });

  it('circuitTrip=false（429/4xx/死凭据）不计数——坏 Key 不熔断渠道', async () => {
    const store = createMemoryHealthStore();
    const breaker = breakerOf(store, () => 1_000_000);
    for (let i = 0; i < 10; i++) await breaker.recordFailure({ circuitTrip: false });
    expect((await stateOf(store))?.state ?? 'closed').toBe('closed');
  });

  it('open：冷却内拒绝；冷却到期 CAS→half-open 且只有单赢家放行', async () => {
    let now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    // 手工构造 open 态
    await store.compareAndSet<BreakerState>(
      'k',
      0,
      {
        state: 'open',
        failures: [],
        windowStart: now,
        openedAt: now,
        cooldownUntil: now + 60_000,
        version: 1,
      },
      1_000_000,
    );
    const a = breakerOf(store, () => now);
    const b = breakerOf(store, () => now);
    now += 30_000; // 冷却内
    expect(await a.canRequest()).toBe(false);
    now += 31_000; // 冷却到期
    expect(await a.canRequest()).toBe(true); // CAS 赢家（open→half-open）
    expect(await b.canRequest()).toBe(false); // 其他人：half-open 拒绝（单探测）
    expect((await stateOf(store))?.state).toBe('half-open');
  });

  it('half-open：探测成功 → 恢复 closed 清窗口；探测失败 → 重开并重置冷却', async () => {
    const now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    await store.compareAndSet<BreakerState>(
      'k',
      0,
      {
        state: 'open',
        failures: [],
        windowStart: now,
        openedAt: now,
        cooldownUntil: now,
        version: 1,
      },
      1_000_000,
    );
    const breaker = breakerOf(store, () => now);
    expect(await breaker.canRequest()).toBe(true); // 进 half-open
    await breaker.recordSuccess();
    expect((await stateOf(store))?.state).toBe('closed');
    // closed 后窗口已清：需重新累计满阈值才再开（探测成功不残留计数）
    await breaker.recordFailure({ circuitTrip: true });
    await breaker.recordFailure({ circuitTrip: true });
    expect((await stateOf(store))?.state).toBe('closed');
    await breaker.recordFailure({ circuitTrip: true }); // 第 3 次 → 重开
    expect((await stateOf(store))?.state).toBe('open');
    await breaker.recordFailure({ circuitTrip: true }); // open 态再失败无意义（不重复计数）
    const state = await stateOf(store);
    expect(state?.state).toBe('open');
    expect(state?.cooldownUntil).toBe(now + config.cooldownMs);
  });

  it('halfOpenProbe=false：冷却到期直接 CAS 回 closed（无探测态）', async () => {
    let now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const breaker = createCircuitBreaker({
      key: 'k',
      config: { ...config, halfOpenProbe: false },
      store,
      now: () => now,
    });
    await store.compareAndSet<BreakerState>(
      'k',
      0,
      {
        state: 'open',
        failures: [],
        windowStart: now,
        openedAt: now,
        cooldownUntil: now + 60_000,
        version: 1,
      },
      1_000_000,
    );
    expect(await breaker.canRequest()).toBe(false); // 冷却内
    now += 61_000;
    expect(await breaker.canRequest()).toBe(true);
    expect((await stateOf(store))?.state).toBe('closed');
  });

  it('滚动窗口：窗口外失败滑出，不累计陈旧失败', async () => {
    let now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const breaker = breakerOf(store, () => now);
    await breaker.recordFailure({ circuitTrip: true });
    now += config.windowMs + 1; // 第一次失败滑出窗口
    await breaker.recordFailure({ circuitTrip: true });
    await breaker.recordFailure({ circuitTrip: true }); // 窗口内仅 2 次 < 3
    expect((await stateOf(store))?.state).toBe('closed');
    await breaker.recordFailure({ circuitTrip: true }); // 第 3 次（窗口内）→ open
    expect((await stateOf(store))?.state).toBe('open');
  });

  it('CAS 竞争：并发写只有版本匹配者成功（无状态双写者互斥）', async () => {
    const store = createMemoryHealthStore();
    const a = breakerOf(store, () => 1_000_000);
    const b = breakerOf(store, () => 1_000_000);
    await a.recordFailure({ circuitTrip: true }); // version 1
    const [ra, rb] = await Promise.all([
      a.recordFailure({ circuitTrip: true }).then(() => true),
      b.recordFailure({ circuitTrip: true }).then(() => true),
    ]);
    expect(ra && rb).toBe(true); // 两者都完成（内部 CAS 重试收敛，不丢计数不崩）
    const state = await stateOf(store);
    expect(state?.version).toBeGreaterThanOrEqual(3);
  });
});
