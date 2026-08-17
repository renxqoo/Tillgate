import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { calcAmount } from '../amount.js';
import { estimateMaxCost } from '../reservation.js';

function expectDecimal(actual: Decimal, expected: string): void {
  expect(actual.toString()).toBe(new Decimal(expected).toString());
}

describe('单位计费（2026-08 扩展：units × unitPrice 与 token 部分相加）', () => {
  it('纯单位计费：3 张图 × ¥0.05/张 × 系数 0.8 = ¥0.12', () => {
    const amount = calcAmount({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '0',
      cacheInputPrice: '0',
      outputPrice: '0',
      units: 3,
      unitPrice: '0.05',
      coefficient: 0.8,
    });
    expectDecimal(amount, '0.12');
  });

  it('混合：token 部分与单位部分相加（同系数）', () => {
    const amount = calcAmount({
      inputTokens: 1_000_000,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '0.001',
      cacheInputPrice: '0.0001',
      outputPrice: '0.002',
      units: 2,
      unitPrice: '0.03',
      coefficient: 1.5,
    });
    // (1e6×0.001)/1e6 = 0.001；单位 2×0.03 = 0.06；(0.001+0.06)×1.5 = 0.0915
    expectDecimal(amount, '0.0915');
  });

  it('units 缺省为 0（token 模型行为不变）；负/非有限 units 钳 0', () => {
    const base = {
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '0.001',
      cacheInputPrice: '0.0001',
      outputPrice: '0.002',
      coefficient: 1,
    } as const;
    const withoutUnits = calcAmount(base);
    expectDecimal(calcAmount({ ...base, units: -5, unitPrice: '0.05' }), withoutUnits.toString());
    expectDecimal(calcAmount({ ...base, units: Number.NaN, unitPrice: '0.05' }), withoutUnits.toString());
  });

  it('单位单价负值/异常不产生负金额（资损防御与 token 部分同规则）', () => {
    const amount = calcAmount({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      inputPrice: '0',
      cacheInputPrice: '0',
      outputPrice: '0',
      units: 2,
      unitPrice: '-1',
      coefficient: 1,
    });
    expectDecimal(amount, '0');
  });
});

describe('estimateMaxCost（单位部分进入预扣上界）', () => {
  it('纯单位模型：上界 units × unitPrice × 系数（n=4 张预扣 4 张的钱）', () => {
    const estimate = estimateMaxCost({
      estimatedInputTokens: 0,
      maxOutputTokens: 0,
      inputPrice: '0',
      outputPrice: '0',
      unitPrice: '0.04',
      unitUpperBound: 4,
      coefficient: 1.2,
    });
    expectDecimal(estimate, '0.192');
  });

  it('token 上界与单位上界同估（图生图：输入 token + 输出张数都算）', () => {
    const estimate = estimateMaxCost({
      estimatedInputTokens: 500_000,
      maxOutputTokens: 0,
      inputPrice: '0.002',
      outputPrice: '0',
      unitPrice: '0.04',
      unitUpperBound: 2,
      coefficient: 1,
    });
    // 0.5e6×0.002/1e6 = 0.001 + 2×0.04 = 0.081
    expectDecimal(estimate, '0.081');
  });

  it('units 缺省 0（token 模型行为不变）', () => {
    const legacy = estimateMaxCost({
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 1000,
      inputPrice: '0.001',
      outputPrice: '0.002',
      coefficient: 1,
    });
    expect(legacy.gt(0)).toBe(true);
  });
});
