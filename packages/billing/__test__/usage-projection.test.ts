/**
 * usage_logs 投影装配规格：pricing_window 审计列（schedule 策略标签）的落列与兜底。
 * 其余列映射由 settlement 集成面覆盖（processClaim → insertUsageLog 幂等链）。
 */
import { describe, expect, it } from 'vitest';
import { usageLogProjection } from '../src/application/settlement/usage-projection.js';
import type { UsageReceipt } from '../src/domain/rating/types.js';

function receiptOf(over: Partial<UsageReceipt> = {}): UsageReceipt {
  return {
    requestId: 'r-1',
    userId: 1,
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: 'm',
    realModel: 'real-m',
    channelId: null,
    channelKey: 'c',
    usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, estimated: false },
    inputPrice: '1',
    outputPrice: '2',
    cacheInputPrice: '1',
    coefficient: '1',
    durationMs: 100,
    stream: false,
    streamAborted: false,
    mappingId: 1,
    billingPolicyFingerprint: null,
    ...over,
  };
}

const billing = { userId: 1, subscriptionId: null, channelId: null };

describe('usageLogProjection（pricing_window 审计列）', () => {
  it('收据带 pricingWindow → 落列；缺省 → null（无时段策略/历史行口径）', () => {
    const withWindow = usageLogProjection({
      receipt: receiptOf({ pricingWindow: '谷时段' }),
      billing,
      calculatedAmount: '0.001',
      upstreamCost: '0.001',
      planConsume: '0',
    });
    expect(withWindow.pricingWindow).toBe('谷时段');

    const withoutWindow = usageLogProjection({
      receipt: receiptOf(),
      billing,
      calculatedAmount: '0.001',
      upstreamCost: '0.001',
      planConsume: '0',
    });
    expect(withoutWindow.pricingWindow).toBeNull();
  });
});
