import { describe, expect, it } from 'vitest';
import { weightedOrderByPriority } from '../src/domain/routing/schedule';

describe('domain/routing/schedule：priority 层 + weight 无放回加权随机', () => {
  it('priority 高的层严格在前（同层随机不影响跨层顺序）', () => {
    const rows = [
      { id: 'low-a', priority: 1, weight: 100 },
      { id: 'high-a', priority: 5, weight: 1 },
      { id: 'low-b', priority: 1, weight: 1 },
      { id: 'high-b', priority: 5, weight: 1 },
    ];
    const ordered = weightedOrderByPriority(rows, Math.random);
    expect(
      ordered
        .map((r) => r.id)
        .slice(0, 2)
        .toSorted(),
    ).toEqual(['high-a', 'high-b']);
    expect(
      ordered
        .map((r) => r.id)
        .slice(2)
        .toSorted(),
    ).toEqual(['low-a', 'low-b']);
  });

  it('weight 是无放回抽取概率：rng 接近 1 时 weight=9 的渠道先出（9/10 首发份额）；rng=0 取首位', () => {
    const rows = [
      { id: 'w1', priority: 0, weight: 1 },
      { id: 'w9', priority: 0, weight: 9 },
    ];
    expect(weightedOrderByPriority(rows, () => 0.99).map((r) => r.id)).toEqual(['w9', 'w1']);
    expect(weightedOrderByPriority(rows, () => 0).map((r) => r.id)).toEqual(['w1', 'w9']);
    // 无放回：全部抽出，只是顺序不同（不丢候选）
    expect(
      weightedOrderByPriority(rows, () => 0.999)
        .map((r) => r.id)
        .toSorted(),
    ).toEqual(['w1', 'w9']);
  });

  it('weight<=0 按 1 处理；全 0 时等概率（不除零、不丢候选）', () => {
    const rows = [
      { id: 'a', priority: 0, weight: 0 },
      { id: 'b', priority: 0, weight: -5 },
      { id: 'c', priority: 0, weight: 0 },
    ];
    const ordered = weightedOrderByPriority(rows, () => 0.5);
    expect(ordered).toHaveLength(3);
    expect(new Set(ordered.map((r) => r.id))).toEqual(new Set(['a', 'b', 'c']));
  });

  it('空输入返回空数组（无渠道候选的边界）', () => {
    expect(weightedOrderByPriority([], () => 0)).toEqual([]);
  });

  it('不改动原数组（纯函数——调度不得反向污染目录候选）', () => {
    const rows = [
      { id: 'a', priority: 0, weight: 1 },
      { id: 'b', priority: 0, weight: 1 },
    ];
    weightedOrderByPriority(rows, () => 0);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
  });
});
