/**
 * 订阅生命周期纯规则：窗口顺延、线性折旧、升档资格、席位能力。全部纯函数——SQL 与资金动词在 service 层。
 */
import { Decimal } from '../wallet/money.js';
import { SubscriptionDomainError } from './errors.js';

/** 续费起点：未到期续费从旧 end 起（顺延），到期后续费从 now 起。 */
export function renewalStart(oldEnd: Date, now: Date): Date {
  return oldEnd.getTime() > now.getTime() ? new Date(oldEnd.getTime()) : new Date(now.getTime());
}

/** 周期末点：start + periodDays 天（变更/购买一律从 now 起算新窗口）。 */
export function periodEnd(start: Date, periodDays: number): Date {
  return new Date(start.getTime() + periodDays * 86_400_000);
}

export interface QuotaSnapshot {
  quotaAmount: string;
  usedAmount: string;
  reservedAmount: string;
}

/** 剩余额度 = 总额度 − 已用 − 在途。 */
export function remainingQuota(snapshot: QuotaSnapshot): Decimal {
  return new Decimal(snapshot.quotaAmount)
    .minus(new Decimal(snapshot.usedAmount))
    .minus(new Decimal(snapshot.reservedAmount));
}

/**
 * 剩余价值 = 购买总价 × 剩余额度/总额度（线性折旧）。
 * 总额度 ≤ 0 → 0（除零防御；脏数据不得放大剩余价值）。
 */
export function remainingValue(snapshot: QuotaSnapshot & { price: string }): Decimal {
  const total = new Decimal(snapshot.quotaAmount);
  if (total.lte(0)) return new Decimal(0);
  return new Decimal(snapshot.price).times(remainingQuota(snapshot)).div(total);
}

/** 补差价 = max(0, 新总价 − 剩余价值)；≤ 0 即免费升级。 */
export function changeDiff(newTotalPrice: string, remaining: Decimal | string): Decimal {
  const diff = new Decimal(newTotalPrice).minus(remaining instanceof Decimal ? remaining : new Decimal(remaining));
  return diff.gt(0) ? diff : new Decimal(0);
}

/**
 * 只能升不能降：层级不降、席位不缩容，且至少一项变化。
 * 无变化 = already_subscribed（幂等/误操作统一拒绝，不产生空变更）。
 */
export function assertChangeEligibility(input: {
  currentSortOrder: number | null;
  targetSortOrder: number | null;
  currentQuantity: number;
  targetQuantity: number;
}): void {
  const curSort = input.currentSortOrder ?? 0;
  const targetSort = input.targetSortOrder ?? 0;
  if (targetSort < curSort || input.targetQuantity < input.currentQuantity) {
    throw new SubscriptionDomainError('downgrade_not_allowed');
  }
  if (targetSort === curSort && input.targetQuantity === input.currentQuantity) {
    throw new SubscriptionDomainError('already_subscribed');
  }
}

/**
 * 席位能力判定：quantity>1 要求套餐允许席位；allowSeats 套餐要求企业账户
 * （即使 quantity=1——团队套餐不卖给个人，防绕过企业验证开共享池）。
 */
export function assertSeatsAllowed(input: {
  quantity: number;
  allowSeats: boolean;
  isEnterprise: boolean | undefined;
}): void {
  if (input.quantity > 1 && !input.allowSeats) throw new SubscriptionDomainError('seats_not_allowed');
  if (input.allowSeats && input.isEnterprise !== true) {
    throw new SubscriptionDomainError('enterprise_required');
  }
}

/** 数量闸：正整数（上界由 app 协议层 zod 收口） */
export function assertValidQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new SubscriptionDomainError('invalid_quantity');
  }
}
