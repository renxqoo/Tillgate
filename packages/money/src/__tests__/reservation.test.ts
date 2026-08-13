import { describe, expect, it } from 'vitest';
import { estimateMaxCost, requiredReservation } from '../reservation.js';

describe('enterprise reservation', () => {
  it('按输入和最大输出计算完整费用暴露', () => {
    expect(
      estimateMaxCost({
        estimatedInputTokens: 1_000,
        maxOutputTokens: 500,
        inputPrice: '1000',
        outputPrice: '2000',
        coefficient: '1',
      }).eq(2),
    ).toBe(true);
  });

  it('返回完整预扣，不按余额裁剪', () => {
    expect(requiredReservation('1.9987508', '50').eq('1.9987508')).toBe(true);
  });

  it('缓存价异常高于普通输入价时仍按较高价足额授权', () => {
    expect(
      estimateMaxCost({
        estimatedInputTokens: 1_000,
        maxOutputTokens: 0,
        inputPrice: '1',
        cacheInputPrice: '1000',
        outputPrice: '0',
        coefficient: '1',
      }).eq(1),
    ).toBe(true);
  });

  it('超过风险上限直接拒绝', () => {
    expect(() => requiredReservation('51', '50')).toThrow('reservation_limit_exceeded');
  });

  it('异常 token 估算不产生 Infinity/NaN', () => {
    const value = estimateMaxCost({
      estimatedInputTokens: Number.POSITIVE_INFINITY,
      maxOutputTokens: Number.NaN,
      inputPrice: '1',
      outputPrice: '1',
      coefficient: '1',
    });
    expect(value.isFinite()).toBe(true);
    expect(value.gte(0)).toBe(true);
  });
});
