/** rating/quote 特征规格（纯迁移自 billing/quote，行为零变更）：
 *  授权金额推导 = 候选链最坏费用 → 单请求上限校验；收据验收 = 用户一致 +
 *  估算归属合法 + usage 自洽 + 价格快照命中授权候选。 */
import { describe, expect, it } from 'vitest';
import { calculateRequired, validateReceipt } from '../quote.js';
import type { BillingQuote, BillingQuoteCandidate, UsageReceipt } from '../types.js';
import { BillingConfigurationError, ReceiptUserMismatchError } from '../../platform/errors.js';

function candidate(overrides: Partial<BillingQuoteCandidate> = {}): BillingQuoteCandidate {
  return {
    mappingId: 1,
    externalModel: 'gpt-x',
    realModel: 'gpt-real',
    inputPrice: '2',
    outputPrice: '3',
    cacheInputPrice: '1',
    coefficient: '1',
    inputTokenUpperBound: 1_000_000,
    billingPolicyFingerprint: null,
    ...overrides,
  };
}

function quote(candidates: BillingQuoteCandidate[], explicitlyFree?: boolean): BillingQuote {
  return { maxOutputTokens: 0, candidates, explicitlyFree };
}

/** 断言配置错误 code（类 + code 双命中才过） */
function expectConfigCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BillingConfigurationError);
  expect((caught as BillingConfigurationError).code).toBe(code);
}

describe('calculateRequired：候选链最坏费用授权推导', () => {
  it('取候选链最贵者（fallback 更贵不得透支）', () => {
    const required = calculateRequired(
      quote([candidate({ inputPrice: '2' }), candidate({ inputPrice: '5', mappingId: 2 })]),
      '10',
    );
    expect(required.toString()).toBe('5');
  });

  it('输入按两种输入单价较高者覆盖（缓存价更高时按缓存价押）', () => {
    const required = calculateRequired(
      quote([candidate({ inputPrice: '2', cacheInputPrice: '4' })]),
      '10',
    );
    expect(required.toString()).toBe('4');
  });

  it('系数放大预扣（费率卡口径参与最坏费用）', () => {
    const required = calculateRequired(quote([candidate({ coefficient: '1.5' })]), '10');
    expect(required.toString()).toBe('3');
  });

  it('explicitlyFree 候选全零价 → 授权 0 元', () => {
    const required = calculateRequired(
      quote(
        [
          candidate({
            inputPrice: '0',
            outputPrice: '0',
            cacheInputPrice: '0',
            unitPrice: '0',
          }),
        ],
        true,
      ),
      '10',
    );
    expect(required.toString()).toBe('0');
  });

  it('R6 免费口径一致性：explicitlyFree 但候选有价 → 结构性拒绝', () => {
    expectConfigCode(() => calculateRequired(quote([candidate()], true), '10'), 'invalid_quote');
  });

  it('非法配置面：空候选 / 负价 / 全零价非免费 → invalid_quote', () => {
    expectConfigCode(() => calculateRequired(quote([]), '10'), 'invalid_quote');
    expectConfigCode(
      () => calculateRequired(quote([candidate({ inputPrice: '-1' })]), '10'),
      'invalid_quote',
    );
    expectConfigCode(
      () =>
        calculateRequired(
          quote([candidate({ inputPrice: '0', outputPrice: '0', cacheInputPrice: '0' })]),
          '10',
        ),
      'invalid_quote',
    );
  });

  it('非正系数 → invalid_coefficient', () => {
    expectConfigCode(
      () => calculateRequired(quote([candidate({ coefficient: '0' })]), '10'),
      'invalid_coefficient',
    );
  });

  it('超过单请求预扣上限 → reservation_limit_exceeded（拒绝，绝不截断）', () => {
    // 基础估算 2 元 > 上限 1 元 → 拒绝
    expectConfigCode(() => calculateRequired(quote([candidate()]), '1'), 'reservation_limit_exceeded');
    // 上限本身非法同样按配置错误拒绝
    expectConfigCode(() => calculateRequired(quote([candidate()]), '0'), 'invalid_quote');
  });
});

