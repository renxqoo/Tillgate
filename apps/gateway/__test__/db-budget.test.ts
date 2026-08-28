/**
 * gateway DB 预算推导规格（红队复审 R-3）：预算不越池、小池收敛、放不进池才 fail-fast。
 * 矩阵锚点：210（live-fire 池）→ 178；40 → 8（目标余量 32 触底）；10（默认）
 * → 8 = pool−2；小池压力形态 2 → 1（e2e strict 不被拒）；旧行为 Math.max(8, pool−32)
 * 在 pool≤7 时预算反超池容量，预算门自制 F-6 楔死。
 */
import { describe, expect, it } from 'vitest';
import { gatewayDbBudget } from '../src/db-budget.js';

describe('gatewayDbBudget', () => {
  it.each([
    [210, 178],
    [100, 68],
    [40, 8],
    [12, 8],
    [10, 8],
    [9, 7],
    [8, 6],
    [7, 5],
    [3, 1],
    [2, 1],
  ])('pool %i → limit %i（永不越池）', (poolMax, limit) => {
    const budget = gatewayDbBudget(poolMax);
    expect(budget.limit).toBe(limit);
    expect(budget.limit).toBeLessThan(poolMax);
    expect(budget.maxQueue).toBe(20_000);
    expect(budget.waitTimeoutMs).toBe(120_000);
  });

  it('pool 1：预算 1 = 池容量，零余量 → fail-fast', () => {
    expect(() => gatewayDbBudget(1)).toThrow(/DB_POOL_MAX must be >= 2/);
  });

  it('drainSignal 可选透传（db-budget-signals）：缺省不带字段,传入即注入且不影响推导', () => {
    expect(gatewayDbBudget(10).drainSignal).toBeUndefined();
    const { signal } = new AbortController();
    const budget = gatewayDbBudget(10, signal);
    expect(budget.drainSignal).toBe(signal);
    expect(budget.limit).toBe(8);
    expect(budget.maxQueue).toBe(20_000);
    expect(budget.waitTimeoutMs).toBe(120_000);
  });
});
