/**
 * 套餐额度扣减 与 预扣对账（requirements.md 4.9 / data-model.md §5）
 */

/** 套餐额度扣减：单请求内先扣套餐，剩余走余额（billed_by=both） */
export function deductQuota(
  amount: number,
  remainingQuota: number,
): { planAmount: number; remaining: number } {
  const planAmount = Math.min(amount, remainingQuota);
  return { planAmount, remaining: remainingQuota - planAmount };
}

/** 预扣对账：payg > hold → 补扣差额；payg ≤ hold → 退款差额 */
export function settleAgainstHold(
  paygAmount: number,
  hold: number,
): { deduct: number; refund: number } {
  if (paygAmount > hold) {
    return { deduct: paygAmount - hold, refund: 0 };
  }
  return { deduct: 0, refund: hold - paygAmount };
}
