/**
 * 费率卡标签构造与系数展示形测试：`名称 (x系数)` 口径在用户列表行/详情卡/
 * 绑定下拉三处共用；系数字符串直读不抛（后端 numeric 字符串可信但不设防）。
 */
import { describe, expect, it } from 'vitest';

import { fmtCoefficient } from '../src/lib/formatters';
import { rateCardLabel } from '../src/features/users/rate-card-label';

const OPTIONS = [
  { id: 1, name: '标准', coefficient: '1.000' },
  { id: 2, name: '八折', coefficient: '0.800' },
  { id: 3, name: '七五折', coefficient: '0.750' },
];

describe('fmtCoefficient（尾零剥离，整数不动）', () => {
  it('表驱动：numeric 字符串 → 展示形', () => {
    const cases: ReadonlyArray<[string, string]> = [
      ['1.000', '1'],
      ['0.800', '0.8'],
      ['0.750', '0.75'],
      ['0.000', '0'],
      ['1.100', '1.1'],
      ['10', '10'],
      ['1.5', '1.5'],
    ];
    for (const [input, expected] of cases) {
      expect(fmtCoefficient(input), input).toBe(expected);
    }
  });

  it('null/undefined/空串/垃圾形状不抛，原样或空返回', () => {
    expect(fmtCoefficient(null)).toBe('');
    expect(fmtCoefficient('  ')).toBe('');
    expect(fmtCoefficient('abc')).toBe('abc');
    expect(fmtCoefficient('1.0.0')).toBe('1.0.0');
  });
});

describe('rateCardLabel（名称 (x系数) 三处同口径）', () => {
  it('有卡且命中 options → `名称 (x系数)`', () => {
    expect(rateCardLabel({ rateCardId: 1, rateCardName: '标准' }, OPTIONS)).toBe('标准 (x1)');
    expect(rateCardLabel({ rateCardId: 2, rateCardName: '八折' }, OPTIONS)).toBe('八折 (x0.8)');
    expect(rateCardLabel({ rateCardId: 3, rateCardName: '七五折' }, OPTIONS)).toBe(
      '七五折 (x0.75)',
    );
  });

  it('无卡（id/name 任一为 null）→ —', () => {
    expect(rateCardLabel({ rateCardId: null, rateCardName: null }, OPTIONS)).toBe('—');
    expect(rateCardLabel({ rateCardId: 1, rateCardName: null }, OPTIONS)).toBe('—');
  });

  it('options 未命中（卡已删/陈旧引用）→ 退回纯名称不拼系数', () => {
    expect(rateCardLabel({ rateCardId: 99, rateCardName: '旧卡' }, OPTIONS)).toBe('旧卡');
    expect(rateCardLabel({ rateCardId: 1, rateCardName: '标准' }, [])).toBe('标准');
  });
});
