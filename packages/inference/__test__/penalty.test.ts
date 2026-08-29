import { describe, expect, it } from 'vitest';
import { createPenaltyTracker, penaltyDelayMs } from '../src/health/penalty';
import type { PenaltyConfig, PenaltyState } from '../src/health/penalty';
import { createMemoryHealthStore } from '../src/adapters/state-memory';
import type { HealthStore } from '../src/ports/state';

const config: PenaltyConfig = {
  rateLimitBaseMs: 2_000,
  rateLimitMaxMs: 60_000,
  quotaMs: 1_800_000,
};

function trackerOf(store: HealthStore, now: () => number) {
  return createPenaltyTracker({ key: 'k', config, store, now });
}

async function stateOf(store: HealthStore): Promise<PenaltyState | null> {
  return await store.getState<PenaltyState>('k');
}

describe('health/penalty：429/quota 渠道冷却记忆', () => {
  it('429 记账后冷却期内 penalized；过期自动恢复', async () => {
    let now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    expect(await tracker.penalized()).toBe(false);
    await tracker.record('rate_limited');
    expect(await tracker.penalized()).toBe(true);
    now += 2_001; // 首次冷却 = base 2000
    expect(await tracker.penalized()).toBe(false);
  });

  it('Retry-After 是权威下界：高于指数退避时抬高冷却', async () => {
    let now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    await tracker.record('rate_limited', 30_000);
    const state = await stateOf(store);
    expect(state?.until).toBe(now + 30_000);
    now += 29_999;
    expect(await tracker.penalized()).toBe(true);
    now += 2;
    expect(await tracker.penalized()).toBe(false);
  });

  it('冷却期内连续命中 → 指数加长（2s → 4s → 8s）；过期后重置为 1', async () => {
    let now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    await tracker.record('rate_limited'); // n=1, 2s
    await tracker.record('rate_limited'); // n=2, 4s
    await tracker.record('rate_limited'); // n=3, 8s
    expect((await stateOf(store))?.consecutive).toBe(3);
    expect((await stateOf(store))?.until).toBe(now + 8_000);
    now += 8_001;
    await tracker.record('rate_limited'); // 过期后重置
    expect((await stateOf(store))?.consecutive).toBe(1);
  });

  it('quota_exhausted：固定长冷却（充值级窗口），Retry-After 不参与', async () => {
    const now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    await tracker.record('quota_exhausted', 1_000);
    expect((await stateOf(store))?.until).toBe(now + config.quotaMs);
  });

  it('不同 kind 后到覆盖先到（最近上游信号为准）', async () => {
    const now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    await tracker.record('rate_limited');
    await tracker.record('quota_exhausted');
    expect((await stateOf(store))?.kind).toBe('quota_exhausted');
  });

  it('约束更强者胜：quota 冷却期间的 429 不得缩短 until（不降级）', async () => {
    const now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    await tracker.record('quota_exhausted'); // until = now + 30min
    const quotaUntil = (await stateOf(store))?.until;
    await tracker.record('rate_limited'); // 429 到达——不得降级
    const after = await stateOf(store);
    expect(after?.kind).toBe('quota_exhausted'); // kind 保持强约束
    expect(after?.until).toBe(quotaUntil); // until 不缩短
    expect(await tracker.remainingMs()).toBe(config.quotaMs);
  });

  it('升级照常：429 冷却期间的 quota 记账把 until 延长到 30min', async () => {
    const now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    await tracker.record('rate_limited'); // until = now + 2s
    await tracker.record('quota_exhausted'); // 升级
    const after = await stateOf(store);
    expect(after?.kind).toBe('quota_exhausted');
    expect(after?.until).toBe(now + config.quotaMs);
  });

  it('同 kind 指数退避如常 + until 单调不缩短', async () => {
    const now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    await tracker.record('rate_limited', 5_000); // Retry-After 5s 主导
    await tracker.record('rate_limited', 100); // 新算 4s < 5s——不缩短
    const after = await stateOf(store);
    expect(after?.consecutive).toBe(2);
    expect(after?.until).toBe(now + 5_000); // 保持更长冷却
  });

  it('penaltyDelayMs 纯函数：指数封顶 + Retry-After 下界', () => {
    expect(penaltyDelayMs({ kind: 'rate_limited', consecutive: 1, config })).toBe(2_000);
    expect(penaltyDelayMs({ kind: 'rate_limited', consecutive: 3, config })).toBe(8_000);
    expect(penaltyDelayMs({ kind: 'rate_limited', consecutive: 20, config })).toBe(60_000); // 封顶
    expect(
      penaltyDelayMs({ kind: 'rate_limited', consecutive: 1, config, retryAfterMs: 5_000 }),
    ).toBe(5_000);
    expect(
      penaltyDelayMs({ kind: 'quota_exhausted', consecutive: 1, config, retryAfterMs: 5_000 }),
    ).toBe(config.quotaMs);
  });
});
