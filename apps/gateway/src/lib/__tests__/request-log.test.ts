import { describe, expect, it } from 'vitest';
import { truncateSummary } from '../request-log.js';

describe('truncateSummary', () => {
  it('null/undefined → null', () => {
    expect(truncateSummary(null)).toBeNull();
    expect(truncateSummary(undefined)).toBeNull();
  });

  it('小对象 → 原样返回', () => {
    const obj = { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] };
    expect(truncateSummary(obj)).toEqual(obj);
  });

  it('超过上限 → 截断 + 带 preview/totalLength/truncated 标记', () => {
    const big = { content: 'a'.repeat(3000) };
    const r = truncateSummary(big, 100) as {
      truncated: boolean;
      preview: string;
      totalLength: number;
    };
    expect(r.truncated).toBe(true);
    expect(r.preview.length).toBe(100);
    expect(r.totalLength).toBeGreaterThan(100);
  });

  it('刚好等于上限 → 原样返回（不截断）', () => {
    const obj = { x: 'a'.repeat(50) };
    const s = JSON.stringify(obj);
    expect(truncateSummary(obj, s.length)).toEqual(obj);
  });

  it('自定义 maxChars', () => {
    const big = { x: 'a'.repeat(500) };
    const r = truncateSummary(big, 50) as { preview: string };
    expect(r.preview).toHaveLength(50);
  });

  it('循环引用对象 → null（不抛错）', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(truncateSummary(cyclic)).toBeNull();
  });

  it('数组对象', () => {
    expect(truncateSummary([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('字符串原始值', () => {
    expect(truncateSummary('short')).toBe('short');
  });
});
