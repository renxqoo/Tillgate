import { describe, expect, it } from 'vitest';
import { createModelDeadTracker } from '../src/health/model-dead';
import type { ModelDeadConfig, ModelDeadState } from '../src/health/model-dead';
import { createMemoryHealthStore } from '../src/adapters/state-memory';
import type { HealthStore } from '../src/ports/state';

const config: ModelDeadConfig = { failureThreshold: 3, ttlMs: 60_000, windowMs: 300_000 };

function trackerOf(store: HealthStore, now: () => number) {
  return createModelDeadTracker({ key: 'k', config, store, now });
}

async function stateOf(store: HealthStore): Promise<ModelDeadState | null> {
  return await store.getState<ModelDeadState>('k');
}

describe('health/model-dead：候选全渠道耗尽死记忆', () => {
  it('连续耗尽达阈值 → 判死跳过；TTL 过期自然复活', async () => {
    let now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    await tracker.recordFailure();
    await tracker.recordFailure();
    expect(await tracker.isDead()).toBe(false);
    await tracker.recordFailure(); // 第 3 次
    expect(await tracker.isDead()).toBe(true);
    now += config.ttlMs + 1;
    expect(await tracker.isDead()).toBe(false); // 复活兜底
  });

  it('成功清零（dead 状态也自愈）；无状态时零写放大', async () => {
    const now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    await tracker.recordFailure();
    await tracker.recordFailure();
    await tracker.recordFailure();
    expect(await tracker.isDead()).toBe(true);
    await tracker.recordSuccess();
    expect(await tracker.isDead()).toBe(false);
    expect((await stateOf(store))?.consecutive).toBe(0);
    // 无状态成功 no-op
    const store2 = createMemoryHealthStore(() => now);
    const tracker2 = trackerOf(store2, () => now);
    await tracker2.recordSuccess();
    expect(await stateOf(store2)).toBeNull();
  });

  it('P1 复活回归：dead 状态下再次失败只续窗，不重置计数不翻回存活', async () => {
    let now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    for (let i = 0; i < 3; i++) await tracker.recordFailure();
    expect(await tracker.isDead()).toBe(true);
    // 并发在途请求随后耗尽 → 第 4 次失败到达：必须保持 dead（原实现翻回 consecutive=1）
    now += 1_000;
    await tracker.recordFailure();
    expect(await tracker.isDead()).toBe(true);
    const state = await stateOf(store);
    expect(state?.dead).toBe(true);
    expect(state?.consecutive).toBe(3);
    now += config.ttlMs + 1;
    expect(await tracker.isDead()).toBe(false); // 续窗后 TTL 过期仍正常复活
  });

  it('计数窗口语义：上次失败超窗 → 重置为 1', async () => {
    let now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    await tracker.recordFailure();
    await tracker.recordFailure();
    now += config.windowMs + 1;
    await tracker.recordFailure(); // 重置
    expect((await stateOf(store))?.consecutive).toBe(1);
    expect(await tracker.isDead()).toBe(false);
  });
});
