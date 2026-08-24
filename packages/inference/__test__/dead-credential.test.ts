import { describe, expect, it } from 'vitest';
import { createDeadCredentialTracker } from '../src/health/dead-credential';
import { createMemoryHealthStore } from '../src/adapters/state-memory';
import type { DeadCredentialState } from '../src/health/dead-credential';
import type { HealthStore } from '../src/ports/state';

const config = { failureThreshold: 3, windowMs: 3_600_000 };

function trackerOf(store: HealthStore, now: () => number) {
  return createDeadCredentialTracker({ key: 'k', config, store, now });
}

async function stateOf(store: HealthStore): Promise<DeadCredentialState | null> {
  return await store.getState<DeadCredentialState>('k');
}

describe('health/dead-credential：连续计数状态机（v1 迁移；C3 单阈值）', () => {
  it('非死凭据失败不计数；连续达阈值 → invalid 且停止放行', async () => {
    let now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    await tracker.recordFailure({ deadCredential: false });
    await tracker.recordFailure({ deadCredential: false });
    expect((await stateOf(store))?.consecutiveFailures ?? 0).toBe(0);
    await tracker.recordFailure({ deadCredential: true });
    now += 1_000;
    await tracker.recordFailure({ deadCredential: true });
    expect(await tracker.canRequest()).toBe(true);
    now += 1_000;
    await tracker.recordFailure({ deadCredential: true }); // 第 3 次
    const state = await stateOf(store);
    expect(state?.status).toBe('invalid');
    expect(state?.invalidAt).toBe(now);
    expect(await tracker.canRequest()).toBe(false);
  });

  it('窗口语义：上次失败距今超窗口 → 重置为 1（不算连续）', async () => {
    let now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    await tracker.recordFailure({ deadCredential: true });
    await tracker.recordFailure({ deadCredential: true });
    now += config.windowMs + 1; // 超窗
    await tracker.recordFailure({ deadCredential: true }); // 重置为 1
    expect((await stateOf(store))?.consecutiveFailures).toBe(1);
    expect(await tracker.canRequest()).toBe(true);
  });

  it('成功自愈：invalid → valid、计数清零（凭据恢复或人工换 Key）', async () => {
    const now = 1_000_000;
    const store = createMemoryHealthStore(() => now);
    const tracker = trackerOf(store, () => now);
    for (let i = 0; i < 3; i++) await tracker.recordFailure({ deadCredential: true });
    expect(await tracker.canRequest()).toBe(false);
    await tracker.recordSuccess();
    const state = await stateOf(store);
    expect(state).toMatchObject({ status: 'valid', consecutiveFailures: 0 });
    expect(await tracker.canRequest()).toBe(true);
  });

  it('valid 且零计数时成功为 no-op（无谓写放大防御）', async () => {
    const store = createMemoryHealthStore();
    const tracker = trackerOf(store, () => 1_000_000);
    await tracker.recordSuccess();
    expect(await stateOf(store)).toBeNull(); // 未落任何状态
  });

  it('CAS 竞争：并发计数由版本 CAS 收敛（不崩不双计）', async () => {
    const store = createMemoryHealthStore();
    const a = trackerOf(store, () => 1_000_000);
    const b = trackerOf(store, () => 1_000_000);
    await Promise.all([
      a.recordFailure({ deadCredential: true }),
      b.recordFailure({ deadCredential: true }),
    ]);
    const state = await stateOf(store);
    expect([1, 2]).toContain(state?.consecutiveFailures); // 至少一次成功写入，无丢失崩溃
    expect(state?.version).toBeGreaterThanOrEqual(2);
  });
});
