/**
 * 每日花费限额规则（纯函数）：projected = 已结算 + 在途 + 本次 > 限额 → 拒绝。
 * 用户级与 Key 级同一口径（scope 只影响错误回执）；查询编排在使用方（billing authorize）。
 * 在途口径须排除自身请求（幂等重放不得把本请求算两遍）——由调用方保证。
 */
import { Decimal } from '../money.js';
import { BillingErrors } from '../errors.js';

export interface DailyLimitCheck {
  scope: 'user' | 'key';
  userId: number;
  apiKeyId?: number | null;
  limit: string;
  spent: string;
  exposure: string;
  amount: string;
}

export function assertDailySpendLimit(check: DailyLimitCheck): void {
  const projected = new Decimal(check.spent).plus(check.exposure).plus(check.amount);
  if (projected.gt(check.limit)) {
    throw BillingErrors.business('daily_spend_limit', {
      scope: check.scope,
      userId: check.userId,
      apiKeyId: check.scope === 'key' ? (check.apiKeyId ?? null) : null,
      limit: check.limit,
      projected: projected.toString(),
    });
  }
}
