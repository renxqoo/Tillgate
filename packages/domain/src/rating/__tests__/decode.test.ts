/** durable 收据解码守卫：结构/数值/价格形态不过即毒收据。 */
import { describe, expect, it } from 'vitest';
import { PoisonReceiptError } from '../errors.js';
import { decodeReceipt } from '../decode.js';
import type { UsageReceipt } from '../types.js';

const healthy: UsageReceipt = {
  requestId: 'r1', userId: 1, apiKeyId: null, appId: null, credentialType: 'key',
  externalModel: 'gpt-x', realModel: 'gpt-real', channelId: null, channelKey: 'test',
  usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 5, estimated: false },
  inputPrice: '2', outputPrice: '0', cacheInputPrice: '2', coefficient: '1',
  durationMs: 50, stream: false, streamAborted: false, mappingId: 1,
  billingPolicyFingerprint: null,
};

describe('decodeReceipt', () => {
  it('健康收据原样通过（含 jsonb 字符串形态）', () => {
    expect(decodeReceipt(healthy)).toBe(healthy);
    expect(decodeReceipt(JSON.stringify(healthy)).requestId).toBe('r1');
  });

  it('null / 非对象 / 缺字段 → 毒收据', () => {
    expect(() => decodeReceipt(null)).toThrow(PoisonReceiptError);
    expect(() => decodeReceipt('not-json')).toThrow();
    expect(() => decodeReceipt({ garbage: true })).toThrow(PoisonReceiptError);
  });

  it('数值/价格形态不健康 → 毒收据', () => {
    const badUsage = { ...healthy, usage: { ...healthy.usage, inputTokens: -1 } };
    expect(() => decodeReceipt(badUsage)).toThrow(PoisonReceiptError);
    const badPrice = { ...healthy, inputPrice: 'NaN' };
    expect(() => decodeReceipt(badPrice)).toThrow(PoisonReceiptError);
    const badFingerprint = { ...healthy, billingPolicyFingerprint: 'zz' };
    expect(() => decodeReceipt(badFingerprint)).toThrow(PoisonReceiptError);
  });
});
