import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { calcHold, estimateMaxCost } from '../../src/hold.js';

function expectDecimal(actual: Decimal, expected: string): void {
  expect(actual.toString()).toBe(new Decimal(expected).toString());
}

describe('estimateMaxCost（元 + decimal 全精度）', () => {
  it('基准：估算输入 1M × ¥0.002 + 输出上限 4096 × ¥0.008（系数 1.0）', () => {
    const cost = estimateMaxCost({
      estimatedInputTokens: 1_000_000,
      maxOutputTokens: 4096,
      inputPrice: '0.002',
      outputPrice: '0.008',
      coefficient: 1,
    });
    // (1e6×0.002 + 4096×0.008)/1e6 = 0.002 + 0.000032768 = 0.002032768 元（全精度，不 round）
    expectDecimal(cost, '0.002032768');
  });

  it('系数影响估算（精确倍数）', () => {
    const base = estimateMaxCost({
      estimatedInputTokens: 100_000, maxOutputTokens: 1000,
      inputPrice: '0.002', outputPrice: '0.008', coefficient: 1,
    });
    const doubled = estimateMaxCost({
      estimatedInputTokens: 100_000, maxOutputTokens: 1000,
      inputPrice: '0.002', outputPrice: '0.008', coefficient: 2,
    });
    expectDecimal(doubled, base.times(2).toString());
  });

  it('极小输入（1 token × ¥0.001/M）→ 精确 1e-9 元（不再被 round 成 0）', () => {
    const cost = estimateMaxCost({
      estimatedInputTokens: 1,
      maxOutputTokens: 0,
      inputPrice: '0.001',
      outputPrice: 0,
      coefficient: 1,
    });
    // 1×0.001/1e6 = 1e-9 元（精确；gateway 用它判断是否拦截）
    expectDecimal(cost, '0.000000001');
  });

  it('所有输入为 0 → 返回 0', () => {
    const cost = estimateMaxCost({
      estimatedInputTokens: 0, maxOutputTokens: 0,
      inputPrice: '0.001', outputPrice: '0.002', coefficient: 1,
    });
    expect(cost.isZero()).toBe(true);
  });
});

describe('calcHold（元 + decimal）', () => {
  it('min(估算, 余额, HOLD_MAX) 三分支', () => {
    expectDecimal(calcHold('100', '50', '1000'), '50'); // 余额更小
    expectDecimal(calcHold('100', '500', '80'), '80'); // HOLD_MAX 更小
    expectDecimal(calcHold('100', '500', '1000'), '100'); // 估算最小
  });

  it('估算为非有限值/负数 → 防御为 0', () => {
    expectDecimal(calcHold(Infinity, '1000', '1000'), '0');
    expectDecimal(calcHold(Number.NaN, '1000', '1000'), '0');
    expectDecimal(calcHold('-500', '1000', '1000'), '0');
  });

  it('余额为非有限值/负数 → 防御为 0（拒绝预扣，触发 402）', () => {
    expectDecimal(calcHold('1000', Infinity, '1000'), '0');
    expectDecimal(calcHold('1000', Number.NaN, '1000'), '0');
    expectDecimal(calcHold('1000', '-100', '1000'), '0');
  });

  it('HOLD_MAX 为非有限值 → 防御为 0', () => {
    expectDecimal(calcHold('1000', '1000', Infinity), '0');
    expectDecimal(calcHold('1000', '1000', Number.NaN), '0');
  });

  it('estimate=0（极小请求）→ 返回 0，不拦截', () => {
    expectDecimal(calcHold('0', '99.962209', '50'), '0');
    expectDecimal(calcHold('0', '0', '50'), '0');
  });
});
