/** 变更资格纯函数（S3 抽取）：只升不降 + 席位能力/企业门槛判定。 */
import { LedgerError } from '../platform/errors.js';

export interface ChangeEligibility {
  currentSortOrder: number | null;
  targetSortOrder: number | null;
  currentQuantity: number;
  targetQuantity: number;
}

/**
 * 只能升不能降：层级不降、席位不缩容，且至少一项变化。
 * 无变化 = already_subscribed（幂等/误操作统一拒绝，不产生空变更）。
 */
export function assertChangeEligibility(input: ChangeEligibility): void {
  const curSort = input.currentSortOrder ?? 0;
  const targetSort = input.targetSortOrder ?? 0;
  if (targetSort < curSort || input.targetQuantity < input.currentQuantity) {
    throw new LedgerError('downgrade_not_allowed');
  }
  if (targetSort === curSort && input.targetQuantity === input.currentQuantity) {
    throw new LedgerError('already_subscribed');
  }
}

/**
 * 席位能力判定：quantity>1 要求套餐允许席位；allowSeats 套餐要求企业账户
 * （即使 quantity=1 —— 团队套餐不卖给个人，防绕过企业验证开共享池）。
 */
export function assertSeatsAllowed(input: {
  quantity: number;
  allowSeats: boolean;
  isEnterprise: boolean | undefined;
}): void {
  if (input.quantity > 1 && !input.allowSeats) throw new LedgerError('seats_not_allowed');
  if (input.allowSeats && input.isEnterprise !== true) throw new LedgerError('enterprise_required');
}
