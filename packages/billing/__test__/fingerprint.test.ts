/**
 * canonical 指纹行为规格（迁移自旧仓 ledger-core/__tests__/fingerprint.test.ts，14 用例
 * 全保留；InvalidInputError 断言换 DefectError 码断言；新增 B4 回归与 commandFingerprint 契约）。
 */
import { describe, expect, it } from 'vitest';
import { isDefectError } from '@tokenlens/errors';
import { canonicalJson, commandFingerprint, fingerprintOf } from '../src/domain/fingerprint.js';

/** 断言缺陷拒绝并核对码（指纹载荷构造缺陷分类，DESIGN §2.3） */
function expectDefect(fn: () => unknown): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  if (!isDefectError(caught)) throw new Error('expected DefectError rejection');
  expect((caught as { code: string }).code).toBe('billing.fingerprint_input');
}

describe('canonicalJson（键序稳定）', () => {
  it('对象键序无关：扁平与嵌套同构', () => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
    expect(canonicalJson({ x: { a: 1, b: [1, { q: 1, p: 2 }] }, y: null })).toBe(
      canonicalJson({ y: null, x: { b: [1, { p: 2, q: 1 }], a: 1 } }),
    );
  });

  it('B4 回归：键序按码点排序，与 locale 无关（localeCompare 环境下 "a" 会排到 "B" 前）', () => {
    expect(canonicalJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
    expect(canonicalJson({ B: 2, a: 1 })).toBe('{"B":2,"a":1}');
  });

  it('数组保序（数组是有序集合，不排序）', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]');
    expect(canonicalJson([3, 2, 1])).not.toBe(canonicalJson([1, 2, 3]));
  });

  it('值类型严格区分：1 / "1" / true / null 互不相同', () => {
    const fps = new Set(
      [1, '1', true, null, { a: 1 }, [1], { a: '1' }].map((v) => fingerprintOf(v)),
    );
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

describe('非 JSON 安全值显式拒绝（B4 回归：静默吞值=重放顶替温床）', () => {
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
      expectDefect(() => canonicalJson(value));
    }
  });

  it('B4 回归：{a:NaN} 拒绝而 {a:null} 合法——宽松版两者同指纹（JSON.stringify 归 null）', () => {
    expectDefect(() => fingerprintOf({ a: Number.NaN }));
    expect(canonicalJson({ a: null })).toBe('{"a":null}');
  });

  it('循环引用拒绝（含解除跟踪后的共享引用可用）', () => {
    const a: Record<string, unknown> = {};
    a.self = a;
    expectDefect(() => canonicalJson(a));
    // 共享非循环引用合法：seen 在子树写完后释放
    const shared = { k: 1 };
    expect(() => canonicalJson({ x: shared, y: shared })).not.toThrow();
  });

  it('深度 >64 拒绝（爆栈防护）', () => {
    let deep: unknown = { v: 1 };
    for (let i = 0; i < 100; i += 1) deep = { nested: deep };
    expectDefect(() => canonicalJson(deep));
    // 64 层以内可用
    let ok: unknown = { v: 1 };
    for (let i = 0; i < 50; i += 1) ok = { nested: ok };
    expect(() => canonicalJson(ok)).not.toThrow();
  });

  it('canonical 总长 >1MB 拒绝', () => {
    expectDefect(() => canonicalJson({ blob: 'x'.repeat(1_100_000) }));
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

describe('commandFingerprint（幂等命令身份）', () => {
  it('kind 是幂等域隔离轴：同参数不同 kind 不同指纹', () => {
    const payload = { userId: 1, currency: 'CNY', amount: '10' };
    expect(commandFingerprint('credit', payload)).not.toBe(commandFingerprint('refund', payload));
    expect(commandFingerprint('credit', payload)).toBe(commandFingerprint('credit', payload));
  });

  it('payload 键序无关；金额字符串按携带值区分', () => {
    expect(commandFingerprint('credit', { userId: 1, amount: '10' })).toBe(
      commandFingerprint('credit', { amount: '10', userId: 1 }),
    );
    expect(commandFingerprint('credit', { userId: 1, amount: '10' })).not.toBe(
      commandFingerprint('credit', { userId: 1, amount: '10.000' }),
    );
  });

  it('B4 回归：payload 含 undefined 显式拒绝（旧宽松版静默丢弃）——模拟绕过类型的 JS 调用方', () => {
    const payload = { userId: 1, memo: undefined } as unknown as Readonly<
      Record<string, import('../src/domain/fingerprint.js').FingerprintValue>
    >;
    expectDefect(() => commandFingerprint('credit', payload));
  });

  it("payload 键 'kind' 是保留轴——覆盖会使域隔离失效", () => {
    expectDefect(() => commandFingerprint('credit', { kind: 'refund' }));
  });
});
