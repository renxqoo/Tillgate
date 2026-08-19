import { describe, expect, it } from 'vitest';
import { BillingConfigurationError } from '../errors.js';
import { calculateRequired } from '../calculate.js';
import { candidate, quote } from './fixtures.js';

describe('calculateRequired（四道保守）', () => {
  it('最坏 = 输入上界×贵输入价 + maxOutputTokens×输出价，×系数', () => {
    const required = calculateRequired(quote([candidate()]), '100');
    // (1M×2 + 200k×6)/1M = 3.2
    expect(required.toString()).toBe('3.2');
  });

  it('候选链取最贵（fallback 更贵不得透支）', () => {
    const required = calculateRequired(
      quote([candidate(), candidate({ mappingId: 2, inputPrice: '4', outputPrice: '10' })]),
      '100',
    );
    // (1M×4 + 200k×10)/1M = 6
    expect(required.toString()).toBe('6');
  });

  it('explicitlyFree：全零价 → 0 元授权', () => {
    const required = calculateRequired(
      quote([candidate({ inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' })], true),
      '100',
    );
    expect(required.isZero()).toBe(true);
  });

  it('R6：声明免费却有价 → 结构性拒绝', () => {
    expect(() => calculateRequired(quote([candidate()], true), '100')).toThrow(BillingConfigurationError);
  });

  it('零价未声明免费 → 拒绝（免费额度印刷机防线）', () => {
    expect(() =>
      calculateRequired(quote([candidate({ inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' })]), '100'),
    ).toThrow(BillingConfigurationError);
  });

  it('系数非法 / 价格为负 / 空候选 → 配置错误', () => {
    expect(() => calculateRequired(quote([candidate({ coefficient: '0' })]), '100')).toThrow(BillingConfigurationError);
    expect(() => calculateRequired(quote([candidate({ inputPrice: '-1' })]), '100')).toThrow(BillingConfigurationError);
    expect(() => calculateRequired(quote([]), '100')).toThrow(BillingConfigurationError);
  });

  it('超单请求上限 → reservation_limit_exceeded（只拒绝不截断）', () => {
    expect(() => calculateRequired(quote([candidate()]), '1')).toThrow(
      Object.assign(new BillingConfigurationError('reservation_limit_exceeded'), {}),
    );
    try {
      calculateRequired(quote([candidate()]), '1');
    } catch (error) {
      expect((error as BillingConfigurationError).code).toBe('reservation_limit_exceeded');
    }
  });
}
);
