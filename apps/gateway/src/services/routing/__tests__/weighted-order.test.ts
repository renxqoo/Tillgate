import { describe, expect, it } from 'vitest';
import { weightedOrderByPriority } from '../model-router.js';

/**
 * 渠道调度语义：priority 分层严格降序；层内 weight 是流量份额（加权随机），
 * 不是确定性 tie-break——否则头部渠道吸收 100% 流量直到熔断。
 */
describe('weightedOrderByPriority — 调度排序', () => {
  it('priority 层间严格降序', () => {
    const rows = [
      { mcPriority: 1, mcWeight: 1, id: 'p1' },
      { mcPriority: 5, mcWeight: 1, id: 'p5' },
      { mcPriority: 3, mcWeight: 9, id: 'p3' },
    ];
    for (let i = 0; i < 50; i++) {
      const ordered = weightedOrderByPriority(rows).map((r) => r.id);
      expect(ordered.indexOf('p5')).toBeLessThan(ordered.indexOf('p3'));
      expect(ordered.indexOf('p3')).toBeLessThan(ordered.indexOf('p1'));
    }
  });

  it('层内按 weight 分流（统计断言：9:1 权重 → 首位占比 ≈ 90%）', () => {
    const rows = [
      { mcPriority: 1, mcWeight: 9, id: 'heavy' },
      { mcPriority: 1, mcWeight: 1, id: 'light' },
    ];
    let heavyFirst = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      if (weightedOrderByPriority(rows)[0]!.id === 'heavy') heavyFirst++;
    }
    const ratio = heavyFirst / N;
    expect(ratio).toBeGreaterThan(0.85);
    expect(ratio).toBeLessThan(0.95);
  });

  it('weight 全 0 时等概率（平滑兜底）', () => {
    const rows = [
      { mcPriority: 1, mcWeight: 0, id: 'a' },
      { mcPriority: 1, mcWeight: 0, id: 'b' },
    ];
    let aFirst = 0;
    const N = 1000;
    for (let i = 0; i < N; i++) if (weightedOrderByPriority(rows)[0]!.id === 'a') aFirst++;
    expect(aFirst / N).toBeGreaterThan(0.4);
    expect(aFirst / N).toBeLessThan(0.6);
  });
});
