/** rating 测试共享夹具：候选/报价/收据构造器。 */
import type { BillingQuote, BillingQuoteCandidate, UsageReceipt } from '../types.js';

export function candidate(overrides: Partial<BillingQuoteCandidate> = {}): BillingQuoteCandidate {
  return {
    mappingId: 1, externalModel: 'gpt-x', realModel: 'gpt-real',
    inputPrice: '2', outputPrice: '6', cacheInputPrice: '1',
    coefficient: '1', inputTokenUpperBound: 1_000_000, billingPolicyFingerprint: null,
    ...overrides,
  };
}

export function quote(candidates: BillingQuoteCandidate[], explicitlyFree?: boolean): BillingQuote {
  return { maxOutputTokens: 200_000, candidates, ...(explicitlyFree ? { explicitlyFree: true } : {}) };
}

export function receiptFor(c: BillingQuoteCandidate, userId: number, overrides: Partial<UsageReceipt> = {}): UsageReceipt {
  return {
    requestId: 'r1', userId, apiKeyId: null, appId: null, credentialType: 'key',
    externalModel: c.externalModel, realModel: c.realModel, channelId: null, channelKey: 't',
    usage: { inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    inputPrice: c.inputPrice, outputPrice: c.outputPrice, cacheInputPrice: c.cacheInputPrice,
    unitPrice: c.unitPrice, coefficient: c.coefficient,
    durationMs: 10, stream: false, streamAborted: false, mappingId: c.mappingId,
    billingPolicyFingerprint: c.billingPolicyFingerprint,
    ...overrides,
  };
}
