/** 系数解析纯函数：model > group > global > '1'（DB 快照装载的测试在 @ai-gateway/repository）。 */
import { describe, expect, it } from 'vitest';
import { pickCoefficient, type RateCardCoefficientSnapshot } from '../coefficient.js';

const snapshot: RateCardCoefficientSnapshot = {
  rateCardId: 1,
  status: 0,
  global: '2',
  model: { 10: '0.5' },
  group: { vip: '1.5' },
};

describe('pickCoefficient', () => {
  it('model > group > global > 无行兜底', () => {
    expect(pickCoefficient(snapshot, { modelMappingId: 10, pricingGroup: 'vip' })).toBe('0.5');
    expect(pickCoefficient(snapshot, { modelMappingId: 11, pricingGroup: 'vip' })).toBe('1.5');
    expect(pickCoefficient(snapshot, { modelMappingId: 11, pricingGroup: 'other' })).toBe('2');
  });

  it('无卡（null）恒 1', () => {
    expect(pickCoefficient(null, { modelMappingId: 10, pricingGroup: 'vip' })).toBe('1');
  });
});
