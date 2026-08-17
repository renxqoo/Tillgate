/** canonical 指纹：键序稳定/类型区分/非 JSON 安全值拒绝/循环与深度防护/大小上限 */
import { describe, expect, it } from 'vitest';
import { canonicalJson, fingerprintOf } from '../fingerprint';
import { InvalidInputError } from '../errors';

describe('canonicalJson（键序稳定）', () => {
  it('对象键序无关：扁平与嵌套同构', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({ x: { a: 1, b: [1, { q: 1, p: 2 }] }, y: null })).toBe(
      canonicalJson({ y: null, x: { b: [1, { p: 2, q: 1 }], a: 1 } }),
    );
  });

  it('数组保序（数组是有序集合，不排序）', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalJson([3, 2, 1])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('值类型严格区分：1 / "1" / true / null 互不相同', () => {
    const fps = new Set([1, '1', true, null, { a: 1 }, [1], { a: '1' }].map((v) => fingerprintOf(v)));
    expect(fps.size).toBe(7);
  });

  it('-0 归一为 0（同一数学值同一指纹）', () => {
    expect(canonicalJson(-0)).toBe('0');
    expect(fingerprintOf(-0)).toBe(fingerprintOf(0));
  });

  it('空串/空对象/空数组形状正确', () => {
    expect(canonicalJson('')).toBe('""');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson(null)).toBe('null');
  });
});

describe('非 JSON 安全值显式拒绝（静默吞值=重放顶替温床）', () => {
  it('undefined / bigint / symbol / function / NaN / Infinity / Date / 类实例', () => {
    class Money {
      constructor(readonly v: string) {}
    }
    const bad: unknown[] = [
      undefined,
      [1, undefined],
      { a: undefined },
      1n,
      Symbol('x'),
      () => 1,
      NaN,
      Infinity,
      -Infinity,
      new Date('2026-01-01'),
      new Money('1'),
      new Map([[1, 2]]),
    ];
    for (const value of bad) {
      expect(() => canonicalJson(value)).toThrow(InvalidInputError);
    }
  });

  it('循环引用拒绝（含解除跟踪后的共享引用可用）', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expect(() => canonicalJson(a)).toThrow(InvalidInputError);
    // 共享非循环引用合法：seen 在子树写完后释放
    const shared = { k: 1 };
    expect(() => canonicalJson({ x: shared, y: shared })).not.toThrow();
  });

  it('深度 >64 拒绝（爆栈防护）', () => {
    let deep: unknown = { v: 1 };
    for (let i = 0; i < 100; i += 1) deep = { nested: deep };
    expect(() => canonicalJson(deep)).toThrow(InvalidInputError);
    // 64 层以内可用
    let ok: unknown = { v: 1 };
    for (let i = 0; i < 50; i += 1) ok = { nested: ok };
    expect(() => canonicalJson(ok)).not.toThrow();
  });

  it('canonical 总长 >1MB 拒绝', () => {
    expect(() => canonicalJson({ blob: 'x'.repeat(1_100_000) })).toThrow(InvalidInputError);
  });
});

describe('fingerprintOf（SHA-256 hex）', () => {
  it('确定性：同值多次调用恒同；键序无关同指纹', () => {
    expect(fingerprintOf({ a: 1, b: 'x' })).toBe(fingerprintOf({ a: 1, b: 'x' }));
    expect(fingerprintOf({ a: 1, b: 'x' })).toBe(fingerprintOf({ b: 'x', a: 1 }));
    expect(fingerprintOf({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  it('「1.00」与「1.0」字符串不同指纹——金额以字符串携带、调用方负责规范化（契约教学）', () => {
    expect(fingerprintOf({ amount: '1.00' })).not.toBe(fingerprintOf({ amount: '1.0' }));
    expect(fingerprintOf({ amount: '1.00' })).toBe(fingerprintOf({ amount: '1.00' }));
  });
});
