import { createHash } from 'node:crypto';
import { Decimal, estimateMaxCost, requiredReservation, toDecimal, ReservationError } from '@ai-gateway/money';
import { isAttributedEstimate, type BillingQuote, type UsageReceipt } from './types.js';
import { BillingConfigurationError, ReceiptUserMismatchError } from './errors.js';

/**
 * 报价与收据校验（纯函数，无 DB）：授权金额推导 + durable receipt 验收。
 * 单一真相——authorize（落账前）、signal（收据入库前）、复核补录共用。
 */

export function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function leaseUntil(now: Date, leaseMs: number): Date {
  if (!Number.isFinite(leaseMs) || leaseMs <= 0)
    throw new BillingConfigurationError('invalid_quote');
  return new Date(now.getTime() + leaseMs);
}

/**
 * 授权金额推导：候选链取最贵（fallback 更贵不得透支），再按单请求上限校验。
 * 免费口径一致性（R6）：explicitlyFree 是「授权 0 元、不校验余额」的开关，
 * 若候选价格非全零，结算会按价格实扣——授权与结算两套口径。结构上拒绝该矛盾配置。
 */
export function calculateRequired(quote: BillingQuote, limit: string): Decimal {
  if (quote.candidates.length === 0) throw new BillingConfigurationError('invalid_quote');
  if (quote.explicitlyFree) {
    const charged = quote.candidates.some((candidate) => {
      const prices = [
        candidate.inputPrice,
        candidate.outputPrice,
        candidate.cacheInputPrice,
        candidate.unitPrice ?? '0',
      ];
      return prices.some((price) => toDecimal(price).gt(0));
    });
    if (charged) throw new BillingConfigurationError('invalid_quote');
    return new Decimal(0);
  }

  let maximum = new Decimal(0);
  for (const candidate of quote.candidates) {
    const coefficient = toDecimal(candidate.coefficient);
    const prices = [
      toDecimal(candidate.inputPrice),
      toDecimal(candidate.outputPrice),
      toDecimal(candidate.cacheInputPrice),
      toDecimal(candidate.unitPrice ?? 0),
    ];
    if (!coefficient.isFinite() || coefficient.lte(0)) {
      throw new BillingConfigurationError('invalid_coefficient');
    }
    if (prices.some((price) => !price.isFinite() || price.lt(0))) {
      throw new BillingConfigurationError('invalid_quote');
    }
    const estimate = estimateMaxCost({
      estimatedInputTokens: candidate.inputTokenUpperBound,
      maxOutputTokens: quote.maxOutputTokens,
      inputPrice: candidate.inputPrice,
      cacheInputPrice: candidate.cacheInputPrice,
      outputPrice: candidate.outputPrice,
      unitPrice: candidate.unitPrice ?? 0,
      unitUpperBound: candidate.unitUpperBound ?? 0,
      coefficient,
    });
    if (estimate.gt(maximum)) maximum = estimate;
  }
  if (maximum.lte(0)) throw new BillingConfigurationError('invalid_quote');
  try {
    return requiredReservation(maximum, limit);
  } catch (error) {
    if (error instanceof ReservationError && error.code === 'reservation_limit_exceeded') {
      throw new BillingConfigurationError('reservation_limit_exceeded');
    }
    throw new BillingConfigurationError('invalid_quote');
  }
}

/**
 * durable receipt 验收：用户一致、usage 数值自洽、估算归属合法（G1 精细化：
 * 估算 usage 只允许归属「用户取消 ∪ 完成缺 usage」，判定与 settle 共用单一真相）、
 * 价格快照必须命中授权 quote 的候选（防中途改价算错账）。
 */
export function validateReceipt(userId: number, quote: BillingQuote, receipt: UsageReceipt): void {
  if (receipt.userId !== userId) throw new ReceiptUserMismatchError();
  if (receipt.usage.estimated && !isAttributedEstimate(receipt)) {
    throw new Error('billing_receipt_estimated_usage');
  }
  const usageValues = [
    receipt.usage.inputTokens,
    receipt.usage.cachedInputTokens,
    receipt.usage.outputTokens,
    receipt.usage.units ?? 0,
    receipt.durationMs,
  ];
  if (usageValues.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('billing_receipt_invalid_usage');
  }
  if (
    !Number.isInteger(receipt.usage.inputTokens) ||
    !Number.isInteger(receipt.usage.cachedInputTokens) ||
    !Number.isInteger(receipt.usage.outputTokens) ||
    !Number.isInteger(receipt.usage.units ?? 0) ||
    receipt.usage.cachedInputTokens > receipt.usage.inputTokens
  ) {
    throw new Error('billing_receipt_invalid_usage');
  }
  const authorized = quote.candidates.some(
    (item) =>
      item.mappingId === receipt.mappingId &&
      item.externalModel === receipt.externalModel &&
      item.realModel === receipt.realModel &&
      toDecimal(item.inputPrice).eq(receipt.inputPrice) &&
      toDecimal(item.outputPrice).eq(receipt.outputPrice) &&
      toDecimal(item.cacheInputPrice).eq(receipt.cacheInputPrice) &&
      toDecimal(item.unitPrice ?? 0).eq(receipt.unitPrice ?? '0') &&
      toDecimal(item.coefficient).eq(receipt.coefficient) &&
      item.billingPolicyFingerprint === receipt.billingPolicyFingerprint,
  );
  if (!authorized) throw new Error('billing_receipt_not_authorized');
  // 06 修复：收据校验不用「字节数上界 vs 真实 token 数」判死——厂商会报隐藏的
  // system/cached token（inputTokens 可远超字节数）。真正的资损不变量是「金额」：
  // settleClaim 的信用地板约束已确保绝不超预扣扣款，无需在此重复用 token 计数设防。
}
