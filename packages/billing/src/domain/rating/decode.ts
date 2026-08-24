/**
 * durable 收据解码守卫（纯函数）：billing_requests.receipt 落库为 jsonb，
 * 结算读取时先过本守卫——结构/数值/价格形态任一不过即毒收据（dead 人工）。
 * 与 validateReceipt（验收期、对 quote 比对）分工：解码期只看自身结构健康。
 * B3 修复：价格字符串垃圾（如 'abc'）会使 Decimal 构造器抛异常——统一捕获归类
 * 毒收据（billing.poison_receipt），不得逃逸出死信家族被误判为瞬态错误。
 */
import { Decimal } from '../money.js';
import { BillingErrors } from '../errors.js';
import type { UsageReceipt } from './types.js';

/** 构造可失败的 Decimal：垃圾串/非有限 → null（B3：构造异常不逃逸） */
export function finiteDecimal(value: string): Decimal | null {
  try {
    const d = new Decimal(value);
    return d.isFinite() ? d : null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line complexity -- 用量收据防御式解码:垃圾形状枚举分支平铺
export function decodeReceipt(
  value: UsageReceipt | string | Record<string, unknown> | null,
): UsageReceipt {
  const receipt = (typeof value === 'string' ? JSON.parse(value) : value) as UsageReceipt | null;
  const usage = receipt?.usage;
  // usage 非空蕴涵 receipt 非空(usage 派生自 receipt?.usage),条件位显式收窄
  const numeric =
    usage && receipt
      ? [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, receipt.durationMs]
      : [];
  const prices = receipt
    ? [receipt.inputPrice, receipt.outputPrice, receipt.cacheInputPrice, receipt.coefficient]
    : [];
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    typeof receipt.requestId !== 'string' ||
    !Number.isInteger(receipt.userId) ||
    receipt.userId <= 0 ||
    !usage ||
    numeric.some((item) => !Number.isFinite(item) || item < 0) ||
    prices.some((item) => typeof item !== 'string' || finiteDecimal(item) === null) ||
    typeof receipt.externalModel !== 'string' ||
    typeof receipt.realModel !== 'string' ||
    !Number.isInteger(receipt.mappingId) ||
    (receipt.billingPolicyFingerprint !== null &&
      !/^[a-f0-9]{64}$/.test(receipt.billingPolicyFingerprint ?? ''))
  ) {
    throw BillingErrors.business('poison_receipt', { stage: 'decode' });
  }
  return receipt;
}
