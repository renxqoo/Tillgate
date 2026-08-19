/** rating/amounts 特征规格（纯迁移自 billing/settle/compute-amounts，行为零变更）：
 *  用户侧实扣 = calcAmount（真实 usage × 价格快照 × 系数）；
 *  渠道侧成本 = 官方价口径（系数恒 1，负值钳 0）。 */
import { describe, expect, it } from 'vitest';
import { computeAmounts } from '../amounts.js';
import type { UsageReceipt } from '../types.js';

function receipt(overrides: Partial<UsageReceipt> = {}): UsageReceipt {
  return {
    requestId: 'req-1',
    userId: 1,
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: 'gpt-x',
    realModel: 'gpt-real',
    channelId: 1,
    channelKey: 'ch',
    usage: { inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 50_000, estimated: false },
    inputPrice: '2',
    outputPrice: '3',
    cacheInputPrice: '1',
    coefficient: '1',
    durationMs: 800,
    stream: false,
    streamAborted: false,
    mappingId: 1,
    billingPolicyFingerprint: null,
    ...overrides,
  };
}

describe('computeAmounts：结算金额双口径', () => {
  it('纯 token：用户实扣与渠道成本同额（系数 1）', () => {
    // (2×100000 + 3×50000) / 1e6 = 0.35
    const amounts = computeAmounts(receipt());
    expect(amounts.calculatedAmount).toBe('0.35');
    expect(amounts.upstreamCost).toBe('0.35');
  });

  it('系数只作用用户侧：实扣 ×1.5，渠道成本仍按官方价', () => {
    const amounts = computeAmounts(receipt({ coefficient: '1.5' }));
    expect(amounts.calculatedAmount).toBe('0.525');
    expect(amounts.upstreamCost).toBe('0.35');
  });

  it('缓存命中按缓存价计（用户侧），官方口径同样区分缓存价', () => {
    // 用户侧: 60k×2 + 40k×1 + 50k×3 = 310000 / 1e6 = 0.31
    const amounts = computeAmounts(
      receipt({ usage: { inputTokens: 100_000, cachedInputTokens: 40_000, outputTokens: 50_000, estimated: false } }),
    );
    expect(amounts.calculatedAmount).toBe('0.31');
    expect(amounts.upstreamCost).toBe('0.31');
  });

  it('单位计量双口径一致：units × unitPrice', () => {
    const amounts = computeAmounts(
      receipt({
        usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimated: false, units: 5 },
        unitPrice: '0.01',
      }),
    );
    expect(amounts.calculatedAmount).toBe('0.05');
    expect(amounts.upstreamCost).toBe('0.05');
  });

  it('官方价口径防御：负单价不计费（钳 0），金额永不为负', () => {
    const amounts = computeAmounts(
      receipt({
        usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, estimated: false, units: 3 },
        unitPrice: '-1',
        inputPrice: '-5',
        outputPrice: '-5',
        cacheInputPrice: '-5',
      }),
    );
    expect(amounts.upstreamCost).toBe('0');
    expect(amounts.calculated.toNumber()).toBeGreaterThanOrEqual(0);
  });
});
