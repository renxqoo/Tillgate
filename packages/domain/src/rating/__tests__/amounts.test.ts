import { describe, expect, it } from 'vitest';
import { computeAmounts } from '../amounts.js';
import { candidate, receiptFor } from './fixtures.js';

describe('computeAmounts（结算双口径）', () => {
  it('calculated ×系数；upstreamCost 系数恒 1（渠道成本官方价口径）', () => {
    const c = candidate({ inputPrice: '2', outputPrice: '6', cacheInputPrice: '1', coefficient: '1.5' });
    const r = receiptFor(c, 7, { usage: { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 200_000, estimated: false } });
    const amounts = computeAmounts(r);
    expect(amounts.calculatedAmount).toBe('4.2');
    expect(amounts.upstreamCost).toBe('2.8');
  });

  it('负成本钳 0（渠道成本不为负）', () => {
    const c = candidate({ inputPrice: '0', outputPrice: '0', cacheInputPrice: '0', coefficient: '1' });
    const amounts = computeAmounts(receiptFor(c, 7));
    expect(amounts.upstreamCost).toBe('0');
    expect(amounts.calculatedAmount).toBe('0');
  });
}
);
