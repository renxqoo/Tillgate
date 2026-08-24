/**
 * 收据解码与验收行为规格（迁移自旧仓 decode/receipt/attribution 测试；
 * 新增 B3 回归：垃圾价格串的 Decimal 构造异常归类毒收据，不逃逸死信家族）。
 */
import { describe, expect, it } from 'vitest';
import { isBusinessError } from '@tillgate/errors';
import { decodeReceipt } from '../src/domain/rating/decode.js';
import { validateReceipt } from '../src/domain/rating/receipt.js';
import {
  ESTIMATE_ATTRIBUTIONS,
  USER_SIDE_CANCELS,
  isAttributedEstimate,
  streamEstimateAttribution,
} from '../src/domain/rating/types.js';
import { candidate, quote, receiptFor } from './rating-fixtures.js';

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  if (!isBusinessError(caught)) throw new Error(`expected business rejection (${code})`);
  expect((caught as { code: string }).code).toBe(code);
}

describe('decodeReceipt（durable 解码守卫）', () => {
  it('健康收据原样通过（含 jsonb 字符串形态）', () => {
    const c = candidate();
    const receipt = receiptFor(c, 1);
    expect(decodeReceipt(receipt)).toBe(receipt);
    expect(decodeReceipt(JSON.stringify(receipt))).toEqual(receipt);
  });

  it('结构非法 / 数值负 / userId 非正 → 毒收据', () => {
    expectCode(() => decodeReceipt(null), 'billing.poison_receipt');
    expectCode(() => decodeReceipt({}), 'billing.poison_receipt');
    const badUsage = receiptFor(candidate(), 1, {
      usage: { inputTokens: -1, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    });
    expectCode(() => decodeReceipt(badUsage), 'billing.poison_receipt');
    expectCode(() => decodeReceipt(receiptFor(candidate(), 0)), 'billing.poison_receipt');
  });

  it('B3 回归：价格串为垃圾（Decimal 构造异常）→ 毒收据，不抛 decimal.js 异常', () => {
    for (const garbage of ['abc', '1.2.3', 'NaN', 'Infinity', '']) {
      const poisoned = receiptFor(candidate(), 1, { inputPrice: garbage });
      expectCode(() => decodeReceipt(poisoned), 'billing.poison_receipt');
      const poisonedCoeff = receiptFor(candidate(), 1, { coefficient: garbage });
      expectCode(() => decodeReceipt(poisonedCoeff), 'billing.poison_receipt');
    }
  });

  it('billingPolicyFingerprint 非 64 位 hex → 毒收据；null 合法（纯文本）', () => {
    expectCode(
      () => decodeReceipt(receiptFor(candidate(), 1, { billingPolicyFingerprint: 'xyz' })),
      'billing.poison_receipt',
    );
    expect(() =>
      decodeReceipt(receiptFor(candidate({ billingPolicyFingerprint: 'a'.repeat(64) }), 1)),
    ).not.toThrow();
  });
});

describe('validateReceipt（验收）', () => {
  it('授权候选命中（价格按 Decimal 数值比较，"1.0" 与 "1.00" 等价）→ 通过', () => {
    const c = candidate({ inputPrice: '2.0' });
    const receipt = receiptFor({ ...c, inputPrice: '2.00' }, 1);
    expect(() => validateReceipt(1, quote([c]), receipt)).not.toThrow();
  });

  it('用户错配 → receipt_user_mismatch（毒收据家族）', () => {
    expectCode(
      () => validateReceipt(2, quote([candidate()]), receiptFor(candidate(), 1)),
      'billing.receipt_user_mismatch',
    );
  });

  it('估算收据无归属 / 白名单外归属 → 毒收据', () => {
    const unattributed = receiptFor(candidate(), 1, {
      usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, estimated: true },
    });
    expectCode(
      () => validateReceipt(1, quote([candidate()]), unattributed),
      'billing.poison_receipt',
    );
    const bogus = receiptFor(candidate(), 1, {
      usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 0, estimated: true },
      estimatedFor: 'not_in_whitelist' as never,
    });
    expectCode(() => validateReceipt(1, quote([candidate()]), bogus), 'billing.poison_receipt');
  });

  it('usage 非整数 / cached > input → 毒收据', () => {
    const fractional = receiptFor(candidate(), 1, {
      usage: { inputTokens: 1.5, cachedInputTokens: 0, outputTokens: 0, estimated: false },
    });
    expectCode(
      () => validateReceipt(1, quote([candidate()]), fractional),
      'billing.poison_receipt',
    );
    const inverted = receiptFor(candidate(), 1, {
      usage: { inputTokens: 10, cachedInputTokens: 11, outputTokens: 0, estimated: false },
    });
    expectCode(() => validateReceipt(1, quote([candidate()]), inverted), 'billing.poison_receipt');
  });

  it('价格快照未命中授权候选（中途改价）→ 毒收据', () => {
    const authorized = quote([candidate()]);
    const drifted = receiptFor(candidate({ inputPrice: '3' }), 1);
    expectCode(() => validateReceipt(1, authorized, drifted), 'billing.poison_receipt');
    const changedModel = receiptFor(candidate({ realModel: 'other' }), 1);
    expectCode(() => validateReceipt(1, authorized, changedModel), 'billing.poison_receipt');
  });

  it('B3 回归：验收比较遇垃圾价格串归类毒收据（构造异常不逃逸）', () => {
    const garbage = receiptFor(candidate(), 1, { inputPrice: 'abc' });
    expectCode(() => validateReceipt(1, quote([candidate()]), garbage), 'billing.poison_receipt');
  });
});

describe('估算归属词表（封闭性）', () => {
  it('ESTIMATE_ATTRIBUTIONS = 用户取消三态 + 缺 usage/部分交付细分（8 项封闭）', () => {
    expect([...ESTIMATE_ATTRIBUTIONS].toSorted()).toEqual(
      [
        ...USER_SIDE_CANCELS,
        'usage_missing_completed',
        'usage_missing_nonstream',
        'upstream_error_partial',
        'inactivity_timeout',
        'server_draining',
      ].toSorted(),
    );
  });

  it('streamEstimateAttribution：undefined→completed；用户取消归一；未知值绝不回落 completed', () => {
    expect(streamEstimateAttribution()).toBe('usage_missing_completed');
    expect(streamEstimateAttribution('aborted')).toBe('client_disconnect');
    expect(streamEstimateAttribution('inactivity')).toBe('inactivity_timeout');
    expect(streamEstimateAttribution('server_draining')).toBe('server_draining');
    expect(streamEstimateAttribution('provider_zombie')).toBe('upstream_error_partial');
  });

  it('isAttributedEstimate：白名单内真、白名单外/无估算假', () => {
    const base = receiptFor(candidate(), 1);
    expect(
      isAttributedEstimate({
        ...base,
        usage: { ...base.usage, estimated: true },
        estimatedFor: 'client_disconnect',
      }),
    ).toBe(true);
    expect(
      isAttributedEstimate({
        ...base,
        usage: { ...base.usage, estimated: true },
        estimatedFor: undefined,
      }),
    ).toBe(false);
    expect(isAttributedEstimate(base)).toBe(false);
  });
});
