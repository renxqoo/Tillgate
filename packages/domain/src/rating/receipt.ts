/**
 * durable receipt 验收（纯函数）：用户一致、usage 数值自洽、估算归属合法（G1）、
 * 价格快照必须命中授权 quote 的候选（防中途改价算错账）。
 * 验收失败全部是毒收据家族——结算侧 instanceof 判定即 dead，不靠 message 文本。
 */
import { Decimal } from '../wallet/money.js';
import { PoisonReceiptError, ReceiptUserMismatchError } from './errors.js';
import { isAttributedEstimate, type BillingQuote, type UsageReceipt } from './types.js';

export function validateReceipt(
  userId: number,
  quote: BillingQuote,
  receipt: UsageReceipt,
): void {
  if (receipt.userId !== userId) throw new ReceiptUserMismatchError();
  if (receipt.usage.estimated && !isAttributedEstimate(receipt)) {
    throw new PoisonReceiptError('billing_receipt_estimated_usage');
  }
  const usageValues = [
    receipt.usage.inputTokens,
    receipt.usage.cachedInputTokens,
    receipt.usage.outputTokens,
    receipt.usage.units ?? 0,
    receipt.durationMs,
  ];
  if (usageValues.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new PoisonReceiptError('billing_receipt_invalid_usage');
  }
  if (
    !Number.isInteger(receipt.usage.inputTokens) ||
    !Number.isInteger(receipt.usage.cachedInputTokens) ||
    !Number.isInteger(receipt.usage.outputTokens) ||
    !Number.isInteger(receipt.usage.units ?? 0) ||
    receipt.usage.cachedInputTokens > receipt.usage.inputTokens
  ) {
    throw new PoisonReceiptError('billing_receipt_invalid_usage');
  }
  const authorized = quote.candidates.some(
    (item) =>
      item.mappingId === receipt.mappingId &&
      item.externalModel === receipt.externalModel &&
      item.realModel === receipt.realModel &&
      new Decimal(item.inputPrice).eq(receipt.inputPrice) &&
      new Decimal(item.outputPrice).eq(receipt.outputPrice) &&
      new Decimal(item.cacheInputPrice).eq(receipt.cacheInputPrice) &&
      new Decimal(item.unitPrice ?? 0).eq(receipt.unitPrice ?? '0') &&
      new Decimal(item.coefficient).eq(receipt.coefficient) &&
      item.billingPolicyFingerprint === receipt.billingPolicyFingerprint,
  );
  if (!authorized) throw new PoisonReceiptError('billing_receipt_not_authorized');
  // 收据校验不用「字节数上界 vs 真实 token 数」判死：厂商会报隐藏 system/cached
  // token。真正的资损不变量是「金额」——结算的 settle ≤ hold / 补充授权已保证。
}
