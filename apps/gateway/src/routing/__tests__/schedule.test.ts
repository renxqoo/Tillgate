/** 调度排序（纯函数）：分层严格序 + 层内加权随机（rng 注入的确定性验证）。 */
import { describe, expect, it } from 'vitest';
import { weightedOrderByPriority } from '../schedule.js';

const ch = (id: string, priority: number, weight: number) => ({ id, priority, weight });

describe('weightedOrderByPriority', () => {
  it('priority 层严格降序（高层永远在前，与 weight 无关）', () => {
    const rows = [ch('low', 0, 999), ch('high', 10, 1), ch('mid', 5, 1), ch('high2', 10, 5)];
    const ordered = weightedOrderByPriority(rows, () => 0);
    expect(ordered.map((r) => r.priority)).toEqual([10, 10, 5, 0]);
  });

  it('rng=0（总加权最小侧）→ 层内按序取首个', () => {
    const rows = [ch('a', 1, 9), ch('b', 1, 1)];
    expect(weightedOrderByPriority(rows, () => 0).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('rng≈1（最大侧）→ 层内最后一位先出（加权份额语义）', () => {
    const rows = [ch('a', 1, 1), ch('b', 1, 9)];
    expect(weightedOrderByPriority(rows, () => 0.999).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('weight<=0 按 1 处理（全 0 时等概率）', () => {
    const rows = [ch('a', 1, 0), ch('b', 1, -5), ch('c', 1, 0)];
    expect(weightedOrderByPriority(rows, () => 0)).toHaveLength(3);
    expect(weightedOrderByPriority(rows, () => 0.999)[0]!.id).toBe('c');
  });

  it('空输入与全层覆盖', () => {
    expect(weightedOrderByPriority([], () => 0)).toEqual([]);
  });
});
