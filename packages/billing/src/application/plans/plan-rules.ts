/**
 * 套餐目录域规则（纯函数）：kind×周期一致性——包月必带 1..3650、加油包禁周期恒 0
 * （「买到立即到期」防线，v1 plans.service 同语义）。
 */
import { BillingErrors } from '../../domain/errors.js';

export function assertKindPeriodConsistency(
  kind: string,
  periodDays: number | null | undefined,
): number {
  if (kind === 'pack') {
    if (periodDays != null && periodDays !== 0) {
      throw BillingErrors.business('invalid_period_days', { kind, periodDays: String(periodDays) });
    }
    return 0;
  }
  if (periodDays == null || periodDays < 1 || periodDays > 3650) {
    throw BillingErrors.business('invalid_period_days', { kind, periodDays: String(periodDays) });
  }
  return periodDays;
}
