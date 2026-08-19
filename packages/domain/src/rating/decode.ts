/**
 * durable 收据解码守卫（纯函数）：billing_requests.receipt 落库为 jsonb，
 * 结算读取时先过本守卫——结构/数值/价格形态任一不过即毒收据（dead 人工）。
 * 与 validateReceipt（验收期、对 quote 比对）分工：解码期只看自身结构健康。
 */
import { Decimal } from '../wallet/money.js';
import { PoisonReceiptError } from './errors.js';
import type { UsageReceipt } from './types.js';

export function decodeReceipt(
  value: UsageReceipt | string | Record<string, unknown> | null,
): UsageReceipt {
  const receipt = (typeof value === 'string' ? JSON.parse(value) : value) as UsageReceipt | null;
  const usage = receipt?.usage;
  const numeric = usage
    ? [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, receipt!.durationMs]
    : [];
  const prices = receipt
    ? [receipt!.inputPrice, receipt!.outputPrice, receipt!.cacheInputPrice, receipt!.coefficient]
    : [];
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    typeof receipt.requestId !== 'string' ||
    !Number.isInteger(receipt.userId) ||
    receipt.userId <= 0 ||
    !usage ||
    numeric.some((item) => !Number.isFinite(item) || item < 0) ||
    prices.some((item) => typeof item !== 'string' || !new Decimal(item).isFinite()) ||
    typeof receipt.externalModel !== 'string' ||
    typeof receipt.realModel !== 'string' ||
    !Number.isInteger(receipt.mappingId) ||
    (receipt.billingPolicyFingerprint !== null &&
      !/^[a-f0-9]{64}$/.test(receipt.billingPolicyFingerprint ?? ''))
  ) {
    throw new PoisonReceiptError();
  }
  return receipt;
}
