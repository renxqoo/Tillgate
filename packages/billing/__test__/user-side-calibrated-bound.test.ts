/**
 * user_side 冻结额消费校准界测试（docs §4.3/裁决 D8）：
 * 候选携带 calibratedInputTokenUpperBound 时 estimatedAmount 按校准界收缩；
 * 未携带 = 现状字节界（回归锚）；B2 钳制仍按字节界（I0——in-quote 上界不动）。
 */
import { describe, expect, it } from 'vitest';
import { calculateRequired } from '../src/domain/rating/calculate.js';
import type { BillingQuote } from '../src/domain/rating/types.js';

function quote(bound: number | undefined): BillingQuote {
  return {
    maxOutputTokens: 0,
    candidates: [
      {
        mappingId: 13,
        externalModel: 'm',
        realModel: 'm',
        inputPrice: '2',
        outputPrice: '0',
        cacheInputPrice: '0',
        coefficient: '1',
        inputTokenUpperBound: 1_000_000,
        ...(bound != null ? { calibratedInputTokenUpperBound: bound } : {}),
        billingPolicyFingerprint: null,
      },
    ],
  };
}

describe('calculateRequired 消费校准界（user_side）', () => {
  it('携带校准界 50000 → 冻结 = 50000×2/1M = 0.1', () => {
    expect(calculateRequired(quote(50_000), '1000').toString()).toBe('0.1');
  });

  it('回归锚：未携带 → 字节界 1M×2/1M = 2（现状）', () => {
    expect(calculateRequired(quote(undefined), '1000').toString()).toBe('2');
  });

  it('防御：校准界 > 字节界（形状异常）→ min 收敛到字节界', () => {
    expect(calculateRequired(quote(2_000_000), '1000').toString()).toBe('2');
  });

  it('免费链仍零授权（校准界不影响免费推导）', () => {
    const free: BillingQuote = {
      ...quote(50_000),
      explicitlyFree: true,
    };
    expect(calculateRequired(free, '1000').toString()).toBe('0');
  });
});