function receiptFor(
  cand: BillingQuoteCandidate,
  userId: number,
  overrides: Partial<UsageReceipt> = {},
): UsageReceipt {
  return {
    requestId: 'req-1',
    userId,
    apiKeyId: null,
    appId: null,
    credentialType: 'key',
    externalModel: cand.externalModel,
    realModel: cand.realModel,
    channelId: 1,
    channelKey: 'ch',
    usage: { inputTokens: 100, cachedInputTokens: 10, outputTokens: 50, estimated: false },
    inputPrice: cand.inputPrice,
    outputPrice: cand.outputPrice,
    cacheInputPrice: cand.cacheInputPrice,
    unitPrice: cand.unitPrice,
    coefficient: cand.coefficient,
    durationMs: 1_200,
    stream: false,
    streamAborted: false,
    mappingId: cand.mappingId,
    billingPolicyFingerprint: cand.billingPolicyFingerprint,
    ...overrides,
  };
}

describe('validateReceipt：durable receipt 验收', () => {
  const cand = candidate();

  it('收据用户与授权账单一致、快照命中候选 → 通过', () => {
    expect(() => validateReceipt(7, quote([cand]), receiptFor(cand, 7))).not.toThrow();
  });

  it('userId 不一致 → ReceiptUserMismatchError（毒收据，dead 人工）', () => {
    expect(() => validateReceipt(7, quote([cand]), receiptFor(cand, 8))).toThrow(
      ReceiptUserMismatchError,
    );
  });

  it('G1：估算 usage 无归属 / 归属不在白名单 → 拒绝', () => {
    const estimated = {
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0, estimated: true },
    };
    expect(() =>
      validateReceipt(7, quote([cand]), receiptFor(cand, 7, estimated as Partial<UsageReceipt>)),
    ).toThrow('billing_receipt_estimated_usage');
    // 恶意归属模拟：白名单外取值（类型上是非法值，故意绕过）
    expect(() =>
      validateReceipt(
        7,
        quote([cand]),
        receiptFor(cand, 7, {
          ...estimated,
          estimatedFor: 'upstream_error',
        } as unknown as Partial<UsageReceipt>),
      ),
    ).toThrow('billing_receipt_estimated_usage');
  });

  it('G1：归属合法（用户取消 ∪ 完成缺 usage）→ 估算收据可结算', () => {
    const base = {
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 0, estimated: true },
    };
    for (const estimatedFor of [
      'client_disconnect',
      'request_cancelled',
      'aborted',
      'usage_missing_completed',
      'usage_missing_nonstream',
    ] as const) {
      expect(() =>
        validateReceipt(7, quote([cand]), receiptFor(cand, 7, { ...base, estimatedFor })),
      ).not.toThrow();
    }
  });

  it('usage 数值自洽：负数 / 非整 token / cached > input → invalid_usage', () => {
    expect(() =>
      validateReceipt(
        7,
        quote([cand]),
        receiptFor(cand, 7, {
          usage: { inputTokens: -1, cachedInputTokens: 0, outputTokens: 0, estimated: false },
        }),
      ),
    ).toThrow('billing_receipt_invalid_usage');
    expect(() =>
      validateReceipt(
        7,
        quote([cand]),
        receiptFor(cand, 7, {
          usage: { inputTokens: 10.5, cachedInputTokens: 0, outputTokens: 0, estimated: false },
        }),
      ),
    ).toThrow('billing_receipt_invalid_usage');
    expect(() =>
      validateReceipt(
        7,
        quote([cand]),
        receiptFor(cand, 7, {
          usage: { inputTokens: 10, cachedInputTokens: 11, outputTokens: 0, estimated: false },
        }),
      ),
    ).toThrow('billing_receipt_invalid_usage');
  });

  it('价格快照必须命中授权候选：中途改价/改系数 → not_authorized', () => {
    expect(() =>
      validateReceipt(7, quote([cand]), receiptFor(cand, 7, { inputPrice: '99' })),
    ).toThrow('billing_receipt_not_authorized');
    expect(() =>
      validateReceipt(7, quote([cand]), receiptFor(cand, 7, { coefficient: '2' })),
    ).toThrow('billing_receipt_not_authorized');
  });
});
