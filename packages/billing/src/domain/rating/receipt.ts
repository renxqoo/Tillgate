/**
 * durable receipt 验收（纯函数）：用户一致、usage 数值自洽、估算归属合法、
 * 价格快照必须命中授权 quote 的候选（防中途改价算错账）。
 * 验收失败全部是毒收据家族（billing.poison_receipt / billing.receipt_user_mismatch）——
 * 结算侧按码判 dead，不靠 message 文本；价格比较已加固（垃圾串构造异常不逃逸）。
 */
import { BillingErrors } from '../errors.js';
import { finiteDecimal } from './decode.js';
import { isAttributedEstimate, type BillingQuote, type UsageReceipt } from './types.js';

function decimalEq(left: string, right: string): boolean {
  const a = finiteDecimal(left);
  const b = finiteDecimal(right);
  return a !== null && b !== null && a.eq(b);
}

export function validateReceipt(userId: number, quote: BillingQuote, receipt: UsageReceipt): void {
  if (receipt.userId !== userId) {
    throw BillingErrors.business('receipt_user_mismatch', {
      expected: userId,
      actual: receipt.userId,
    });
  }
  if (receipt.usage.estimated && !isAttributedEstimate(receipt)) {
    throw BillingErrors.business('poison_receipt', { stage: 'estimated_usage' });
  }
  const usageValues = [
    receipt.usage.inputTokens,
    receipt.usage.cachedInputTokens,
    receipt.usage.outputTokens,
    receipt.usage.units ?? 0,
    receipt.durationMs,
  ];
  if (usageValues.some((value) => !Number.isFinite(value) || value < 0)) {
    throw BillingErrors.business('poison_receipt', { stage: 'invalid_usage' });
  }
  if (
    !Number.isInteger(receipt.usage.inputTokens) ||
    !Number.isInteger(receipt.usage.cachedInputTokens) ||
    !Number.isInteger(receipt.usage.outputTokens) ||
    !Number.isInteger(receipt.usage.units ?? 0) ||
    receipt.usage.cachedInputTokens > receipt.usage.inputTokens
  ) {
    throw BillingErrors.business('poison_receipt', { stage: 'invalid_usage' });
  }
  const authorized = quote.candidates.some(
    (item) =>
      item.mappingId === receipt.mappingId &&
      item.externalModel === receipt.externalModel &&
      item.realModel === receipt.realModel &&
      decimalEq(item.inputPrice, receipt.inputPrice) &&
      decimalEq(item.outputPrice, receipt.outputPrice) &&
      decimalEq(item.cacheInputPrice, receipt.cacheInputPrice) &&
      decimalEq(item.unitPrice ?? '0', receipt.unitPrice ?? '0') &&
      decimalEq(item.coefficient, receipt.coefficient) &&
      item.billingPolicyFingerprint === receipt.billingPolicyFingerprint,
  );
  if (!authorized) {
    throw BillingErrors.business('poison_receipt', { stage: 'not_authorized' });
  }
  // 收据校验不用「字节数上界 vs 真实 token 数」判死：厂商会报隐藏 system/cached
  // token。真正的资损不变量是「金额」——结算的 settle ≤ hold / 补充授权已保证。
}
