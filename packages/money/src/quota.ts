import { Decimal } from 'decimal.js';
import { toDecimal } from './units.js';

/**
 * 套餐额度扣减 与 预扣对账（重构后：元 + decimal 全精度）。
 */

/** 套餐额度扣减：单请求内先扣套餐，剩余走余额（billed_by=both） */
export function deductQuota(
  amount: Decimal | string | number,
  remainingQuota: Decimal | string | number,
): { planAmount: Decimal; remaining: Decimal } {
  const amt = toDecimal(amount);
  const quota = toDecimal(remainingQuota);
  const planAmount = amt.lte(quota) ? amt : quota;
  return { planAmount, remaining: quota.minus(planAmount) };
}

/**
 * 预扣对账：payg > hold → 补扣差额；payg ≤ hold → 退款差额。
 * （注：当前架构下 settle 直接扣全额实际费用 + DEL hold，此函数为预留的显式对账工具）
 */
export function settleAgainstHold(
  paygAmount: Decimal | string | number,
  hold: Decimal | string | number,
): { deduct: Decimal; refund: Decimal } {
  const payg = toDecimal(paygAmount);
  const h = toDecimal(hold);
  if (payg.gt(h)) {
    return { deduct: payg.minus(h), refund: new Decimal(0) };
  }
  return { deduct: new Decimal(0), refund: h.minus(payg) };
}
