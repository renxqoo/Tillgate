/**
 * usage_logs 投影装配规格：pricing_window 审计列（schedule 策略标签）的落列与兜底；
 * usage_clamps 审计列（结算验收门钳制事实的「发票 → 验收」轨迹）。
 * 其余列映射由 settlement 集成面覆盖（processClaim → insertUsageLog 幂等链）。
 */
import { describe, expect, it } from 'vitest';
import { usageLogProjection } from '../src/application/settlement/usage-projection.js';
import type { UsageReceipt } from '../src/domain/rating/types.js';
import type { UsageClamp } from '../src/domain/rating/usage-acceptance.js';

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

describe('usageLogProjection（usage_clamps 钳制审计列）', () => {
  const clamps: UsageClamp[] = [
    { kind: 'input_bound', field: 'inputTokens', original: 120, clamped: 116, bound: 116 },
  ];

  it('验收门钳制事实 → 落列（发票 → 验收轨迹可追溯）', () => {
    const row = usageLogProjection({
      receipt: receiptOf(),
      billing,
      calculatedAmount: '0.001',
      upstreamCost: '0.001',
      planConsume: '0',
      clamps,
    });
    expect(row.usageClamps).toEqual(clamps);
  });

  it('无钳制（诚实发票/估算收据）→ null', () => {
    const row = usageLogProjection({
      receipt: receiptOf(),
      billing,
      calculatedAmount: '0.001',
      upstreamCost: '0.001',
      planConsume: '0',
    });
    expect(row.usageClamps).toBeNull();
    const emptyClamps = usageLogProjection({
      receipt: receiptOf(),
      billing,
      calculatedAmount: '0.001',
      upstreamCost: '0.001',
      planConsume: '0',
      clamps: [],
    });
    expect(emptyClamps.usageClamps).toBeNull();
  });
});
