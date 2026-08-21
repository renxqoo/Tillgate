import { describe, expect, it } from 'vitest';
import { PoisonReceiptError, ReceiptUserMismatchError } from '../errors.js';
import { validateReceipt } from '../receipt.js';
import { candidate, quote, receiptFor } from './fixtures.js';
import type { UsageReceipt } from '../types.js';

describe('validateReceipt（收据验收）', () => {
  it('用户一致、快照命中候选 → 通过', () => {
    expect(() => validateReceipt(7, quote([candidate()]), receiptFor(candidate(), 7))).not.toThrow();
  });

  it('userId 不一致 → ReceiptUserMismatch（毒收据）', () => {
    expect(() => validateReceipt(7, quote([candidate()]), receiptFor(candidate(), 8))).toThrow(
      ReceiptUserMismatchError,
    );
  });

  it('G1：估算 usage 无归属 / 白名单外归属 → 拒绝；合法归属 → 放行', () => {
    const estimated = { usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, estimated: true } };
    expect(() =>
      validateReceipt(7, quote([candidate()]), receiptFor(candidate(), 7, estimated as Partial<UsageReceipt>)),
    ).toThrow(PoisonReceiptError);
    expect(() =>
      validateReceipt(7, quote([candidate()]), receiptFor(candidate(), 7, {
        ...estimated, estimatedFor: 'upstream_error',
      } as unknown as Partial<UsageReceipt>)),
    ).toThrow(PoisonReceiptError);
    for (const estimatedFor of ['client_disconnect', 'request_cancelled', 'aborted', 'usage_missing_completed', 'usage_missing_nonstream'] as const) {
      expect(() =>
        validateReceipt(7, quote([candidate()]), receiptFor(candidate(), 7, { ...estimated, estimatedFor } as unknown as Partial<UsageReceipt>)),
      ).not.toThrow();
    }
  });

  it('usage 非法（负数/非整数/cached>input/durationMs 负）→ 拒绝', () => {
    expect(() =>
      validateReceipt(7, quote([candidate()]), receiptFor(candidate(), 7, { usage: { inputTokens: -1, cachedInputTokens: 0, outputTokens: 0, estimated: false } })),
    ).toThrow(PoisonReceiptError);
    expect(() =>
      validateReceipt(7, quote([candidate()]), receiptFor(candidate(), 7, { usage: { inputTokens: 1.5, cachedInputTokens: 0, outputTokens: 0, estimated: false } })),
    ).toThrow(PoisonReceiptError);
    expect(() =>
      validateReceipt(7, quote([candidate()]), receiptFor(candidate(), 7, { usage: { inputTokens: 1, cachedInputTokens: 2, outputTokens: 0, estimated: false } })),
    ).toThrow(PoisonReceiptError);
    expect(() =>
      validateReceipt(7, quote([candidate()]), receiptFor(candidate(), 7, { durationMs: -5 })),
    ).toThrow(PoisonReceiptError);
  });

  it('价格快照未命中授权候选（中途改价/换模型/换系数/换策略指纹）→ 拒绝', () => {
    expect(() =>
      validateReceipt(7, quote([candidate()]), receiptFor(candidate(), 7, { inputPrice: '3' })),
    ).toThrow(PoisonReceiptError);
    expect(() =>
      validateReceipt(7, quote([candidate()]), receiptFor(candidate(), 7, { mappingId: 99 })),
    ).toThrow(PoisonReceiptError);
    expect(() =>
      validateReceipt(7, quote([candidate()]), receiptFor(candidate(), 7, { coefficient: '2' })),
    ).toThrow(PoisonReceiptError);
    expect(() =>
      validateReceipt(7, quote([candidate()]), receiptFor(candidate(), 7, { billingPolicyFingerprint: 'deadbeef' })),
    ).toThrow(PoisonReceiptError);
  });
}
);
